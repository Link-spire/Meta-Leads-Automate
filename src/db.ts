import { DatabaseSync } from "node:sqlite";
import { Settings } from "./config";
import { formatDate, LeadRecord, parseDate } from "./normalize";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS leads (
  id VARCHAR(64) NOT NULL,
  created_time DATETIME NOT NULL,
  created_time_raw TEXT,
  ad_id VARCHAR(64),
  ad_name TEXT,
  adset_id VARCHAR(64),
  adset_name TEXT,
  campaign_id VARCHAR(64),
  campaign_name TEXT,
  form_id VARCHAR(64),
  form_name TEXT,
  is_organic BOOLEAN,
  platform VARCHAR(32),
  full_name TEXT,
  phone_number VARCHAR(64),
  email VARCHAR(320),
  inbox_url TEXT,
  lead_status VARCHAR(64),
  answers JSON NOT NULL,
  source VARCHAR(16) NOT NULL,
  first_seen_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  PRIMARY KEY (id)
);
CREATE TABLE IF NOT EXISTS sync_cursors (
  form_id VARCHAR(64) NOT NULL,
  form_name TEXT,
  watermark DATETIME,
  last_fetched INTEGER NOT NULL,
  last_saved INTEGER NOT NULL,
  last_error TEXT,
  updated_at DATETIME,
  PRIMARY KEY (form_id)
);
CREATE TABLE IF NOT EXISTS sync_runs (
  id INTEGER NOT NULL,
  started_at DATETIME NOT NULL,
  finished_at DATETIME,
  status VARCHAR(32) NOT NULL,
  forms_checked INTEGER NOT NULL,
  leads_fetched INTEGER NOT NULL,
  leads_saved INTEGER NOT NULL,
  error TEXT,
  PRIMARY KEY (id)
);
CREATE TABLE IF NOT EXISTS lead_answers (
  id INTEGER NOT NULL,
  lead_id VARCHAR(64) NOT NULL,
  question VARCHAR(512) NOT NULL,
  answer TEXT NOT NULL,
  PRIMARY KEY (id),
  CONSTRAINT uq_lead_question UNIQUE (lead_id, question),
  FOREIGN KEY(lead_id) REFERENCES leads (id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS ix_leads_created_time ON leads (created_time);
CREATE INDEX IF NOT EXISTS ix_leads_email ON leads (email);
CREATE INDEX IF NOT EXISTS ix_lead_answers_lead_id ON lead_answers (lead_id);
`;

/** Marks a finished 90-day read so a later daily run does not read those days again. */
export const LOOKBACK_CURSOR = "__lookback__";

export interface SyncTotals {
  forms_checked: number;
  leads_fetched: number;
  leads_saved: number;
}

export interface StoredCursor {
  formId: string;
  formName: string | null;
  watermark: Date | null;
}

type LeadRow = Record<string, any>;

export class LeadDatabase {
  constructor(private readonly db: DatabaseSync) {}

  static open(path: string): LeadDatabase {
    const db = new DatabaseSync(path);
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(SCHEMA);
    return new LeadDatabase(db);
  }

  close(): void {
    this.db.close();
  }

  transaction(work: () => void | Promise<void>): void | Promise<void> {
    this.db.exec("BEGIN");
    try {
      const result = work();
      if (result && typeof (result as Promise<void>).then === "function") {
        return (result as Promise<void>).then(
          () => {
            this.db.exec("COMMIT");
          },
          (error) => {
            this.db.exec("ROLLBACK");
            throw error;
          },
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  upsertLead(row: LeadRecord): "inserted" | "updated" {
    const now = formatDate(new Date());
    const current = this.db.prepare("SELECT * FROM leads WHERE id = ?").get(row.id) as LeadRow | undefined;
    const answers = JSON.stringify(row.answers ?? {});
    const values: LeadRow = {
      id: row.id,
      created_time: formatDate(row.createdTime),
      created_time_raw: row.createdTimeRaw,
      ad_id: row.adId,
      ad_name: row.adName,
      adset_id: row.adsetId,
      adset_name: row.adsetName,
      campaign_id: row.campaignId,
      campaign_name: row.campaignName || row.pageName || null,
      form_id: row.formId,
      form_name: row.formName,
      is_organic: row.isOrganic === null ? null : row.isOrganic ? 1 : 0,
      platform: row.platform,
      full_name: row.fullName,
      phone_number: row.phoneNumber,
      email: row.email,
      inbox_url: row.inboxUrl,
      lead_status: row.leadStatus,
      answers,
      source: row.source,
      first_seen_at: current?.first_seen_at ?? now,
      updated_at: now,
    };
    if (current) {
      for (const key of Object.keys(values)) {
        if (key === "id" || key === "first_seen_at" || key === "updated_at") continue;
        if (values[key] === null || values[key] === undefined) values[key] = current[key];
        if (key === "answers" && answers === "{}") values[key] = current.answers;
      }
    }

    const columns = Object.keys(values);
    if (!current) {
      this.db
        .prepare(`INSERT INTO leads (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`)
        .run(...columns.map((column) => values[column]));
    } else {
      const updates = columns.filter((column) => column !== "id");
      this.db
        .prepare(`UPDATE leads SET ${updates.map((column) => `${column} = ?`).join(", ")} WHERE id = ?`)
        .run(...updates.map((column) => values[column]), row.id);
    }

    if (Object.keys(row.answers ?? {}).length) {
      this.db.prepare("DELETE FROM lead_answers WHERE lead_id = ?").run(row.id);
      const insert = this.db.prepare("INSERT INTO lead_answers (lead_id, question, answer) VALUES (?, ?, ?)");
      for (const [question, answer] of Object.entries(row.answers)) {
        insert.run(row.id, question.slice(0, 512), String(answer));
      }
    }
    return current ? "updated" : "inserted";
  }

  countLeads(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM leads").get() as { count: number };
    return row.count;
  }

  countAnswers(question: string): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM lead_answers WHERE question = ?").get(question) as {
      count: number;
    };
    return row.count;
  }

  platforms(): string[] {
    return (this.db.prepare("SELECT DISTINCT platform FROM leads").all() as Array<{ platform: string }>).map(
      (row) => row.platform,
    );
  }

  getLead(id: string): LeadRow | undefined {
    return this.db.prepare("SELECT * FROM leads WHERE id = ?").get(id) as LeadRow | undefined;
  }

  getCursor(formId: string): StoredCursor | null {
    const row = this.db.prepare("SELECT * FROM sync_cursors WHERE form_id = ?").get(formId) as LeadRow | undefined;
    if (!row) return null;
    return {
      formId: row.form_id,
      formName: row.form_name,
      watermark: row.watermark ? parseDate(String(row.watermark)) : null,
    };
  }

  /**
   * True after a lookback finishes cleanly. A single-day sync does not save a cursor,
   * so it cannot satisfy this, and a failed lookback stays false so the next run retries it.
   */
  hasSuccessfulRun(): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 AS ok
         FROM sync_runs
         WHERE status = 'ok'
           AND EXISTS (SELECT 1 FROM sync_cursors WHERE watermark IS NOT NULL)
         LIMIT 1`,
      )
      .get();
    return Boolean(row);
  }

  /** Start time of the most recent run that saved at least one form. */
  latestWatermark(): Date | null {
    const row = this.db
      .prepare("SELECT MAX(watermark) AS watermark FROM sync_cursors WHERE form_id != ?")
      .get(LOOKBACK_CURSOR) as { watermark: string | null } | undefined;
    return row?.watermark ? parseDate(String(row.watermark)) : null;
  }

  /** True after SYNC_ON_START has finished one full lookback. A one-day sync does not set this. */
  hasLookback(): boolean {
    return this.getCursor(LOOKBACK_CURSOR)?.watermark != null;
  }

  markLookback(when: Date = new Date()): void {
    this.saveCursor({
      formId: LOOKBACK_CURSOR,
      formName: "lookback",
      watermark: when,
      lastFetched: 0,
      lastSaved: 0,
      lastError: null,
    });
  }

  /** Records a failed form. A form seen for the first time keeps `resumeFrom` so the next run retries the same window. */
  markCursorError(formId: string, formName: string, error: string, resumeFrom: Date | null = null): void {
    const now = formatDate(new Date());
    const existing = this.db.prepare("SELECT form_id FROM sync_cursors WHERE form_id = ?").get(formId);
    if (!existing) {
      this.db
        .prepare(
          `INSERT INTO sync_cursors (form_id, form_name, watermark, last_fetched, last_saved, last_error, updated_at)
           VALUES (?, ?, ?, 0, 0, ?, ?)`,
        )
        .run(formId, formName, resumeFrom ? formatDate(resumeFrom) : null, error.slice(0, 2000), now);
      return;
    }
    this.db
      .prepare("UPDATE sync_cursors SET form_name = ?, last_error = ?, updated_at = ? WHERE form_id = ?")
      .run(formName, error.slice(0, 2000), now, formId);
  }

  saveCursor(input: {
    formId: string;
    formName: string;
    watermark: Date;
    lastFetched: number;
    lastSaved: number;
    lastError: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO sync_cursors (form_id, form_name, watermark, last_fetched, last_saved, last_error, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(form_id) DO UPDATE SET
           form_name = excluded.form_name,
           watermark = excluded.watermark,
           last_fetched = excluded.last_fetched,
           last_saved = excluded.last_saved,
           last_error = excluded.last_error,
           updated_at = excluded.updated_at`,
      )
      .run(
        input.formId,
        input.formName,
        formatDate(input.watermark),
        input.lastFetched,
        input.lastSaved,
        input.lastError,
        formatDate(new Date()),
      );
  }

  startRun(): number {
    const now = formatDate(new Date());
    this.db
      .prepare(
        `UPDATE sync_runs
         SET status = 'interrupted', finished_at = ?, error = ?
         WHERE status = 'running'`,
      )
      .run(now, "The sync process stopped before this run finished.");
    const result = this.db
      .prepare(
        `INSERT INTO sync_runs (started_at, status, forms_checked, leads_fetched, leads_saved)
         VALUES (?, 'running', 0, 0, 0)`,
      )
      .run(now);
    return Number(result.lastInsertRowid);
  }

  finishRun(id: number, status: string, totals: SyncTotals, error: string | null): void {
    this.db
      .prepare(
        `UPDATE sync_runs
         SET status = ?, finished_at = ?, forms_checked = ?, leads_fetched = ?, leads_saved = ?, error = ?
         WHERE id = ?`,
      )
      .run(status, formatDate(new Date()), totals.forms_checked, totals.leads_fetched, totals.leads_saved, error, id);
  }

  status(settings: Settings): Record<string, unknown> {
    const runs = this.db.prepare("SELECT * FROM sync_runs ORDER BY id DESC LIMIT 5").all() as LeadRow[];
    const cursors = this.db
      .prepare("SELECT * FROM sync_cursors WHERE form_id != ? ORDER BY form_name")
      .all(LOOKBACK_CURSOR) as LeadRow[];
    return {
      ok: true,
      lead_count: this.countLeads(),
      credentials_ready: settings.credentialsReady,
      interval_minutes: settings.intervalMinutes,
      last_run: runs[0] ? runJson(runs[0]) : null,
      recent_runs: runs.map(runJson),
      forms: cursors.map(cursorJson),
    };
  }
}

function runJson(run: LeadRow) {
  return {
    id: run.id,
    status: run.status,
    started_at: iso(run.started_at),
    finished_at: iso(run.finished_at),
    forms_checked: run.forms_checked,
    leads_fetched: run.leads_fetched,
    leads_saved: run.leads_saved,
    error: run.error,
  };
}

function cursorJson(cursor: LeadRow) {
  return {
    form_id: cursor.form_id,
    form_name: cursor.form_name,
    watermark: iso(cursor.watermark),
    last_fetched: cursor.last_fetched,
    last_saved: cursor.last_saved,
    last_error: cursor.last_error,
  };
}

function iso(value: unknown): string | null {
  if (!value) return null;
  return parseDate(String(value)).toISOString();
}
