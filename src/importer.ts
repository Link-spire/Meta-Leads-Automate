import { readFileSync } from "fs";
import { parseCsv } from "./csv";
import { LeadDatabase } from "./db";
import { MysqlLeadDatabase } from "./mysql-db";
import { leadFromCsv, LeadRecord } from "./normalize";

export async function importCsvFiles(database: LeadDatabase | MysqlLeadDatabase, paths: string[]) {
  const files = [];
  for (const path of paths) {
    const text = readFileSync(path, "utf8");
    const records = parseCsv(text);
    let saved = 0;
    let skipped = 0;
    const batch: LeadRecord[] = [];
    records.forEach((record, index) => {
      try {
        batch.push(leadFromCsv(record));
      } catch (error) {
        skipped += 1;
        console.warn(`${path} row ${index + 1} skipped: ${error instanceof Error ? error.message : error}`);
      }
    });
    await database.transaction(async () => {
      for (const row of batch) {
        await database.upsertLead(row);
        saved += 1;
      }
    });
    files.push({ file: path.split(/[/\\]/).pop(), rows: records.length, saved, skipped });
    console.log(`Imported ${saved} rows from ${path}`);
  }
  return { files, lead_count: await database.countLeads() };
}
