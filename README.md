# Meta Leads Automate

Pulls Facebook and Instagram lead-form submissions from the Meta Graph API and stores them in SQLite or MySQL. A local NestJS server can run the sync on a timer. A GitHub Action syncs the previous UTC day into MySQL every night.

## Requirements

- Node.js 22
- A Meta system-user token with the `leads_retrieval` permission
- The Page id for each Page that owns the lead forms

## Setup

```bash
npm install
copy .env.example .env
```

Fill in `.env`. One token and one Page list belong to each business portfolio. Page ids in the same portfolio can be comma-separated.

```
META_ACCESS_TOKEN=
META_PAGE_ID=

META_ACCESS_TOKEN_2=
META_PAGE_ID_2=
```

Leave `META_FORM_IDS`, `META_CAMPAIGN_FILTER`, and `META_FORM_FILTER` empty to read every form. Set them to limit which forms are synced.

`DATABASE_URL` defaults to a local SQLite file:

```
DATABASE_URL=sqlite:///./data/leads.db
```

A `mysql://user:password@host:3306/database` URL uses MySQL instead. The daily GitHub Action requires a MySQL URL.

Check that the token can see the Pages and forms:

```bash
npm run check
```

## Commands

| Command | What it does |
| --- | --- |
| `npm run start:dev` | Local server with reload. Listens on `HOST` and `PORT` (default `127.0.0.1:8080`). |
| `npm start` | Local server. |
| `npm run sync` | Sync from the last saved position, with `SYNC_OVERLAP_MINUTES` of overlap. |
| `npm run sync -- auto` | First run reads `SYNC_LOOKBACK_DAYS` when `SYNC_ON_START=true`. Later runs read the previous UTC day. |
| `npm run sync -- 2026-11-17` | Re-read one UTC day. |
| `npm run export:csv -- 2026-11-17` | Write that day's leads to `data/exports`. |
| `npm run import:csv -- file.csv` | Load a CSV export into the database. |
| `npm test` | Run the sync tests. |

Leads that are read twice update the existing row.

## HTTP

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Returns `{ "ok": true }`. |
| `GET` | `/` and `/status` | Database and sync status. |
| `POST` | `/sync` | Runs a sync. When `SYNC_API_KEY` is set, send it in the `X-Api-Key` header. |

`SYNC_INTERVAL_MINUTES` is a local timer only. Set it to `0` where the process should not poll. The scheduled job is the GitHub Action.

## Daily sync

`.github/workflows/daily-sync.yml` runs at 00:05 UTC. With `SYNC_ON_START=true`, the first successful run reads `SYNC_LOOKBACK_DAYS` (default 90). After that, each run reads the whole previous UTC day. You can also run the workflow by hand and pass a `YYYY-MM-DD` day.

Add these repository secrets before the workflow can succeed:

- `META_ACCESS_TOKEN`, `META_PAGE_ID`
- `META_ACCESS_TOKEN_2`, `META_PAGE_ID_2`
- `DATABASE_URL` (`mysql://...`)
- `SYNC_ON_START`, `SYNC_LOOKBACK_DAYS`
- `META_GRAPH_VERSION`, `META_FORM_IDS`, `META_CAMPAIGN_FILTER`, and `META_FORM_FILTER` when you use them

The MySQL host must allow connections from GitHub-hosted runners. Those runners do not keep a fixed IP address.

## What stays out of git

`.env`, CSV exports, SQL dumps, and database files are ignored. Keep tokens and the live database URL in `.env` locally and in GitHub Actions secrets for the scheduled job.
