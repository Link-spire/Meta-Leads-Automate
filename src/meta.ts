import { Settings } from "./config";

export const LEAD_FIELDS = [
  "created_time",
  "id",
  "ad_id",
  "ad_name",
  "adset_id",
  "adset_name",
  "campaign_id",
  "campaign_name",
  "form_id",
  "is_organic",
  "platform",
  "field_data",
  "custom_disclaimer_responses",
].join(",");

const USAGE_HEADERS = ["x-app-usage", "x-business-use-case-usage", "x-page-usage"];
const RETRY_STATUS = [429, 500, 502, 503, 504];
// Graph error codes Meta uses for throttling (4, 17, 32, 613, 80000-80014) and temporary blocks (341, 368).
const RATE_LIMIT_CODES = new Set([4, 17, 32, 341, 368, 613]);

function usageScores(headers: Array<string | null>): number[] {
  const scores: number[] = [];
  const collect = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) collect(item);
      return;
    }
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (key === "call_count" || key === "total_cputime" || key === "total_time") {
        const score = Number(item);
        if (!Number.isNaN(score)) scores.push(score);
      } else if (key === "estimated_time_to_regain_access") {
        // Meta only sets this above zero once it has already started throttling.
        if (Number(item) > 0) scores.push(100);
      } else {
        collect(item);
      }
    }
  };
  for (const header of headers) {
    if (!header) continue;
    try {
      collect(JSON.parse(header));
    } catch {
      continue;
    }
  }
  return scores;
}

function pageFields(since?: Date | null): string {
  if (since === undefined) return "name,leadgen_forms.limit(100){id,name,status}";
  const filter = since
    ? `.filtering(${JSON.stringify([
        {
          field: "time_created",
          operator: "GREATER_THAN_OR_EQUAL",
          value: Math.floor(since.getTime() / 1000),
        },
      ])})`
    : "";
  return `name,leadgen_forms.limit(100){id,name,status,leads.limit(50)${filter}{${LEAD_FIELDS}}}`;
}

export class MetaApiError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly subcode?: number,
    readonly status?: number,
  ) {
    super(message);
  }
}

/** True when Meta is throttling or blocking us, so the run must stop calling instead of trying the next form. */
export function isRateLimit(error: unknown): boolean {
  if (!(error instanceof MetaApiError)) return false;
  const code = error.code ?? 0;
  return (
    error.status === 429 ||
    code === 429 ||
    RATE_LIMIT_CODES.has(code) ||
    (code >= 80000 && code <= 80014) ||
    /api access blocked|request limit|rate limit|too many calls/i.test(error.message)
  );
}

function isTooMuchData(error: unknown): boolean {
  return error instanceof MetaApiError && /reduce the amount of data/i.test(error.message);
}

export interface MetaForm {
  id: string;
  name?: string;
  status?: string;
  page_id?: string;
  page_name?: string | null;
}

export class MetaClient {
  readonly base: string;
  backoffMs = [1000, 2000, 4000];
  maxPages = 200;
  timeoutMs = 60_000;
  paceMs = 0;
  usageExceeded = false;
  private lastRequestAt = 0;

  readonly pageIds: string[];
  private assignedPagesCache: Promise<Map<string, { name: string | null; accessToken: string }>> | null = null;

  constructor(
    private readonly settings: Pick<Settings, "accessToken" | "graphVersion" | "pageIds" | "formIds">,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.base = `https://graph.facebook.com/${settings.graphVersion}`;
    this.pageIds = settings.pageIds;
  }

  async getForm(formId: string): Promise<MetaForm> {
    return this.request(this.buildUrl(`/${formId}`, { fields: "id,name,status" })) as Promise<MetaForm>;
  }

  async pageAccess(pageId: string): Promise<{ id: string; name: string | null; matched: boolean }> {
    const pages = await this.assignedPages();
    const match = pages.get(pageId);
    return { id: pageId, name: match?.name ?? null, matched: Boolean(match?.accessToken) };
  }

