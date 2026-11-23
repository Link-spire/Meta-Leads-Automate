import { config as loadDotenv } from "dotenv";
import { mkdirSync } from "fs";
import { isAbsolute, dirname, resolve } from "path";

export const ROOT = resolve(__dirname, "..");

export const MISSING_CREDENTIALS =
  "Set META_ACCESS_TOKEN and META_PAGE_ID in .env for the first portfolio, and META_ACCESS_TOKEN_2 and META_PAGE_ID_2 for the second. Use a system user token with the leads_retrieval permission.";

export interface MetaAccount {
  accessToken: string;
  pageIds: string[];
}

function clean(value: string | undefined): string {
  let text = (value ?? "").trim();
  if (text.length >= 2 && text[0] === text[text.length - 1] && (text[0] === "'" || text[0] === '"')) {
    text = text.slice(1, -1).trim();
  }
  return text;
}

function splitList(value: string | undefined): string[] {
  return clean(value)
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function intValue(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(clean(value), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boolValue(value: string | undefined, fallback: boolean): boolean {
  const text = clean(value).toLowerCase();
  if (!text) return fallback;
  return ["1", "true", "yes", "y", "on"].includes(text);
}

export interface MysqlConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

export function mysqlFromUrl(url: string): MysqlConfig | null {
  if (!url.startsWith("mysql://")) return null;
  const parsed = new URL(url);
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  const port = parsed.port ? Number.parseInt(parsed.port, 10) : 3306;
  if (!parsed.hostname || !parsed.username || !database || !Number.isFinite(port)) return null;
  return {
    host: parsed.hostname,
    port,
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database,
  };
}

export function databasePathFromUrl(url: string, root = ROOT): string {
  const prefix = "sqlite:///";
  const raw = url.startsWith(prefix) ? url.slice(prefix.length) : url;
  if (!raw || raw === ":memory:") return ":memory:";
  const databasePath = isAbsolute(raw) ? raw : resolve(root, raw);
  mkdirSync(dirname(databasePath), { recursive: true });
  return databasePath;
}

export class Settings {
  readonly accessToken: string;
  readonly pageIds: string[];
  readonly accounts: MetaAccount[];
  readonly formIds: string[];
  readonly campaignFilters: string[];
  readonly formFilters: string[];
  readonly graphVersion: string;
  readonly databasePath: string;
  readonly mysql: MysqlConfig | null;
  readonly intervalMinutes: number;
  readonly lookbackDays: number;
  readonly overlapMinutes: number;
  readonly host: string;
  readonly port: number;
  readonly syncOnStart: boolean;
  readonly apiKey: string;

  constructor(values: {
    accessToken: string;
    pageIds: string[];
    accounts?: MetaAccount[];
    formIds: string[];
    campaignFilters: string[];
    formFilters: string[];
    graphVersion: string;
    databasePath: string;
    mysql?: MysqlConfig | null;
    intervalMinutes: number;
    lookbackDays: number;
    overlapMinutes: number;
    host: string;
    port: number;
    syncOnStart: boolean;
    apiKey: string;
  }) {
    Object.assign(this, values);
    if (this.mysql === undefined) this.mysql = null;
    if (!this.accounts) {
      this.accounts =
        this.accessToken || this.pageIds.length ? [{ accessToken: this.accessToken, pageIds: this.pageIds }] : [];
    }
  }

  get credentialsReady(): boolean {
    return this.accounts.some((account) => account.accessToken && (account.pageIds.length || this.formIds.length));
  }
}

export function loadAccounts(): MetaAccount[] {
  const pairs = [
    [process.env.META_ACCESS_TOKEN, process.env.META_PAGE_ID],
    [process.env.META_ACCESS_TOKEN_2, process.env.META_PAGE_ID_2],
  ];
  const accounts: MetaAccount[] = [];
  for (const [token, pages] of pairs) {
    const accessToken = clean(token);
    const pageIds = splitList(pages);
    if (!accessToken && !pageIds.length) continue;
    accounts.push({ accessToken, pageIds });
  }
  return accounts;
}

export function loadSettings(): Settings {
  loadDotenv({ path: resolve(ROOT, ".env"), quiet: true });
  let version = clean(process.env.META_GRAPH_VERSION) || "v25.0";
  if (!version.startsWith("v")) version = `v${version}`;
  const databaseUrl = clean(process.env.DATABASE_URL) || "sqlite:///./data/leads.db";
  const mysql = mysqlFromUrl(databaseUrl);
  const accounts = loadAccounts();
  return new Settings({
    accessToken: accounts[0]?.accessToken ?? "",
    pageIds: accounts.flatMap((account) => account.pageIds),
    accounts,
    formIds: splitList(process.env.META_FORM_IDS),
    campaignFilters: splitList(process.env.META_CAMPAIGN_FILTER),
    formFilters: splitList(process.env.META_FORM_FILTER),
    graphVersion: version,
    databasePath: mysql ? ":memory:" : databasePathFromUrl(databaseUrl),
    mysql,
    intervalMinutes: Math.max(0, intValue(process.env.SYNC_INTERVAL_MINUTES, 60)),
    lookbackDays: Math.max(0, intValue(process.env.SYNC_LOOKBACK_DAYS, 90)),
    overlapMinutes: Math.max(0, intValue(process.env.SYNC_OVERLAP_MINUTES, 120)),
    host: clean(process.env.HOST) || "127.0.0.1",
    port: intValue(process.env.PORT, 8080),
    syncOnStart: boolValue(process.env.SYNC_ON_START, true),
    apiKey: clean(process.env.SYNC_API_KEY),
  });
}
