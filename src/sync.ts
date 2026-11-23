import { MISSING_CREDENTIALS, Settings } from "./config";
import { LOOKBACK_CURSOR, LeadDatabase, SyncTotals } from "./db";
import { isRateLimit, MetaForm, MetaSource } from "./meta";
import { MysqlLeadDatabase } from "./mysql-db";
import { leadFromApi, LeadRecord, matchesFilter, sinceTime, startOfLocalDay } from "./normalize";

export interface SyncWindow {
  start: Date;
  end: Date;
}

type SyncDatabase = LeadDatabase | MysqlLeadDatabase;

export interface LeadSource {
  listForms(since?: Date | null): Promise<MetaForm[]>;
  iterLeads(formId: string, since: Date | null): AsyncIterable<Record<string, any>>;
}

export interface SyncResult extends SyncTotals {
  status: "ok" | "error" | "busy";
  error: string | null;
}

let running = false;

export async function runSyncLocked(
  settings: Settings,
  database: SyncDatabase,
  client: LeadSource,
  window?: SyncWindow,
): Promise<SyncResult> {
  if (running) return { status: "busy", error: "A sync is already running.", forms_checked: 0, leads_fetched: 0, leads_saved: 0 };
  running = true;
  try {
    return await runSync(settings, database, client, window);
  } finally {
    running = false;
  }
}

/**
 * Without a window, each form continues from the start of its last successful run (minus the overlap),
 * so leads that arrive between two runs are never skipped. Re-read leads update their existing row.
 */
export async function runSync(
  settings: Settings,
  database: SyncDatabase,
  client: LeadSource,
  window?: SyncWindow,
  startedAt: Date = new Date(),
): Promise<SyncResult> {
  if (!settings.credentialsReady) {
    return { status: "error", error: MISSING_CREDENTIALS, forms_checked: 0, leads_fetched: 0, leads_saved: 0 };
  }
  const runId = await database.startRun();
  const totals: SyncTotals = { forms_checked: 0, leads_fetched: 0, leads_saved: 0 };
  const errors: string[] = [];
  try {
    // Every form saved by the last run carries that run's start time, so one window covers them all.
    const lastRun = window ? null : await database.latestWatermark();
    const resume = lastRun ? sinceTime(lastRun, startedAt, 0, settings.overlapMinutes) : null;
    // SYNC_ON_START=true reads SYNC_LOOKBACK_DAYS once. After that marker exists, a later run
    // continues from it instead of reading 90 days again. false never reads that history.
    const lookbackDone = await database.hasLookback();
    const fullLookback = !window && settings.syncOnStart && !lookbackDone;
    const lookbackMark = !window && lookbackDone ? await database.getCursor(LOOKBACK_CURSOR) : null;
    const firstSince = fullLookback
      ? sinceTime(null, startedAt, settings.lookbackDays, 0)
      : (resume ??
        (lookbackMark?.watermark
          ? sinceTime(lookbackMark.watermark, startedAt, 0, settings.overlapMinutes)
          : startOfLocalDay(startedAt)));
    // Leads from this point are loaded with the forms, one request per Page. A first backfill would put
    // months of leads into that one response, so it lists only the forms and each form is read in pages.
    const loadSince = window ? window.start : fullLookback ? undefined : (resume ?? (settings.syncOnStart ? undefined : firstSince));
    const forms = await client.listForms(loadSince);
    if (client instanceof MetaSource) {
      for (const message of client.accountErrors) errors.push(message);
    }
    for (const form of forms) {
      const formId = String(form.id ?? "");
      const formName = String(form.name ?? "");
      if (!matchesFilter(formName, settings.formFilters)) continue;
      totals.forms_checked += 1;
      let since = window ? window.start : firstSince;
      if (!window && !fullLookback) {
        const saved = (await database.getCursor(formId))?.watermark;
        if (saved) since = sinceTime(saved, startedAt, 0, settings.overlapMinutes);
      }
      try {
        const counts = await syncForm(database, client, settings, form, since, startedAt, window);
        totals.leads_fetched += counts.fetched;
        totals.leads_saved += counts.saved;
        console.log(`Form ${formId} ${formName}: fetched ${counts.fetched}, saved ${counts.saved} (${counts.added} new)`);
      } catch (error) {
        const message = `${formId}: ${error instanceof Error ? error.message : String(error)}`;
        errors.push(message);
        console.warn(`Form sync failed: ${message}`);
        // The form keeps its old position, so the next run reads this window again.
        await database.markCursorError(formId, formName, message, window ? null : since);
        if (isRateLimit(error)) break;
      }
    }
    if (fullLookback && !errors.length) await database.markLookback(startedAt);
    const status = errors.length ? "error" : "ok";
    const errorText = errors.join("; ").slice(0, 2000) || null;
    await database.finishRun(runId, status, totals, errorText);
    return { status, error: errorText, ...totals };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Meta sync failed: ${message}`);
    await database.finishRun(runId, "error", totals, message.slice(0, 2000));
    return { status: "error", error: message, ...totals };
  }
}

async function syncForm(
  database: SyncDatabase,
  client: LeadSource,
  settings: Settings,
  form: MetaForm,
  since: Date | null,
  startedAt: Date,
  window?: SyncWindow,
): Promise<{ fetched: number; saved: number; added: number }> {
  const formId = String(form.id ?? "");
  const formName = String(form.name ?? "");
  const rows: LeadRecord[] = [];
  let fetched = 0;
  for await (const raw of client.iterLeads(formId, since)) {
    if (!window) fetched += 1;
    let lead: LeadRecord;
    try {
      lead = leadFromApi(raw, formName);
    } catch (error) {
      console.warn(`Skipped lead ${raw?.id} on form ${formId}: ${error instanceof Error ? error.message : error}`);
      continue;
    }
    if (window) {
      if (lead.createdTime < window.start || lead.createdTime >= window.end) continue;
      fetched += 1;
    }
    if (!matchesFilter(lead.campaignName, settings.campaignFilters)) continue;
    lead.pageId = form.page_id ?? null;
    lead.pageName = form.page_name ?? null;
    rows.push(lead);
  }

  let added = 0;
  if (window && !rows.length) return { fetched, saved: 0, added };
  // The leads and the form's new position are saved together, so a failure can never move the position alone.
  await database.transaction(async () => {
    for (const row of rows) {
      if ((await database.upsertLead(row)) === "inserted") added += 1;
    }
    if (!window) {
      await database.saveCursor({
        formId,
        formName,
        watermark: startedAt,
        lastFetched: fetched,
        lastSaved: rows.length,
        lastError: null,
      });
    }
  });
  return { fetched, saved: rows.length, added };
}

export function realClient(settings: Settings): MetaSource {
  const source = new MetaSource(settings);
  source.paceMs = 500;
  return source;
}
