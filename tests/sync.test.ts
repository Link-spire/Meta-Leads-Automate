import assert from "node:assert/strict";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { describe, it } from "node:test";
import { readFileSync } from "fs";
import { parseCsv } from "../src/csv";
import { mysqlFromUrl, Settings } from "../src/config";
import { LeadDatabase } from "../src/db";
import { importCsvFiles } from "../src/importer";
import { MetaApiError, MetaClient, MetaSource } from "../src/meta";
import { autoSyncWindow, broadcastLead, leadFromApi, leadFromCsv, mappedContactTime, mappedInterest, matchesFilter, previousUtcDayWindow, sinceTime, startOfLocalDay, utcDayBefore, utcDayWindow } from "../src/normalize";
import { runSync } from "../src/sync";

const ROOT = resolve(__dirname, "..");

function settings(databasePath: string, extra: Partial<Settings> = {}): Settings {
  return new Settings({
    accessToken: "test-token",
    pageIds: ["123"],
    formIds: [],
    campaignFilters: [],
    formFilters: [],
    graphVersion: "v25.0",
    databasePath,
    intervalMinutes: 60,
    lookbackDays: 90,
    overlapMinutes: 120,
    host: "127.0.0.1",
    port: 8080,
    syncOnStart: true,
    apiKey: "",
    ...extra,
  });
}

class FakeMeta {
  leadCalls = 0;
  async listForms() {
    return [{ id: "form-ortho", name: "Ortho Camapign Oct-copy", status: "ACTIVE" }];
  }
  async *iterLeads() {
    this.leadCalls += 1;
    yield {
      id: "1001",
      created_time: "2026-10-26T06:32:01-07:00",
      ad_id: "1",
      ad_name: "Ortho Haloween",
      adset_id: "2",
      adset_name: "Ad set",
      campaign_id: "3",
      campaign_name: "AA - 22 Oct - Ortho Haloween Campaign",
      form_id: "form-ortho",
      is_organic: false,
      platform: "fb",
      field_data: [
        { name: "full_name", values: ["Ortho Tester"] },
        { name: "email", values: ["ortho@example.com"] },
        { name: "phone_number", values: ["+15555550100"] },
      ],
    };
    yield {
      id: "1002",
      created_time: "2026-10-26T08:06:44-07:00",
      campaign_name: "AA - 22 Oct - CDCP Haloween Campaign",
      form_id: "form-ortho",
      field_data: [{ name: "full_name", values: ["Other Campaign"] }],
    };
  }
}

