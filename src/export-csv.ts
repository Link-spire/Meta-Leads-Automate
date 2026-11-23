import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { LeadRecord } from "./normalize";

const BEFORE = [
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
];

const AFTER = ["full_name", "phone_number", "email", "inbox_url", "lead_status"];

const CONTACT_KEYS = new Set([
  "full_name",
  "first_name",
  "last_name",
  "phone_number",
  "phone",
  "work_phone_number",
  "email",
  "work_email",
]);

export function writeLeadCsv(directory: string, formName: string, rows: LeadRecord[]): string {
  mkdirSync(directory, { recursive: true });
  const questions: string[] = [];
  const seen = new Set<string>();
  const fixed = new Set([...BEFORE, ...AFTER]);
  for (const row of rows) {
    for (const key of Object.keys(row.answers)) {
      if (fixed.has(key) || CONTACT_KEYS.has(key) || seen.has(key)) continue;
      seen.add(key);
      questions.push(key);
    }
  }
  const headers = [...BEFORE, ...questions, ...AFTER];
  const lines = [headers.map(escapeCell).join(",")];
  for (const row of rows) {
    const values = headers.map((header) => escapeCell(cellValue(row, header)));
    lines.push(values.join(","));
  }
  const filePath = join(directory, `${safeName(formName)}.csv`);
  writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
  return filePath;
}

function cellValue(row: LeadRecord, header: string): string {
  switch (header) {
    case "id":
      return row.id;
    case "created_time":
      return row.createdTimeRaw;
    case "ad_id":
      return row.adId ?? "";
    case "ad_name":
      return row.adName ?? "";
    case "adset_id":
      return row.adsetId ?? "";
    case "adset_name":
      return row.adsetName ?? "";
    case "campaign_id":
      return row.campaignId ?? "";
    case "campaign_name":
      return row.campaignName ?? "";
    case "form_id":
      return row.formId ?? "";
    case "form_name":
      return row.formName ?? "";
    case "is_organic":
      return row.isOrganic === null ? "" : String(row.isOrganic);
    case "platform":
      return row.platform ?? "";
    case "full_name":
      return row.fullName ?? "";
    case "phone_number":
      return row.phoneNumber ?? "";
    case "email":
      return row.email ?? "";
    case "inbox_url":
      return row.inboxUrl ?? "";
    case "lead_status":
      return row.leadStatus ?? "";
    default:
      return row.answers[header] ?? "";
  }
}

function escapeCell(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

function safeName(value: string): string {
  const cleaned = value.replace(/[<>:"/\\|?*]/g, " ").replace(/\s+/g, " ").trim();
  return (cleaned || "leads").slice(0, 80);
}
