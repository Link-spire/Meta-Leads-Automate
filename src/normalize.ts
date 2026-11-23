export interface LeadRecord {
  id: string;
  createdTime: Date;
  createdTimeRaw: string;
  adId: string | null;
  adName: string | null;
  adsetId: string | null;
  adsetName: string | null;
  campaignId: string | null;
  campaignName: string | null;
  formId: string | null;
  formName: string | null;
  isOrganic: boolean | null;
  platform: string | null;
  fullName: string | null;
  phoneNumber: string | null;
  email: string | null;
  inboxUrl: string | null;
  leadStatus: string | null;
  answers: Record<string, string>;
  source: "api" | "csv";
  pageId?: string | null;
  pageName?: string | null;
}

const CONTACT_TIME_KEYS = ["best_time_to_contact_you?", "what_is_your_preferred_time_of_contact?"];

const INTEREST_KEYS = [
  "which_service_are_you_interested_in?",
  "what_type_of_denture_are_you_interested_in?",
  "who_are_you_interested_in_getting_braces_for?",
];

export function firstAnswer(answers: Record<string, string>, keys: string[]): string | null {
  for (const key of keys) {
    const value = clean(answers[key]);
    if (value) return value;
  }
  return null;
}

export function mappedContactTime(answers: Record<string, string>): string | null {
  return firstAnswer(answers, CONTACT_TIME_KEYS);
}

export function mappedInterest(answers: Record<string, string>): string | null {
  return firstAnswer(answers, INTEREST_KEYS);
}

// Cuts a value to the hosted column's length. MySQL rejects longer values, and one rejected
// lead would fail its form on every run. The untouched text stays in the answers column.
function fit(value: string | null | undefined, max: number): string | null {
  if (value === null || value === undefined) return null;
  return value.length > max ? value.slice(0, max) : value;
}

export function broadcastLead(row: LeadRecord): Record<string, string | number | null> {
  return {
    meta_lead_id: row.id,
    page_id: fit(row.pageId, 64),
    page_name: fit(row.pageName, 255),
    lead_date: formatDate(row.createdTime),
    ad_id: fit(row.adId, 64),
    ad_name: fit(row.adName, 255),
    adset_id: fit(row.adsetId, 64),
    adset_name: fit(row.adsetName, 255),
    campaign_id: fit(row.campaignId, 64),
    full_name: fit(row.fullName, 255),
    phone_number: fit(row.phoneNumber, 50),
    email: fit(row.email, 255),
    inbox_url: fit(row.inboxUrl, 512),
    campaign_name: fit(row.campaignName || row.pageName || null, 255),
    form_id: fit(row.formId, 64),
    form_name: fit(row.formName, 255),
    is_organic: row.isOrganic === null ? null : row.isOrganic ? 1 : 0,
    platform: fit(row.platform, 50),
    lead_status: fit(row.leadStatus, 32),
    interest: fit(mappedInterest(row.answers), 255),
    contact_time: fit(mappedContactTime(row.answers), 255),
    answers: JSON.stringify(row.answers ?? {}),
  };
}

const META_COLUMNS = new Set([
  "id",
  "created_time",
  "ad_id",
  "ad_name",
  "adset_id",
  "adset_name",
  "campaign_id",
  "campaign_name",
  "form_id",
  "form_name",
  "is_organic",
  "platform",
  "full_name",
  "phone_number",
  "email",
  "inbox_url",
  "lead_status",
]);

const CONTACT_FIELDS: Array<[string, "phoneNumber" | "email"]> = [
  ["phone_number", "phoneNumber"],
  ["phone", "phoneNumber"],
  ["work_phone_number", "phoneNumber"],
  ["what is your phone number?", "phoneNumber"],
  ["email", "email"],
  ["work_email", "email"],
];

export function clean(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text : null;
}

export function parseDate(value: string): Date {
  const raw = value.trim();
  if (!raw) throw new Error("created_time is empty");
  const iso = raw.includes("T") ? raw : raw.replace(" ", "T");
  const zoned = /(?:Z|[+-]\d{2}:?\d{2})$/.test(iso) ? iso : `${iso}Z`;
  const parsed = new Date(zoned);
  if (Number.isNaN(parsed.getTime())) throw new Error(`Invalid created_time: ${value}`);
  return parsed;
}

export function formatDate(value: Date): string {
  return value.toISOString().replace("T", " ").replace("Z", "");
}

export function parseBool(value: unknown): boolean | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "boolean") return value;
  const text = String(value).trim().toLowerCase();
  if (["true", "1", "yes"].includes(text)) return true;
  if (["false", "0", "no"].includes(text)) return false;
  return null;
}

export function answerText(values: unknown): string | null {
  if (Array.isArray(values)) {
    const parts = values.map((item) => String(item).trim()).filter(Boolean);
    if (!parts.length) return null;
    return parts.length === 1 ? parts[0] : parts.join(" | ");
  }
  return clean(values);
}

export function answersFromFieldData(fieldData: Array<{ name?: string; values?: unknown }> | undefined): Record<string, string> {
  const answers: Record<string, string> = {};
  for (const item of fieldData ?? []) {
    const name = clean(item.name);
    const text = answerText(item.values);
    if (name && text !== null) answers[name] = text;
  }
  return answers;
}