describe("normalize", () => {
  it("keeps campaign fields and custom questions from the ortho export", () => {
    const text = readFileSync(join(ROOT, "Ortho_Camapign_Oct_copy.csv"), "utf8");
    const row = leadFromCsv(parseCsv(text)[0]);
    assert.equal(row.createdTime.toISOString(), "2026-10-26T13:32:01.000Z");
    assert.equal(row.campaignName, "AA - 22 Oct - Ortho Haloween Campaign");
    assert.equal(row.formId, "2281471209314213");
    assert.equal(row.isOrganic, false);
    assert.ok(row.answers["who_are_you_interested_in_getting_braces_for?"]);
    assert.equal(row.answers.campaign_name, undefined);
    const customPhone = leadFromCsv({
      id: "1106119042041527",
      created_time: "2026-11-13T14:17:21+0000",
      "what is your phone number?": "+14165749398",
    });
    assert.equal(customPhone.phoneNumber, "+14165749398");
    assert.ok(row.inboxUrl);
    assert.ok(row.email?.includes("@"));
  });

  it("maps Meta field_data onto contact columns", () => {
    const lead = leadFromApi(
      {
        id: "999",
        created_time: "2026-10-26T08:06:44-07:00",
        ad_id: "10",
        ad_name: "Dentures Oct",
        adset_id: "20",
        adset_name: "Ad set",
        campaign_id: "30",
        campaign_name: "AA - 22 Oct - CDCP Haloween Campaign",
        form_id: "1558464462965880",
        is_organic: false,
        platform: "fb",
        field_data: [
          { name: "first_name", values: ["Ada"] },
          { name: "last_name", values: ["Lovelace"] },
          { name: "email", values: ["ada@example.com"] },
          { name: "phone", values: ["+15555550123"] },
          { name: "inbox_url", values: ["https://business.facebook.com/latest/inbox"] },
          { name: "best_time_to_contact_you?", values: ["Morning"] },
        ],
      },
      "Dentures OCT 2026",
    );
    assert.equal(lead.fullName, "Ada Lovelace");
    assert.equal(lead.email, "ada@example.com");
    assert.equal(lead.phoneNumber, "+15555550123");
    assert.equal(lead.answers["best_time_to_contact_you?"], "Morning");
    assert.equal(lead.formName, "Dentures OCT 2026");
    assert.equal(lead.leadStatus, "complete");
    assert.equal(lead.inboxUrl, "https://business.facebook.com/latest/inbox");
    const customPhone = leadFromApi(
      {
        id: "1000",
        created_time: "2026-11-13T14:17:21+0000",
        form_id: "1152459550688941",
        is_organic: false,
        platform: "fb",
        field_data: [
          { name: "full_name", values: ["Pat Example"] },
          { name: "email", values: ["pat@example.com"] },
          { name: "what is your phone number?", values: ["+15555550199"] },
          { name: "inbox_url", values: ["https://business.facebook.com/latest/example"] },
        ],
      },
      "Nov Dentures 2026",
    );
    assert.equal(customPhone.phoneNumber, "+15555550199");
    assert.equal(customPhone.inboxUrl, "https://business.facebook.com/latest/example");
  });

  it("rewinds the watermark and matches campaign names", () => {
    const now = new Date("2026-11-09T12:00:00.000Z");
    const watermark = new Date("2026-11-09T10:00:00.000Z");
    assert.equal(sinceTime(watermark, now, 90, 120)?.toISOString(), "2026-11-09T08:00:00.000Z");
    assert.equal(sinceTime(null, now, 90, 120)?.toISOString(), "2026-08-11T12:00:00.000Z");
    assert.equal(sinceTime(null, now, 0, 120), null);
    const localNow = new Date(2026, 10, 20, 17, 38, 0);
    assert.equal(startOfLocalDay(localNow).getTime(), new Date(2026, 10, 20).getTime());
    const day = utcDayWindow("2026-11-13");
    assert.equal(day?.start.toISOString(), "2026-11-13T00:00:00.000Z");
    assert.equal(day?.end.toISOString(), "2026-11-14T00:00:00.000Z");
    assert.equal(utcDayWindow("2026-11-31"), null);
    assert.equal(matchesFilter("AA - Ortho Campaign", ["ortho"]), true);
    assert.equal(matchesFilter("AA - Ortho Campaign", ["dentures"]), false);
  });
});

describe("hostinger mapping", () => {
  it("reads a mysql URL and ignores the sqlite URL", () => {
    const parsed = mysqlFromUrl("mysql://dbuser:p%40ss@193.203.184.8:3306/u421207705_leads");
    assert.deepEqual(parsed, {
      host: "193.203.184.8",
      port: 3306,
      user: "dbuser",
      password: "p@ss",
      database: "u421207705_leads",
    });
    assert.equal(mysqlFromUrl("sqlite:///./data/leads.db"), null);
  });

  it("maps each form's question onto interest and contact_time", () => {
    assert.equal(mappedInterest({ "who_are_you_interested_in_getting_braces_for?": "My Child" }), "My Child");
    assert.equal(mappedInterest({ "what_type_of_denture_are_you_interested_in?": "Full set" }), "Full set");
    assert.equal(mappedInterest({ "which_service_are_you_interested_in?": "Cleaning" }), "Cleaning");
    assert.equal(mappedContactTime({ "best_time_to_contact_you?": "Morning" }), "Morning");
    assert.equal(mappedContactTime({ "what_is_your_preferred_time_of_contact?": "Evening" }), "Evening");
    assert.equal(mappedInterest({}), null);
  });

  it("builds the hosted lead row from a Meta lead", () => {
    const lead = leadFromApi(
      {
        id: "lead-13",
        created_time: "2026-11-13T23:39:55+0000",
        ad_id: "ad-1",
        ad_name: "CDCP Nov",
        adset_id: "set-1",
        adset_name: "Set",
        campaign_id: "camp-1",
        campaign_name: "CDCP November",
        form_id: "1692966128830455",
        is_organic: false,
        platform: "fb",
        field_data: [
          { name: "full_name", values: ["Test Person"] },
          { name: "email", values: ["person@example.com"] },
          { name: "phone_number", values: ["+15555550111"] },
          { name: "which_service_are_you_interested_in?", values: ["Cleaning"] },
          { name: "best_time_to_contact_you?", values: ["Morning"] },
        ],
      },
      "CDCP November",
    );
    lead.pageId = "1050348698156106";
    lead.pageName = "Suncity Dental Care";
    const row = broadcastLead(lead);
    assert.equal(row.meta_lead_id, "lead-13");
    assert.equal(row.page_id, "1050348698156106");
    assert.equal(row.page_name, "Suncity Dental Care");
    assert.equal(row.lead_date, "2026-11-13 23:39:55.000");
    assert.equal(row.campaign_id, "camp-1");
    assert.equal(row.campaign_name, "CDCP November");
    assert.equal(row.form_name, "CDCP November");
    const unnamed = leadFromApi(
      {
        id: "lead-page",
        created_time: "2026-11-13T14:17:21+0000",
        form_id: "1152459550688941",
        field_data: [{ name: "full_name", values: ["Page Fallback"] }],
      },
      "Nov Dentures 2026",
    );
    unnamed.pageName = "Mi Dental Care";
    assert.equal(broadcastLead(unnamed).campaign_name, "Mi Dental Care");
    assert.equal(broadcastLead(unnamed).page_name, "Mi Dental Care");
    assert.equal(row.interest, "Cleaning");
    assert.equal(row.contact_time, "Morning");
    assert.equal(row.is_organic, 0);
    assert.match(String(row.answers), /Cleaning/);
  });

  it("cuts values to the hosted column lengths and keeps the full answer", () => {
    const longPhone = "9".repeat(80);
    const lead = leadFromApi(
      {
        id: "lead-long",
        created_time: "2026-11-13T14:17:21+0000",
        ad_name: "A".repeat(300),
        field_data: [{ name: "what is your phone number?", values: [longPhone] }],
      },
      "Nov Dentures 2026",
    );
    const row = broadcastLead(lead);
    assert.equal(String(row.phone_number).length, 50);
    assert.equal(String(row.ad_name).length, 255);
    assert.ok(String(row.answers).includes(longPhone));
  });
});