  async visiblePages(): Promise<Array<{ id: string; name: string | null }>> {
    const pages = await this.assignedPages();
    return [...pages.entries()].map(([id, page]) => ({ id, name: page.name }));
  }

  async clientForPage(pageId: string): Promise<MetaClient> {
    const match = (await this.assignedPages()).get(pageId);
    const token = match?.accessToken || this.settings.accessToken;
    const client = new MetaClient(
      {
        accessToken: token,
        graphVersion: this.settings.graphVersion,
        pageIds: [pageId],
        formIds: [],
      },
      this.fetchImpl,
    );
    client.paceMs = this.paceMs;
    return client;
  }

  async getPage(pageId: string): Promise<Record<string, unknown>> {
    return this.request(this.buildUrl(`/${pageId}`, { fields: "id,name" }));
  }

  async readPage(
    pageId: string,
    since?: Date | null,
  ): Promise<{ name: string | null; forms: Array<MetaForm & { leads: Record<string, any>[]; leadsLoaded: boolean }> }> {
    const first = await this.request(this.buildUrl(`/${pageId}`, { fields: pageFields(since) }));
    const name = first.name ? String(first.name) : null;
    const forms: Array<MetaForm & { leads: Record<string, any>[]; leadsLoaded: boolean }> = [];
    for await (const form of this.paginate(first.leadgen_forms ?? {})) {
      const edge = form.leads as { data?: Record<string, any>[]; error?: { message?: string } } | undefined;
      // A missing edge or an error inside it is not an empty form. Caching that would skip its leads.
      const leadsLoaded = since !== undefined && Boolean(edge) && !edge?.error;
      const leads: Record<string, any>[] = [];
      if (leadsLoaded) {
        for await (const lead of this.paginate(edge ?? {})) leads.push(lead);
      }
      forms.push({
        id: String(form.id ?? ""),
        name: form.name ? String(form.name) : undefined,
        status: form.status ? String(form.status) : undefined,
        page_id: pageId,
        page_name: name,
        leads,
        leadsLoaded,
      });
    }
    return { name, forms };
  }

  async listForms(): Promise<MetaForm[]> {
    const forms: MetaForm[] = [];
    if (this.settings.formIds.length) {
      for (const formId of this.settings.formIds) {
        forms.push((await this.request(this.buildUrl(`/${formId}`, { fields: "id,name,status" }))) as MetaForm);
      }
    } else {
      for (const pageId of this.settings.pageIds) {
        const first = await this.request(
          this.buildUrl(`/${pageId}/leadgen_forms`, { fields: "id,name,status", limit: "100" }),
        );
        for await (const form of this.paginate(first)) forms.push(form as MetaForm);
      }
    }
    const unique: MetaForm[] = [];
    const seen = new Set<string>();
    for (const form of forms) {
      const id = String(form.id ?? "");
      if (!id || seen.has(id)) continue;
      seen.add(id);
      unique.push(form);
    }
    return unique;
  }

  async *iterLeads(formId: string, since: Date | null): AsyncGenerator<Record<string, any>> {
    const params: Record<string, string> = { fields: LEAD_FIELDS, limit: "100" };
    if (since) {
      params.filtering = JSON.stringify([
        {
          field: "time_created",
          operator: "GREATER_THAN_OR_EQUAL",
          value: Math.floor(since.getTime() / 1000),
        },
      ]);
    }
    const first = await this.request(this.buildUrl(`/${formId}/leads`, params));
    for await (const lead of this.paginate(first)) yield lead;
  }

