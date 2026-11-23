import { readdirSync, rmSync } from "fs";
import { join, resolve } from "path";
import { MISSING_CREDENTIALS, ROOT, loadSettings } from "./config";
import { LeadDatabase } from "./db";
import { writeLeadCsv } from "./export-csv";
import { importCsvFiles } from "./importer";
import { MetaClient } from "./meta";
import { autoSyncWindow, leadFromApi, utcDayWindow } from "./normalize";
import { realClient, runSyncLocked } from "./sync";

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const settings = loadSettings();

  if (!command || command === "serve") {
    await import("./main");
    return;
  }

  if (command === "import-csv") {
    if (!args.length) {
      console.error("Usage: npm run import:csv -- <file.csv> [more.csv]");
      process.exitCode = 2;
      return;
    }
    const database = await openDatabase(settings);
    try {
      console.log(JSON.stringify(await importCsvFiles(database, args)));
    } finally {
      await database.close();
    }
    return;
  }

  if (command === "sync") {
    const day = args[0];
    const database = await openDatabase(settings);
    try {
      let window: ReturnType<typeof utcDayWindow> | undefined;
      const backfill = day === "auto" && settings.syncOnStart && !(await database.hasLookback());
      if (day === "auto") {
        // SYNC_ON_START=true reads SYNC_LOOKBACK_DAYS once. After that, and whenever it is false,
        // midnight on 24 Nov reads all of 23 Nov and midnight on 25 Nov reads all of 24 Nov.
        const chosen = autoSyncWindow(new Date(), settings.syncOnStart, !backfill, settings.lookbackDays);
        window = chosen;
        console.log(
          backfill
            ? `First sync: last ${settings.lookbackDays} days, from ${chosen.start.toISOString()} until ${chosen.end.toISOString()}.`
            : `Daily sync from ${chosen.start.toISOString()} until ${chosen.end.toISOString()}.`,
        );
      } else if (day) {
        window = utcDayWindow(day);
        if (!window) {
          console.error("Usage: npm run sync -- YYYY-MM-DD");
          console.error("       npm run sync -- auto");
          process.exitCode = 2;
          return;
        }
      }
      const result = await runSyncLocked(settings, database, realClient(settings), window ?? undefined);
      if (backfill && result.status === "ok") await database.markLookback();
      console.log(JSON.stringify(result));
      process.exitCode = result.status === "ok" || result.status === "busy" ? 0 : 1;
    } finally {
      database.close();
    }
    return;
  }

  if (command === "check") {
    if (!settings.credentialsReady) {
      console.error(MISSING_CREDENTIALS);
      process.exitCode = 1;
      return;
    }
    const source = realClient(settings);
    const pages = [];
    const visiblePages = [];
    const pageErrors: { page_id: string; error: string }[] = [];
    for (const account of settings.accounts) {
      if (!account.accessToken) continue;
      const client = new MetaClient({
        accessToken: account.accessToken,
        graphVersion: settings.graphVersion,
        pageIds: account.pageIds,
        formIds: [],
      });
      try {
        visiblePages.push(...(await client.visiblePages()));
      } catch (error) {
        pageErrors.push({ page_id: "", error: error instanceof Error ? error.message : String(error) });
      }
      for (const pageId of account.pageIds) {
        try {
          pages.push(await client.pageAccess(pageId));
        } catch (error) {
          pageErrors.push({ page_id: pageId, error: error instanceof Error ? error.message : String(error) });
        }
      }
    }
    let forms: { id: string; name?: string; status?: string }[] = [];
    if (pages.some((page) => page.matched)) {
      forms = (await source.listForms()).map((form) => ({ id: form.id, name: form.name, status: form.status }));
    }
    console.log(JSON.stringify({ pages, visible_pages: visiblePages, forms, errors: [...pageErrors, ...source.accountErrors] }, null, 2));
    process.exitCode = pages.every((page) => page.matched) && pageErrors.length === 0 ? 0 : 1;
    return;
  }

  if (command === "export-csv") {
    if (!settings.credentialsReady) {
      console.error(MISSING_CREDENTIALS);
      process.exitCode = 1;
      return;
    }
    const date = args[0] ?? "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      console.error("Usage: npm run export:csv -- 2026-11-17");
      process.exitCode = 2;
      return;
    }
    const pages = [];
    for (const account of settings.accounts) {
      if (!account.accessToken) continue;
      const client = new MetaClient({
        accessToken: account.accessToken,
        graphVersion: settings.graphVersion,
        pageIds: account.pageIds,
        formIds: [],
      });
      for (const pageId of account.pageIds) {
        try {
          pages.push(await client.pageAccess(pageId));
        } catch (error) {
          pages.push({ id: pageId, name: null, matched: false, error: error instanceof Error ? error.message : String(error) });
        }
      }
    }
    const since = new Date(`${date}T00:00:00.000Z`);
    const pageNames = new Map(pages.filter((page) => page.matched).map((page) => [page.id, page.name || page.id]));
    const source = realClient(settings);
    const forms = await source.listForms(since);
    const directory = resolve(ROOT, "data", "exports");
    clearCsvDirectory(directory);
    const written = [];
    for (const form of forms) {
      if (form.page_id && !pageNames.has(form.page_id)) continue;
      const rows = [];
      for await (const raw of source.iterLeads(String(form.id), since)) {
        const created = String(raw?.created_time ?? "");
        if (!created.startsWith(date)) continue;
        try {
          rows.push(leadFromApi(raw, form.name ?? null));
        } catch (error) {
          console.warn(`Skipped lead ${raw?.id}: ${error instanceof Error ? error.message : error}`);
        }
      }
      if (!rows.length) continue;
      const pageName = pageNames.get(form.page_id ?? "") || form.page_id || "page";
      written.push({
        page_id: form.page_id ?? "",
        page_name: pageName,
        form_id: form.id,
        form_name: form.name ?? "",
        rows: rows.length,
        file: writeLeadCsv(directory, `${pageName} - ${form.name || form.id}`, rows),
      });
    }
    console.log(JSON.stringify({ date, pages, files: written, errors: source.accountErrors }, null, 2));
    process.exitCode = source.accountErrors.length || pages.some((page) => !page.matched) ? 1 : 0;
    return;
  }

  console.error("Commands: serve, sync, import-csv, check, export-csv");
  process.exitCode = 2;
}

async function openDatabase(settings: ReturnType<typeof loadSettings>) {
  if (settings.mysql) {
    const { MysqlLeadDatabase } = await import("./mysql-db");
    return MysqlLeadDatabase.open(settings.mysql);
  }
  return LeadDatabase.open(settings.databasePath);
}

function clearCsvDirectory(directory: string) {
  let names: string[] = [];
  try {
    names = readdirSync(directory);
  } catch {
    return;
  }
  for (const name of names) {
    if (name.toLowerCase().endsWith(".csv")) rmSync(join(directory, name));
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