describe("database", () => {
  it("imports both exports once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "leads-"));
    const database = LeadDatabase.open(join(dir, "leads.db"));
    try {
      const first = await importCsvFiles(database, [
        join(ROOT, "Ortho_Camapign_Oct_copy.csv"),
        join(ROOT, "Dentures_OCT_2026.csv"),
      ]);
      const second = await importCsvFiles(database, [join(ROOT, "Ortho_Camapign_Oct_copy.csv")]);
      assert.equal(first.lead_count, 4);
      assert.equal(second.lead_count, 4);
      assert.equal(
        database.countAnswers("are_you_looking_to_replace_existing_dentures_or_get_your_first_set?"),
        1,
      );
      assert.deepEqual(database.platforms().sort(), ["fb", "ig"]);
    } finally {
      database.close();
    }
  });

  it("upserts api leads and skips other campaigns", async () => {
    const dir = mkdtempSync(join(tmpdir(), "leads-"));
    const database = LeadDatabase.open(join(dir, "leads.db"));
    try {
      const configured = settings(database["db"] ? join(dir, "leads.db") : join(dir, "leads.db"), {
        campaignFilters: ["Ortho"],
      });
      const result = await runSync(configured, database, new FakeMeta());
      assert.equal(result.status, "ok");
      assert.equal(result.leads_fetched, 2);
      assert.equal(result.leads_saved, 1);
      const again = await runSync(configured, database, new FakeMeta());
      assert.equal(again.leads_saved, 1);
      assert.equal(database.countLeads(), 1);
      assert.equal(database.getLead("1001")?.email, "ortho@example.com");
      const repeated = database.upsertLead({
        ...leadFromApi(
          {
            id: "1001",
            created_time: "2026-10-26T06:32:01-07:00",
            campaign_name: "AA - 22 Oct - Ortho Haloween Campaign",
            field_data: [{ name: "full_name", values: ["Ortho Tester"] }],
          },
          "Ortho Camapign Oct-copy",
        ),
      });
      assert.equal(repeated, "updated");
      assert.equal(database.countLeads(), 1);
      assert.equal(database.getLead("1001")?.email, "ortho@example.com");
      assert.equal(database.getLead("1001")?.form_name, "Ortho Camapign Oct-copy");
    } finally {
      database.close();
    }
  });

  it("names the previous UTC day and treats only a clean run as finished", () => {
    const started = new Date("2026-11-24T00:05:00.000Z");
    const first = autoSyncWindow(started, true, false, 90);
    assert.equal(first.start.toISOString(), "2026-08-26T00:05:00.000Z");
    assert.equal(first.end.toISOString(), "2026-11-24T00:05:00.000Z");
    const later = autoSyncWindow(new Date("2026-11-25T00:05:00.000Z"), true, true, 90);
    assert.equal(later.start.toISOString(), "2026-11-24T00:00:00.000Z");
    assert.equal(later.end.toISOString(), "2026-11-25T00:00:00.000Z");
    const noLookback = autoSyncWindow(started, false, false, 90);
    assert.equal(noLookback.start.toISOString(), "2026-11-23T00:00:00.000Z");
    assert.equal(utcDayBefore(new Date("2026-11-24T00:05:00.000Z")), "2026-11-23");
    assert.equal(utcDayBefore(new Date("2026-03-01T12:00:00.000Z")), "2026-02-28");
    const dir = mkdtempSync(join(tmpdir(), "leads-"));
    const database = LeadDatabase.open(join(dir, "leads.db"));
    try {
      assert.equal(database.hasSuccessfulRun(), false);
      const failed = database.startRun();
      database.finishRun(failed, "error", { forms_checked: 1, leads_fetched: 0, leads_saved: 0 }, "failed");
      assert.equal(database.hasSuccessfulRun(), false);
      const dayOnly = database.startRun();
      database.finishRun(dayOnly, "ok", { forms_checked: 1, leads_fetched: 1, leads_saved: 1 }, null);
      assert.equal(database.hasSuccessfulRun(), false);
      database.saveCursor({
        formId: "form-1",
        formName: "Daily",
        watermark: new Date("2026-11-24T00:05:00.000Z"),
        lastFetched: 1,
        lastSaved: 1,
        lastError: null,
      });
      assert.equal(database.hasSuccessfulRun(), true);
    } finally {
      database.close();
    }
  });

  it("reads the last 90 days only when sync on start is on", async () => {
    const started = new Date("2026-11-24T00:05:00.000Z");
    const asked: Array<Date | null> = [];
    const source = {
      async listForms() {
        return [{ id: "form-a", name: "Daily" }];
      },
      async *iterLeads(_formId: string, since: Date | null) {
        asked.push(since);
      },
    };
    const dir = mkdtempSync(join(tmpdir(), "leads-"));
    const database = LeadDatabase.open(join(dir, "leads.db"));
    try {
      await runSync(settings(join(dir, "leads.db"), { syncOnStart: true, lookbackDays: 90 }), database, source, undefined, started);
      assert.equal(asked[0]?.toISOString(), "2026-08-26T00:05:00.000Z");
      assert.equal(database.hasLookback(), true);
      await runSync(
        settings(join(dir, "leads.db"), { syncOnStart: true, lookbackDays: 90 }),
        database,
        source,
        undefined,
        new Date("2026-11-25T00:05:00.000Z"),
      );
      assert.equal(asked[1]?.toISOString(), "2026-11-23T22:05:00.000Z");
    } finally {
      database.close();
    }

    const fresh = LeadDatabase.open(join(dir, "plain.db"));
    try {
      await runSync(settings(join(dir, "plain.db"), { syncOnStart: false, lookbackDays: 90 }), fresh, source, undefined, started);
      assert.equal(asked[2]?.toISOString(), startOfLocalDay(started).toISOString());
      assert.notEqual(asked[2]?.toISOString(), "2026-08-26T00:05:00.000Z");
      assert.equal(fresh.hasLookback(), false);
    } finally {
      fresh.close();
    }
  });

  it("does not read 90 days again after the lookback marker exists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "leads-"));
    const database = LeadDatabase.open(join(dir, "leads.db"));
    const asked: Array<Date | null> = [];
    try {
      database.markLookback(new Date("2026-11-24T00:05:00.000Z"));
      await runSync(
        settings(join(dir, "leads.db"), { syncOnStart: true, lookbackDays: 90 }),
        database,
        {
          async listForms() {
            return [{ id: "form-a", name: "Daily" }];
          },
          async *iterLeads(_formId: string, since: Date | null) {
            asked.push(since);
          },
        },
        undefined,
        new Date("2026-11-25T00:05:00.000Z"),
      );
      assert.equal(asked[0]?.toISOString(), "2026-11-23T22:05:00.000Z");
      assert.notEqual(asked[0]?.toISOString(), "2026-08-27T00:05:00.000Z");
    } finally {
      database.close();
    }
  });

  it("midnight on the 24th saves all of the 23rd, and midnight on the 25th saves all of the 24th", async () => {
    const night24 = previousUtcDayWindow(new Date("2026-11-24T00:05:00.000Z"));
    const night25 = previousUtcDayWindow(new Date("2026-11-25T00:00:00.000Z"));
    assert.equal(night24.day, "2026-11-23");
    assert.equal(night24.start.toISOString(), "2026-11-23T00:00:00.000Z");
    assert.equal(night24.end.toISOString(), "2026-11-24T00:00:00.000Z");
    assert.equal(night25.day, "2026-11-24");
    assert.equal(night25.end.toISOString(), "2026-11-25T00:00:00.000Z");

    const leads = [
      ["late-22", "2026-11-22T23:59:59+0000"],
      ["start-23", "2026-11-23T00:00:00+0000"],
      ["mid-23", "2026-11-23T18:30:00+0000"],
      ["end-23", "2026-11-23T23:59:59+0000"],
      ["start-24", "2026-11-24T00:00:00+0000"],
      ["mid-24", "2026-11-24T15:00:00+0000"],
      ["end-24", "2026-11-24T23:59:59+0000"],
      ["start-25", "2026-11-25T00:00:00+0000"],
    ].map(([id, created_time]) => ({
      id,
      created_time,
      field_data: [{ name: "full_name", values: [id] }],
    }));
    const source = (expectedSince: Date) => ({
      async listForms(since?: Date | null) {
        assert.equal(since?.toISOString(), expectedSince.toISOString());
        return [{ id: "form-day", name: "Daily" }];
      },
      async *iterLeads(_formId: string, since: Date | null) {
        assert.equal(since?.toISOString(), expectedSince.toISOString());
        for (const lead of leads) if (new Date(lead.created_time) >= since!) yield lead;
      },
    });

    const dir = mkdtempSync(join(tmpdir(), "leads-"));
    const database = LeadDatabase.open(join(dir, "leads.db"));
    try {
      const first = await runSync(settings(join(dir, "leads.db")), database, source(night24.start), night24);
      assert.equal(first.status, "ok");
      assert.equal(first.leads_saved, 3);
      for (const id of ["start-23", "mid-23", "end-23"]) assert.ok(database.getLead(id));
      for (const id of ["late-22", "start-24", "mid-24", "end-24", "start-25"]) assert.equal(database.getLead(id), undefined);

      const second = await runSync(settings(join(dir, "leads.db")), database, source(night25.start), night25);
      assert.equal(second.leads_saved, 3);
      for (const id of ["start-24", "mid-24", "end-24"]) assert.ok(database.getLead(id));
      assert.equal(database.getLead("start-25"), undefined);
      assert.equal(database.countLeads(), 6);

      const again = await runSync(settings(join(dir, "leads.db")), database, source(night25.start), night25);
      assert.equal(again.leads_saved, 3);
      assert.equal(database.countLeads(), 6);
    } finally {
      database.close();
    }
  });

  it("saves only the requested UTC day", async () => {
    const dir = mkdtempSync(join(tmpdir(), "leads-"));
    const database = LeadDatabase.open(join(dir, "leads.db"));
    const window = utcDayWindow("2026-11-13");
    assert.ok(window);
    try {
      const result = await runSync(settings(join(dir, "leads.db"), { syncOnStart: false }), database, {
        async listForms() {
          return [{ id: "form-13", name: "CDCP November" }];
        },
        async *iterLeads() {
          yield {
            id: "nov-13",
            created_time: "2026-11-13T23:39:55+0000",
            form_id: "form-13",
            is_organic: false,
            platform: "fb",
            field_data: [
              { name: "full_name", values: ["Day Lead"] },
              { name: "what is your phone number?", values: ["+15555550113"] },
              { name: "inbox_url", values: ["https://business.facebook.com/latest/day"] },
            ],
          };
          yield {
            id: "nov-20",
            created_time: "2026-11-20T02:00:00+0000",
            form_id: "form-13",
            field_data: [{ name: "full_name", values: ["Other Day"] }],
          };
        },
      }, window);
      assert.equal(result.status, "ok");
      assert.equal(result.leads_fetched, 1);
      assert.equal(result.leads_saved, 1);
      assert.equal(database.countLeads(), 1);
      assert.equal(database.getLead("nov-13")?.phone_number, "+15555550113");
      assert.equal(database.getLead("nov-13")?.inbox_url, "https://business.facebook.com/latest/day");
      assert.equal(database.getLead("nov-20"), undefined);
    } finally {
      database.close();
    }
  });

  it("continues from the last run so leads between daily runs are neither skipped nor duplicated", async () => {
    const dir = mkdtempSync(join(tmpdir(), "leads-"));
    const database = LeadDatabase.open(join(dir, "leads.db"));
    const configured = settings(join(dir, "leads.db"), { syncOnStart: false });
    const leads: Array<Record<string, any>> = [];
    const asked: Array<Date | null> = [];
    const source = {
      async listForms() {
        return [{ id: "form-a", name: "Daily" }];
      },
      async *iterLeads(_formId: string, since: Date | null) {
        asked.push(since);
        for (const lead of leads) if (!since || new Date(lead.created_time) >= since) yield lead;
      },
    };
    const day1 = new Date("2026-11-22T09:00:00.000Z");
    const day2 = new Date("2026-11-23T09:00:00.000Z");
    const day3 = new Date("2026-11-24T09:00:00.000Z");
    try {
      await runSync(configured, database, source, undefined, day1);
      assert.equal(asked[0]?.getTime(), startOfLocalDay(day1).getTime());

      // One lead arrives after the first run but on the same day, one shortly before the second run.
      leads.push(
        { id: "evening", created_time: "2026-11-22T15:00:00+0000", field_data: [{ name: "full_name", values: ["Evening"] }] },
        { id: "morning", created_time: "2026-11-23T08:30:00+0000", field_data: [{ name: "full_name", values: ["Morning"] }] },
      );
      const second = await runSync(configured, database, source, undefined, day2);
      assert.equal(second.status, "ok");
      assert.equal(asked[1]?.toISOString(), "2026-11-22T07:00:00.000Z");
      assert.equal(second.leads_saved, 2);
      assert.ok(database.getLead("evening"));

      // The overlap reads "morning" again; it must update the same row.
      const third = await runSync(configured, database, source, undefined, day3);
      assert.equal(asked[2]?.toISOString(), "2026-11-23T07:00:00.000Z");
      assert.equal(third.leads_fetched, 1);
      assert.equal(database.countLeads(), 2);
    } finally {
      database.close();
    }
  });

  it("starts a new form from the last run and retries a failed form from the same point", async () => {
    const dir = mkdtempSync(join(tmpdir(), "leads-"));
    const database = LeadDatabase.open(join(dir, "leads.db"));
    const configured = settings(join(dir, "leads.db"), { syncOnStart: false });
    const asked: Record<string, Array<Date | null>> = { "form-a": [], "form-b": [] };
    let forms = [{ id: "form-a", name: "Old form" }];
    let failing = true;
    const source = {
      async listForms() {
        return forms;
      },
      async *iterLeads(formId: string, since: Date | null) {
        asked[formId].push(since);
        if (formId !== "form-b") return;
        if (failing) throw new MetaApiError("Unsupported get request", 100);
        yield { id: "b-1", created_time: "2026-11-22T14:00:00+0000", field_data: [{ name: "full_name", values: ["New Form"] }] };
      },
    };
    try {
      await runSync(configured, database, source, undefined, new Date("2026-11-22T09:00:00.000Z"));
      forms = [...forms, { id: "form-b", name: "New form" }];
      const second = await runSync(configured, database, source, undefined, new Date("2026-11-23T09:00:00.000Z"));
      assert.equal(second.status, "error");
      assert.match(String(second.error), /form-b/);
      assert.equal(asked["form-b"][0]?.toISOString(), "2026-11-22T07:00:00.000Z");

      failing = false;
      const third = await runSync(configured, database, source, undefined, new Date("2026-11-24T09:00:00.000Z"));
      assert.equal(third.status, "ok");
      assert.ok((asked["form-b"][1] as Date) <= (asked["form-b"][0] as Date));
      assert.equal(asked["form-a"][2]?.toISOString(), "2026-11-23T07:00:00.000Z");
      assert.ok(database.getLead("b-1"));
    } finally {
      database.close();
    }
  });

  it("stops calling Meta for the remaining forms after a rate limit error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "leads-"));
    const database = LeadDatabase.open(join(dir, "leads.db"));
    const called: string[] = [];
    try {
      const result = await runSync(settings(join(dir, "leads.db")), database, {
        async listForms() {
          return [
            { id: "form-a", name: "A" },
            { id: "form-b", name: "B" },
          ];
        },
        async *iterLeads(formId: string) {
          called.push(formId);
          throw new MetaApiError("There have been too many leadgen api calls", 80005);
        },
      });
      assert.equal(result.status, "error");
      assert.deepEqual(called, ["form-a"]);
    } finally {
      database.close();
    }
  });

  it("does not call leads when the form name is filtered out", async () => {
    const dir = mkdtempSync(join(tmpdir(), "leads-"));
    const database = LeadDatabase.open(join(dir, "leads.db"));
    const client = new FakeMeta();
    try {
      const result = await runSync(settings(join(dir, "leads.db"), { formFilters: ["does-not-match"] }), database, client);
      assert.equal(result.forms_checked, 0);
      assert.equal(client.leadCalls, 0);
    } finally {
      database.close();
    }
  });
});