  private buildUrl(path: string, params: Record<string, string>): string {
    const url = new URL(`${this.base}${path}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    url.searchParams.set("access_token", this.settings.accessToken);
    return url.toString();
  }

  private async *paginate(first: Record<string, any>): AsyncGenerator<Record<string, any>> {
    let payload = first;
    for (let page = 0; page < this.maxPages; page += 1) {
      for (const item of payload.data ?? []) yield item;
      const next = payload.paging?.next as string | undefined;
      if (!next) return;
      payload = await this.request(next);
    }
    throw new MetaApiError("Stopped after too many pages from Meta");
  }

  private async request(url: string): Promise<Record<string, any>> {
    await this.pace();
    const attempts = Math.max(1, this.backoffMs.length);
    let lastError = new MetaApiError("Meta API request failed after retries");
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (attempt > 0) await this.pause(attempt - 1);
      let response: Response;
      try {
        // Without a timeout a stalled connection would hang this run and block every later one.
        response = await this.fetchImpl(url, { signal: AbortSignal.timeout(this.timeoutMs) });
      } catch (error) {
        const reason = error instanceof Error && error.name === "TimeoutError" ? "timed out" : "could not be reached";
        lastError = new MetaApiError(`Meta ${reason}`);
        continue;
      }
      this.noteUsage(response);
      if (!RETRY_STATUS.includes(response.status)) return this.decode(response);
      try {
        await this.decode(response);
      } catch (error) {
        if (!(error instanceof MetaApiError)) throw error;
        lastError = error;
      }
      // Retrying a throttled or oversized request only adds calls that count against the limit.
      if (isRateLimit(lastError) || isTooMuchData(lastError)) throw lastError;
    }
    throw lastError;
  }

  private async decode(response: Response): Promise<Record<string, any>> {
    let payload: any;
    try {
      payload = await response.json();
    } catch {
      throw new MetaApiError(
        `Meta returned HTTP ${response.status} with a non-JSON body`,
        response.status,
        undefined,
        response.status,
      );
    }
    if (payload && typeof payload === "object" && "error" in payload) {
      const error = payload.error ?? {};
      throw new MetaApiError(
        String(error.message || "Meta API error"),
        error.code,
        error.error_subcode,
        response.status,
      );
    }
    if (response.status >= 400) {
      throw new MetaApiError(`Meta HTTP ${response.status}`, response.status, undefined, response.status);
    }
    if (!payload || typeof payload !== "object") throw new MetaApiError("Meta returned an unexpected payload");
    return payload;
  }

  private assignedPages(): Promise<Map<string, { name: string | null; accessToken: string }>> {
    if (!this.assignedPagesCache) this.assignedPagesCache = this.loadAssignedPages();
    return this.assignedPagesCache;
  }

  private async loadAssignedPages(): Promise<Map<string, { name: string | null; accessToken: string }>> {
    const pages = new Map<string, { name: string | null; accessToken: string }>();
    const first = await this.request(this.buildUrl("/me/accounts", { fields: "id,name,access_token", limit: "100" }));
    for await (const page of this.paginate(first)) {
      const id = String(page.id ?? "");
      if (!id) continue;
      pages.set(id, { name: page.name ? String(page.name) : null, accessToken: String(page.access_token ?? "") });
    }
    return pages;
  }

  private noteUsage(response: Response): void {
    const highest = Math.max(0, ...usageScores(USAGE_HEADERS.map((name) => response.headers.get(name))));
    if (highest >= 95) this.usageExceeded = true;
    else if (highest >= 80) this.paceMs = Math.max(this.paceMs, 5000);
  }

  private async pace(): Promise<void> {
    if (this.usageExceeded) {
      throw new MetaApiError("Meta rate limit is nearly full, so this run stopped before another call.");
    }
    if (this.paceMs <= 0) return;
    const wait = this.lastRequestAt + this.paceMs - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    this.lastRequestAt = Date.now();
  }

  private async pause(attempt: number): Promise<void> {
    const delay = this.backoffMs[Math.min(attempt, this.backoffMs.length - 1)] ?? 0;
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

export class MetaSource {
  paceMs = 0;
  readonly accountErrors: string[] = [];
  private readonly clients: MetaClient[];
  private readonly byForm = new Map<string, MetaClient>();
  private readonly leadsByForm = new Map<string, Record<string, any>[]>();
  // Start of the window the page requests already loaded; undefined when no leads were loaded with the forms.
  private loadedSince: Date | null | undefined;

  constructor(
    private readonly settings: Settings,
    fetchImpl: typeof fetch = fetch,
  ) {
    this.clients = settings.accounts
      .filter((account) => account.accessToken && (account.pageIds.length || settings.formIds.length))
      .map(
        (account) =>
          new MetaClient(
            {
              accessToken: account.accessToken,
              graphVersion: settings.graphVersion,
              pageIds: account.pageIds,
              formIds: [],
            },
            fetchImpl,
          ),
      );
  }

  async listForms(since?: Date | null): Promise<MetaForm[]> {
    const forms: MetaForm[] = [];
    this.leadsByForm.clear();
    this.loadedSince = since;
    for (const client of this.clients) {
      client.paceMs = this.paceMs;
      try {
        for (const pageId of client.pageIds) {
          const pageClient = await client.clientForPage(pageId);
          if (client.usageExceeded) {
            throw new MetaApiError("Meta rate limit is nearly full, so this run stopped before another call.");
          }
          pageClient.paceMs = this.paceMs;
          let withLeads = since !== undefined;
          let page;
          try {
            page = await pageClient.readPage(pageId, since);
          } catch (error) {
            // Too many leads for one response: list the forms alone and read each form's leads in pages instead.
            if (!withLeads || !isTooMuchData(error)) throw error;
            withLeads = false;
            page = await pageClient.readPage(pageId);
          }
          if (pageClient.paceMs > this.paceMs) this.paceMs = pageClient.paceMs;
          if (pageClient.usageExceeded) {
            throw new MetaApiError("Meta rate limit is nearly full, so this run stopped before another call.");
          }
          for (const form of page.forms) {
            if (withLeads && form.leadsLoaded) this.leadsByForm.set(String(form.id), form.leads);
            this.remember(
              { id: form.id, name: form.name, status: form.status, page_id: pageId, page_name: page.name },
              pageClient,
              forms,
            );
          }
        }
      } catch (error) {
        if (!(error instanceof MetaApiError)) throw error;
        this.accountErrors.push(error.message);
        console.warn(`Portfolio form list failed: ${error.message}`);
        if (isRateLimit(error)) throw error;
      }
    }
    if (this.settings.formIds.length) {
      const selected = forms.filter((form) => this.settings.formIds.includes(String(form.id)));
      const seen = new Set(selected.map((form) => String(form.id)));
      for (const formId of this.settings.formIds) {
        if (seen.has(formId)) continue;
        for (const client of this.clients) {
          try {
            this.remember(await client.getForm(formId), client, selected);
            seen.add(formId);
            break;
          } catch (error) {
            if (!(error instanceof MetaApiError)) throw error;
          }
        }
      }
      return selected;
    }
    if (!forms.length && this.accountErrors.length) throw new MetaApiError(this.accountErrors.join("; "));
    return forms;
  }

  async *iterLeads(formId: string, since: Date | null): AsyncGenerator<Record<string, any>> {
    // The loaded leads only answer this form if they reach back at least as far as it needs.
    const loaded =
      this.loadedSince === null || (this.loadedSince !== undefined && since !== null && since >= this.loadedSince);
    if (loaded && this.leadsByForm.has(formId)) {
      for (const lead of this.leadsByForm.get(formId) ?? []) {
        if (since && lead.created_time) {
          const created = new Date(String(lead.created_time));
          if (!Number.isNaN(created.getTime()) && created < since) continue;
        }
        yield lead;
      }
      return;
    }
    const client = this.byForm.get(formId) ?? this.clients[0];
    if (!client) return;
    yield* client.iterLeads(formId, since);
  }

  private remember(form: MetaForm, client: MetaClient, forms: MetaForm[]) {
    const id = String(form.id ?? "");
    if (!id || this.byForm.has(id)) return;
    this.byForm.set(id, client);
    forms.push(form);
  }
}