export function fullNameFromAnswers(answers: Record<string, string>): string | null {
  if (answers.full_name) return answers.full_name;
  const joined = [clean(answers.first_name), clean(answers.last_name)].filter(Boolean).join(" ");
  return joined || null;
}

export function matchesFilter(value: string | null | undefined, filters: string[]): boolean {
  if (!filters.length) return true;
  const haystack = (value ?? "").toLowerCase();
  return filters.some((item) => haystack.includes(item.toLowerCase()));
}

export function sinceTime(watermark: Date | null, now: Date, lookbackDays: number, overlapMinutes: number): Date | null {
  if (watermark) return new Date(watermark.getTime() - overlapMinutes * 60_000);
  if (lookbackDays <= 0) return null;
  return new Date(now.getTime() - lookbackDays * 24 * 60 * 60_000);
}

export function startOfLocalDay(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

export function utcDayWindow(day: string): { start: Date; end: Date } | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const start = new Date(`${day}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime()) || start.toISOString().slice(0, 10) !== day) return null;
  return { start, end: new Date(start.getTime() + 24 * 60 * 60 * 1000) };
}

/** The UTC calendar date before `now`. 00:05 UTC on 24 Nov returns 2026-11-23. */
export function utcDayBefore(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1)).toISOString().slice(0, 10);
}

/** The whole previous UTC day. Midnight on 24 Nov covers 23 Nov, from 00:00:00 up to but not including the next midnight. */
export function previousUtcDayWindow(now: Date): { day: string; start: Date; end: Date } {
  const day = utcDayBefore(now);
  const window = utcDayWindow(day);
  if (!window) throw new Error(`Invalid previous UTC day: ${day}`);
  return { day, start: window.start, end: window.end };
}

/** Leads from `days` ago up to `now`. SYNC_LOOKBACK_DAYS=90 starts 90 days before the run. */
export function lookbackWindow(now: Date, days: number): { start: Date; end: Date } {
  return { start: sinceTime(null, now, days, 0) ?? new Date(0), end: now };
}

/**
 * SYNC_ON_START=true reads SYNC_LOOKBACK_DAYS on the first run, then one UTC day after that.
 * SYNC_ON_START=false never reads the lookback. It reads the previous UTC day.
 */
export function autoSyncWindow(
  now: Date,
  syncOnStart: boolean,
  lookbackDone: boolean,
  lookbackDays: number,
): { start: Date; end: Date } {
  if (syncOnStart && !lookbackDone) return lookbackWindow(now, lookbackDays);
  return previousUtcDayWindow(now);
}

export function leadFromApi(payload: Record<string, any>, formName?: string | null): LeadRecord {
  const createdRaw = String(payload.created_time ?? "");
  const answers = answersFromFieldData(payload.field_data);
  if (payload.custom_disclaimer_responses) {
    answers.custom_disclaimer_responses = JSON.stringify(payload.custom_disclaimer_responses);
  }
  const row: LeadRecord = {
    id: String(payload.id ?? "").trim(),
    createdTime: parseDate(createdRaw),
    createdTimeRaw: createdRaw.trim(),
    adId: clean(payload.ad_id),
    adName: clean(payload.ad_name),
    adsetId: clean(payload.adset_id),
    adsetName: clean(payload.adset_name),
    campaignId: clean(payload.campaign_id),
    campaignName: clean(payload.campaign_name),
    formId: clean(payload.form_id),
    formName: clean(formName) ?? clean(payload.form_name),
    isOrganic: parseBool(payload.is_organic),
    platform: clean(payload.platform),
    fullName: fullNameFromAnswers(answers),
    phoneNumber: null,
    email: null,
    inboxUrl: clean(answers.inbox_url),
    leadStatus: "complete",
    answers,
    source: "api",
  };
  for (const [source, target] of CONTACT_FIELDS) {
    if (row[target]) continue;
    if (answers[source]) row[target] = answers[source];
  }
  if (!row.id) throw new Error("lead id is empty");
  return row;
}

export function leadFromCsv(record: Record<string, string>): LeadRecord {
  const createdRaw = String(record.created_time ?? "");
  const answers: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    if (META_COLUMNS.has(key)) continue;
    const text = clean(value);
    if (text !== null) answers[key] = text;
  }
  for (const key of ["full_name", "phone_number", "email"]) {
    const text = clean(record[key]);
    if (text !== null) answers[key] = text;
  }
  const id = clean(record.id);
  if (!id) throw new Error("lead id is empty");
  const row: LeadRecord = {
    id,
    createdTime: parseDate(createdRaw),
    createdTimeRaw: createdRaw.trim(),
    adId: clean(record.ad_id),
    adName: clean(record.ad_name),
    adsetId: clean(record.adset_id),
    adsetName: clean(record.adset_name),
    campaignId: clean(record.campaign_id),
    campaignName: clean(record.campaign_name),
    formId: clean(record.form_id),
    formName: clean(record.form_name),
    isOrganic: parseBool(record.is_organic),
    platform: clean(record.platform),
    fullName: clean(record.full_name),
    phoneNumber: clean(record.phone_number),
    email: clean(record.email),
    inboxUrl: clean(record.inbox_url),
    leadStatus: clean(record.lead_status),
    answers,
    source: "csv",
  };
  for (const [source, target] of CONTACT_FIELDS) {
    if (row[target]) continue;
    if (answers[source]) row[target] = answers[source];
  }
  return row;
}
