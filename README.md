# actually-starling

Syncs [Starling Bank](https://www.starlingbank.com/) transactions into [Actual Budget](https://actualbudget.org/) — historical backfill plus live webhook sync, with each Starling account and Space mapped to its own Actual account.

## Setup

```txt
bun install
cp .env.example .env          # fill in Starling tokens + Actual server details
bun run dev
```

### Starling tokens

A Starling personal access token is scoped to **one account holder** — and personal vs business are separate account holders. So create one token per account you want to sync and list them as named profiles:

```txt
STARLING_ACCOUNTS=primary,secondary
STARLING_PRIMARY_TOKEN=...
STARLING_PRIMARY_WEBHOOK_SECRET=...
STARLING_SECONDARY_TOKEN=...
STARLING_SECONDARY_WEBHOOK_SECRET=...
```

Names are arbitrary labels. Anything you leave out simply isn't synced — that's how you exclude an account.

### 1. Build the account mapping

With the server running, ask it what it can see:

```txt
curl -s localhost:3000/discover | jq
```

This lists every Starling `(accountUid, categoryUid)` across all configured tokens — your main accounts *and* every Space — next to your Actual accounts, with the `profile` each came from.

Then create the matching Actual accounts and fill in the ids automatically:

```txt
curl -X POST localhost:3000/mapping/bootstrap -d '{"dryRun":true}'   # preview
curl -X POST localhost:3000/mapping/bootstrap                        # do it
```

This creates one Actual account per Starling category (named `Starling <label>`, or `Starling <profile> <label>` when several profiles are configured; override with `"prefix"`), reuses any account that already has that name, and writes the ids into `config/mapping.json`. Restrict it with `{"profiles":["primary"]}`. It never overwrites an existing mapping and skips entries marked `"enabled": false`, so it's safe to re-run after adding a Space.

To wire things up by hand instead, fill in `actualAccountId` yourself — the file is keyed by `categoryUid`:

```json
{
  "categories": {
    "<categoryUid>": { "actualAccountId": "<actual account id>", "label": "Main" }
  }
}
```

`POST /mapping/reload` picks up manual edits without a restart. Set `"enabled": false` on an entry to deliberately ignore a Space; a blank `actualAccountId` counts as unmapped.

### 2. Backfill history

```txt
curl -X POST localhost:3000/backfill \
  -H 'Content-Type: application/json' \
  -d '{"from":"2024-01-01"}'
```

Backfills every mapped category (add `"categoryUid"` to limit it to one, `"to"` to bound the range). Safe to re-run — Actual reconciles on Starling's `feedItemUid`, so repeats don't duplicate.

### 3. Register the webhook

In the [Starling developer portal](https://developer.starlingbank.com), point a feed-item webhook at `https://your-host/webhook` and copy the shared secret into `STARLING_<NAME>_WEBHOOK_SECRET` for that profile. Starling requires HTTPS, so put this behind a reverse proxy or tunnel.

## Docker

```txt
cp .env.example .env    # fill in real values, as above
docker compose up -d --build
```

This mounts `./config` (so `mapping.json` — created by `/mapping/bootstrap` or by hand — lives on the host, not in the image) and a named volume for the downloaded budget cache. The container always listens on `3000` internally; set `HOST_PORT` in `.env` to change the published port.

Don't run `docker compose config` without `--no-interpolate` against your real `.env` — it prints every resolved secret (Starling token, webhook secret, Actual password) in plaintext.

## Routes

| Route                     | Purpose                                              |
| ------------------------- | ---------------------------------------------------- |
| `POST /webhook`           | Starling feed-item webhook (signature-verified)      |
| `POST /backfill`          | Historical import over a date range                  |
| `GET  /discover`          | Starling accounts/Spaces + Actual accounts + mapping |
| `POST /mapping/bootstrap` | Create missing Actual accounts, fill in the mapping  |
| `POST /mapping/reload`    | Re-read `config/mapping.json`                        |
| `GET  /health`            | Liveness check                                       |

## Scripts

- `bun run dev` — watch mode
- `bun run start` — run once
- `bun run typecheck` — `tsc --noEmit`
