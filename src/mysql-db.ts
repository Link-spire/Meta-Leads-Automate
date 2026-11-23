import mysql, { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { MysqlConfig } from "./config";
import { Settings } from "./config";
import { LOOKBACK_CURSOR, SyncTotals, StoredCursor } from "./db";
import { broadcastLead, formatDate, LeadRecord, parseDate } from "./normalize";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sync_cursors (
  form_id VARCHAR(64) NOT NULL,
  form_name TEXT,
  watermark DATETIME NULL,
  last_fetched INT NOT NULL,
  last_saved INT NOT NULL,
  last_error TEXT,
  updated_at DATETIME NULL,
  PRIMARY KEY (form_id)
);
CREATE TABLE IF NOT EXISTS sync_runs (
  id INT NOT NULL AUTO_INCREMENT,
  started_at DATETIME NOT NULL,
  finished_at DATETIME NULL,
  status VARCHAR(32) NOT NULL,
  forms_checked INT NOT NULL,
  leads_fetched INT NOT NULL,
  leads_saved INT NOT NULL,
  error TEXT,
  PRIMARY KEY (id)
);
`;

type SqlRow = RowDataPacket & Record<string, unknown>;

export class MysqlLeadDatabase {
  private connection: PoolConnection | null = null;

  constructor(private readonly pool: Pool) {}

  static async open(config: MysqlConfig): Promise<MysqlLeadDatabase> {
    const pool = mysql.createPool({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      database: config.database,
      connectionLimit: 4,
      connectTimeout: 15000,
      dateStrings: true,
    });
    const database = new MysqlLeadDatabase(pool);
    for (const statement of SCHEMA.split(";").map((part) => part.trim()).filter(Boolean)) {
      await pool.query(statement);
    }
    await database.requireUniqueLeadId();
    return database;
  }

  // The upsert only updates an existing lead when meta_lead_id has its own UNIQUE index.
  // Without it every run would insert the overlap window again as duplicate rows.
  private async requireUniqueLeadId(): Promise<void> {
    const [rows] = await this.query<SqlRow[]>("SHOW INDEX FROM leads WHERE Non_unique = 0");
    const columns = new Map<string, string[]>();
    for (const row of rows) {
      const key = String(row.Key_name);
      columns.set(key, [...(columns.get(key) ?? []), String(row.Column_name)]);
    }
    const unique = [...columns.values()].some((names) => names.length === 1 && names[0] === "meta_lead_id");
    if (unique) return;
    await this.pool.end();
    throw new Error(
      "The hosted leads table has no UNIQUE index on meta_lead_id, so syncing would duplicate leads. " +
        "Run: ALTER TABLE leads ADD UNIQUE KEY uq_meta_lead_id (meta_lead_id)",
    );
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async transaction(work: () => Promise<void> | void): Promise<void> {
    const connection = await this.pool.getConnection();
    this.connection = connection;
    try {
      await connection.beginTransaction();
      await work();
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      this.connection = null;
      connection.release();
    }
  }

  async upsertLead(row: LeadRecord): Promise<"inserted" | "updated"> {
    const stored = broadcastLead(row);
    const sql = `
      INSERT INTO leads (
        meta_lead_id, page_id, page_name, lead_date, ad_id, ad_name, adset_id, adset_name, campaign_id,
        full_name, phone_number, email, inbox_url, campaign_name, form_id, form_name, is_organic,
        platform, lead_status, interest, contact_time, answers
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        page_id = COALESCE(VALUES(page_id), leads.page_id),
        page_name = COALESCE(VALUES(page_name), leads.page_name),
        lead_date = VALUES(lead_date),
        ad_id = COALESCE(VALUES(ad_id), leads.ad_id),
        ad_name = COALESCE(VALUES(ad_name), leads.ad_name),
        adset_id = COALESCE(VALUES(adset_id), leads.adset_id),
        adset_name = COALESCE(VALUES(adset_name), leads.adset_name),
        campaign_id = COALESCE(VALUES(campaign_id), leads.campaign_id),
        full_name = COALESCE(VALUES(full_name), leads.full_name),
        phone_number = COALESCE(VALUES(phone_number), leads.phone_number),
        email = COALESCE(VALUES(email), leads.email),
        inbox_url = COALESCE(VALUES(inbox_url), leads.inbox_url),
        campaign_name = COALESCE(VALUES(campaign_name), leads.campaign_name),
        form_id = COALESCE(VALUES(form_id), leads.form_id),
        form_name = COALESCE(VALUES(form_name), leads.form_name),
        is_organic = COALESCE(VALUES(is_organic), leads.is_organic),
        platform = COALESCE(VALUES(platform), leads.platform),
        lead_status = COALESCE(VALUES(lead_status), leads.lead_status),
        interest = COALESCE(VALUES(interest), leads.interest),
        contact_time = COALESCE(VALUES(contact_time), leads.contact_time),
        answers = IF(VALUES(answers) = '{}', leads.answers, VALUES(answers))`;
    const [result] = await this.query<ResultSetHeader>(sql, [
      stored.meta_lead_id,
      stored.page_id,
      stored.page_name,
      stored.lead_date,
      stored.ad_id,
      stored.ad_name,
      stored.adset_id,
      stored.adset_name,
      stored.campaign_id,
      stored.full_name,
      stored.phone_number,
      stored.email,
      stored.inbox_url,
      stored.campaign_name,
      stored.form_id,
      stored.form_name,
      stored.is_organic,
      stored.platform,
      stored.lead_status,
      stored.interest,
      stored.contact_time,
      stored.answers,
    ]);
    return result.affectedRows === 1 ? "inserted" : "updated";
  }

  async countLeads(): Promise<number> {
    const [rows] = await this.query<SqlRow[]>("SELECT COUNT(*) AS count FROM leads");
    return Number(rows[0]?.count ?? 0);
  }

  async getCursor(formId: string): Promise<StoredCursor | null> {
    const [rows] = await this.query<SqlRow[]>("SELECT * FROM sync_cursors WHERE form_id = ? LIMIT 1", [formId]);
    const row = rows[0];
    if (!row) return null;
    return {
      formId: String(row.form_id),
      formName: row.form_name ? String(row.form_name) : null,
      watermark: row.watermark ? parseDate(String(row.watermark)) : null,
    };
  }

  /**
   * True after a lookback finishes cleanly. A single-day sync does not save a cursor,
   * so it cannot satisfy this, and a failed lookback stays false so the next run retries it.
   */
  async hasSuccessfulRun(): Promise<boolean> {
    const [rows] = await this.query<SqlRow[]>(
      `SELECT 1 AS ok
       FROM sync_runs
       WHERE status = 'ok'
         AND EXISTS (SELECT 1 FROM sync_cursors WHERE watermark IS NOT NULL)
       LIMIT 1`,
    );
    return rows.length > 0;
  }

  /** Start time of the most recent run that saved at least one form. */
  async latestWatermark(): Promise<Date | null> {
    const [rows] = await this.query<SqlRow[]>(
      "SELECT MAX(watermark) AS watermark FROM sync_cursors WHERE form_id != ?",
      [LOOKBACK_CURSOR],
    );
    const value = rows[0]?.watermark;
    return value ? parseDate(String(value)) : null;
  }

  /** True after SYNC_ON_START has finished one full lookback. A one-day sync does not set this. */
  async hasLookback(): Promise<boolean> {
    return (await this.getCursor(LOOKBACK_CURSOR))?.watermark != null;
  }

  async markLookback(when: Date = new Date()): Promise<void> {
    await this.saveCursor({
      formId: LOOKBACK_CURSOR,
      formName: "lookback",
      watermark: when,
      lastFetched: 0,
      lastSaved: 0,
      lastError: null,
    });
  }

  /** Records a failed form. A form seen for the first time keeps `resumeFrom` so the next run retries the same window. */
  async markCursorError(formId: string, formName: string, error: string, resumeFrom: Date | null = null): Promise<void> {
    await this.query(
      `INSERT INTO sync_cursors (form_id, form_name, watermark, last_fetched, last_saved, last_error, updated_at)
       VALUES (?, ?, ?, 0, 0, ?, ?)
       ON DUPLICATE KEY UPDATE form_name = VALUES(form_name), last_error = VALUES(last_error), updated_at = VALUES(updated_at)`,
      [formId, formName, resumeFrom ? formatDate(resumeFrom) : null, error.slice(0, 2000), formatDate(new Date())],
    );
  }

  async saveCursor(input: {
    formId: string;
    formName: string;
    watermark: Date;
    lastFetched: number;
    lastSaved: number;
    lastError: string | null;
  }): Promise<void> {
    await this.query(
      `INSERT INTO sync_cursors (form_id, form_name, watermark, last_fetched, last_saved, last_error, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         form_name = VALUES(form_name),
         watermark = VALUES(watermark),
         last_fetched = VALUES(last_fetched),
         last_saved = VALUES(last_saved),
         last_error = VALUES(last_error),
         updated_at = VALUES(updated_at)`,
      [
        input.formId,
        input.formName,
        formatDate(input.watermark),
        input.lastFetched,
        input.lastSaved,
        input.lastError,
        formatDate(new Date()),
      ],
    );
  }

  async startRun(): Promise<number> {
    const now = formatDate(new Date());
    await this.query(
      `UPDATE sync_runs SET status = 'interrupted', finished_at = ?, error = ? WHERE status = 'running'`,
      [now, "The sync process stopped before this run finished."],
    );
    const [result] = await this.query<ResultSetHeader>(
      `INSERT INTO sync_runs (started_at, status, forms_checked, leads_fetched, leads_saved) VALUES (?, 'running', 0, 0, 0)`,
      [now],
    );
    return result.insertId;
  }

  async finishRun(id: number, status: string, totals: SyncTotals, error: string | null): Promise<void> {
    await this.query(
      `UPDATE sync_runs
       SET status = ?, finished_at = ?, forms_checked = ?, leads_fetched = ?, leads_saved = ?, error = ?
       WHERE id = ?`,
      [status, formatDate(new Date()), totals.forms_checked, totals.leads_fetched, totals.leads_saved, error, id],
    );
  }

  async status(settings: Settings): Promise<Record<string, unknown>> {
    const [runs] = await this.query<SqlRow[]>("SELECT * FROM sync_runs ORDER BY id DESC LIMIT 5");
    const [cursors] = await this.query<SqlRow[]>("SELECT * FROM sync_cursors WHERE form_id != ? ORDER BY form_name", [
      LOOKBACK_CURSOR,
    ]);
    return {
      ok: true,
      database: "hostinger",
      lead_count: await this.countLeads(),
      credentials_ready: settings.credentialsReady,
      interval_minutes: settings.intervalMinutes,
      last_run: runs[0] ? runJson(runs[0]) : null,
      recent_runs: runs.map(runJson),
      forms: cursors.map(cursorJson),
    };
  }

  private query<T>(sql: string, values?: unknown[]) {
    const runner = this.connection ?? this.pool;
    return runner.query(sql, values) as Promise<[T, unknown]>;
  }
}

function runJson(run: SqlRow) {
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

function cursorJson(cursor: SqlRow) {
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