describe("meta client", () => {
  it("follows pages and surfaces api errors", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async (input) => {
      calls += 1;
      const url = new URL(String(input));
      if (url.pathname.endsWith("/leadgen_forms")) {
        return Response.json({
          data: [{ id: "f1", name: "One" }],
          paging: { next: "https://graph.facebook.com/page-2" },
        });
      }
      if (url.pathname === "/page-2") return Response.json({ data: [{ id: "f2", name: "Two" }] });
      if (url.pathname.endsWith("/f1/leads")) {
        assert.ok(url.searchParams.get("filtering")?.includes("time_created"));
        assert.ok(url.searchParams.get("access_token"));
        return Response.json({ data: [{ id: "lead-1" }] });
      }
      return Response.json({ error: { message: "bad token", code: 190 } }, { status: 400 });
    };
    const client = new MetaClient(settings(":memory:"), fetchImpl);
    client.backoffMs = [0, 0, 0];
    const forms = await client.listForms();
    assert.deepEqual(forms.map((form) => form.id), ["f1", "f2"]);
    const leads = [];
    for await (const lead of client.iterLeads("f1", new Date("2026-11-01T00:00:00.000Z"))) leads.push(lead);
    assert.deepEqual(leads, [{ id: "lead-1" }]);
    await assert.rejects(() => client.getPage("nope"), MetaApiError);
    assert.ok(calls >= 4);
  });

  it("stops when Meta reports the rate limit is nearly full", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return Response.json(
        { data: [{ id: "page-a", name: "A", access_token: "page-token" }] },
        { headers: { "x-app-usage": JSON.stringify({ call_count: 96, total_cputime: 10, total_time: 10 }) } },
      );
    };
    const source = new MetaSource(
      settings(":memory:", { accounts: [{ accessToken: "token-a", pageIds: ["page-a"] }] }),
      fetchImpl,
    );
    await assert.rejects(() => source.listForms(new Date("2026-11-23T00:00:00.000Z")), /rate limit is nearly full/);
    assert.equal(calls, 1);
  });

  it("keeps Meta's error text, retries server errors and never retries a throttled call", async () => {
    let calls = 0;
    let status = 500;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return Response.json({ error: { message: "Service temporarily unavailable", code: 2 } }, { status });
    };
    const client = new MetaClient(settings(":memory:"), fetchImpl);
    client.backoffMs = [0, 0, 0];
    await assert.rejects(() => client.getPage("123"), /Service temporarily unavailable/);
    assert.equal(calls, 3);
    calls = 0;
    status = 429;
    await assert.rejects(() => client.getPage("123"), MetaApiError);
    assert.equal(calls, 1);
  });

  it("reads a form directly when the page request does not reach back far enough", async () => {
    const direct: URL[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/accounts")) {
        return Response.json({ data: [{ id: "page-a", name: "Page A", access_token: "page-token" }] });
      }
      if (url.pathname.endsWith("/form-a/leads")) {
        direct.push(url);
        return Response.json({
          data: [
            { id: "old-lead", created_time: "2026-11-20T10:00:00+0000" },
            { id: "new-lead", created_time: "2026-11-23T01:00:00+0000" },
          ],
        });
      }
      return Response.json({
        name: "Page A",
        leadgen_forms: {
          data: [{ id: "form-a", name: "Form A", leads: { data: [{ id: "new-lead", created_time: "2026-11-23T01:00:00+0000" }] } }],
        },
      });
    };
    const source = new MetaSource(settings(":memory:", { accounts: [{ accessToken: "token-a", pageIds: ["page-a"] }] }), fetchImpl);
    await source.listForms(new Date("2026-11-23T00:00:00.000Z"));
    const ids = async (since: Date | null) => {
      const found = [];
      for await (const lead of source.iterLeads("form-a", since)) found.push(lead.id);
      return found;
    };
    assert.deepEqual(await ids(new Date("2026-11-23T00:30:00.000Z")), ["new-lead"]);
    assert.equal(direct.length, 0);
    assert.deepEqual(await ids(new Date("2026-11-20T00:00:00.000Z")), ["old-lead", "new-lead"]);
    assert.equal(direct.length, 1);
    assert.equal(direct[0].searchParams.get("limit"), "100");
    assert.equal(direct[0].searchParams.get("access_token"), "page-token");
    assert.deepEqual(await ids(null), ["old-lead", "new-lead"]);
    assert.equal(direct.length, 2);
  });

  it("lists the forms alone when Meta says the page response is too large", async () => {
    const requests: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/accounts")) {
        return Response.json({ data: [{ id: "page-a", name: "Page A", access_token: "page-token" }] });
      }
      if (url.pathname.endsWith("/form-a/leads")) {
        requests.push("leads");
        return Response.json({ data: [{ id: "lead-1", created_time: "2026-11-23T01:00:00+0000" }] });
      }
      if ((url.searchParams.get("fields") ?? "").includes("leads.limit")) {
        requests.push("page with leads");
        return Response.json(
          { error: { message: "Please reduce the amount of data you're asking for, then retry your request", code: 1 } },
          { status: 500 },
        );
      }
      requests.push("page forms");
      return Response.json({ name: "Page A", leadgen_forms: { data: [{ id: "form-a", name: "Form A" }] } });
    };
    const source = new MetaSource(settings(":memory:", { accounts: [{ accessToken: "token-a", pageIds: ["page-a"] }] }), fetchImpl);
    const since = new Date("2026-11-23T00:00:00.000Z");
    const forms = await source.listForms(since);
    assert.deepEqual(forms.map((form) => form.id), ["form-a"]);
    const found = [];
    for await (const lead of source.iterLeads("form-a", since)) found.push(lead.id);
    assert.deepEqual(found, ["lead-1"]);
    assert.deepEqual(requests, ["page with leads", "page forms", "leads"]);
    assert.deepEqual(source.accountErrors, []);
  });

  it("fetches a form when its leads edge was missing", async () => {
    const direct: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/accounts")) {
        return Response.json({ data: [{ id: "page-a", name: "Page A", access_token: "page-token" }] });
      }
      if (url.pathname.endsWith("/form-a/leads")) {
        direct.push(url.pathname);
        return Response.json({ data: [{ id: "kept", created_time: "2026-11-23T01:00:00+0000" }] });
      }
      return Response.json({
        name: "Page A",
        leadgen_forms: { data: [{ id: "form-a", name: "Form A", leads: { error: { message: "temporary" } } }] },
      });
    };
    const source = new MetaSource(settings(":memory:", { accounts: [{ accessToken: "token-a", pageIds: ["page-a"] }] }), fetchImpl);
    const since = new Date("2026-11-23T00:00:00.000Z");
    await source.listForms(since);
    const found = [];
    for await (const lead of source.iterLeads("form-a", since)) found.push(lead.id);
    assert.deepEqual(found, ["kept"]);
    assert.deepEqual(direct, ["/v25.0/form-a/leads"]);
  });

  it("reads both pages in one call each and reuses those leads", async () => {
    const seen: { page: string; token: string }[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = new URL(String(input));
      const token = url.searchParams.get("access_token") ?? "";
      if (url.pathname.endsWith("/accounts")) {
        const id = token === "token-a" ? "page-a" : "page-b";
        return Response.json({ data: [{ id, name: id, access_token: `page-${token}` }] });
      }
      const page = url.pathname.split("/").filter(Boolean).pop() ?? "";
      const fields = url.searchParams.get("fields") ?? "";
      if (page === "page-a" || page === "page-b") {
        assert.match(fields, /leadgen_forms/);
        assert.match(fields, /time_created/);
      }
      seen.push({ page, token });
      const nextLead = page === "page-a" ? "https://graph.facebook.com/more-leads" : "";
      if (url.pathname === "/more-leads") {
        return Response.json({ data: [{ id: "page-a-lead-2", created_time: "2026-11-23T02:00:00+0000" }] });
      }
      return Response.json({
        name: page,
        leadgen_forms: {
          data: [
            {
              id: `${page}-form`,
              name: page,
              leads: {
                data: [{ id: `${page}-lead`, created_time: "2026-11-23T01:00:00+0000" }],
                paging: nextLead ? { next: nextLead } : undefined,
              },
            },
          ],
        },
      });
    };
    const source = new MetaSource(
      settings(":memory:", {
        accounts: [
          { accessToken: "token-a", pageIds: ["page-a"] },
          { accessToken: "token-b", pageIds: ["page-b"] },
        ],
      }),
      fetchImpl,
    );
    const forms = await source.listForms(new Date("2026-11-23T00:00:00.000Z"));
    assert.deepEqual(
      forms.map((form) => form.id),
      ["page-a-form", "page-b-form"],
    );
    assert.equal(forms[0].page_name, "page-a");
    const leads = [];
    for await (const lead of source.iterLeads("page-a-form", new Date("2026-11-23T00:00:00.000Z"))) leads.push(lead.id);
    assert.deepEqual(leads, ["page-a-lead", "page-a-lead-2"]);
    assert.deepEqual(seen, [
      { page: "page-a", token: "page-token-a" },
      { page: "more-leads", token: "" },
      { page: "page-b", token: "page-token-b" },
    ]);
  });
});
