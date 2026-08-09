# actually-starling

Syncs [Starling Bank](https://www.starlingbank.com/) transactions into [Actual Budget](https://actualbudget.org/) — historical backfill plus live webhook sync, with each Starling account and Space mapped to its own Actual account.

## Setup

Requires Node ≥22.18. Package management is via bun (`bun install`, `bun.lock`), but the server itself runs on Node, not `bun run` — a core dependency (`@actual-app/api`, via `better-sqlite3`) needs a native module Bun doesn't support yet. `bun run dev`/`bun run start` just invoke `node --env-file=.env ...` under the hood, so this is transparent day to day; see `CLAUDE.md` if you're curious why.

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
STARLING_PRIMARY_WEBHOOK_PUBLIC_KEY=...
STARLING_SECONDARY_TOKEN=...
STARLING_SECONDARY_WEBHOOK_PUBLIC_KEY=...
```

Names are arbitrary labels. Anything you leave out simply isn't synced — that's how you exclude an account.

### 1. Build the account mapping

With the server running, ask it what it can see:

```txt
curl -s localhost:3000/discover | jq
```

This lists every Starling `(accountUid, categoryUid)` across all configured tokens — your main accounts *and* every Space — next to your Actual accounts, with the `profile` each came from. An Actual budget is single-currency (`BUDGET_CURRENCY`, default `GBP`); categories in any other currency are flagged with `currencyMismatch: true` and can't be synced — a Starling account with a EUR balance can't feed a GBP budget without silently misrepresenting amounts, so it's refused rather than imported at face value.

Then create the matching Actual accounts and fill in the ids automatically:

```txt
curl -X POST localhost:3000/mapping/bootstrap -d '{"dryRun":true}'   # preview
curl -X POST localhost:3000/mapping/bootstrap                        # do it
```

This creates one Actual account per Starling category (named `Starling <label>`, or `Starling <profile> <label>` when several profiles are configured; override with `"prefix"`), reuses any account that already has that name, and writes the ids into `config/mapping.json`. Restrict it with `{"profiles":["primary"]}`. It never overwrites an existing mapping, skips entries marked `"enabled": false`, and skips currency-mismatched categories — so it's safe to re-run after adding a Space.

To wire things up by hand instead, fill in `actualAccountId` yourself — the file is keyed by `categoryUid`:

```json
{
  "categories": {
    "<categoryUid>": { "actualAccountId": "<actual account id>", "label": "Main" }
  }
}
```

`POST /mapping/reload` picks up manual edits without a restart. Set `"enabled": false` on an entry to deliberately ignore a Space; a blank `actualAccountId` counts as unmapped. Give two categories the same `"accountName"` to collapse them into one Actual account instead of one each — useful when a Space's balance really lives inside a single account you'd rather see as one line (e.g. a savings account and its one Space), rather than as noise.

### 2. Backfill history

```txt
curl -X POST localhost:3000/backfill \
  -H 'Content-Type: application/json' \
  -d '{"from":"2024-01-01"}'
```

Backfills every mapped category (add `"categoryUid"` to limit it to one, `"to"` to bound the range). Safe to re-run — Actual reconciles on Starling's `feedItemUid`, so repeats don't duplicate.

Transactions are also categorized automatically: Starling's own `spendingCategory` (e.g. `EATING_OUT`) is turned into an Actual category (`Eating Out`) under a single "Starling" category group, created the first time each one is actually seen. If you're backfilling transactions imported *before* this existed, re-running `/backfill` retroactively fills in their categories too — but only once; a category, once set (by this or by hand in Actual), won't be overwritten on a later re-run.

Each account's balance is *meant* to also be forced to match Starling's real current balance — otherwise real history predating your backfill's start date would make the account look like it starts from £0 (often going negative) instead of reflecting what was really there. **This is currently disabled**: the working mechanism (a synthetic adjustment transaction, recomputed on every run) is commented out in favor of a direct `updateAccount` call that's expected not to actually change anything — see `CLAUDE.md` if you want to re-enable the version that works. The response's `balanceAdjustments` array shows `action: "attempted"` either way, which doesn't confirm success — check the account's balance in Actual directly.

Transfers between your own mapped accounts/Spaces (moving money into a savings goal, for example) are detected and linked as a single Actual transfer — not left as two separate transactions that both count as spending/income. This works across `/webhook` and `/backfill` regardless of which side arrives first; whichever leg lands second finds the other and completes the link. Only works between two *different* Actual accounts — a Space merged into its parent via a shared `accountName` in `mapping.json` doesn't need linking, since both sides already land in the same account.

Transactions can also be modified with your own simple rules (`config/rules.json`) — e.g. "if the note contains 'round up', categorize as Round Up" — matched against Starling's raw fields (`userNote`, `reference`, `counterPartyName`, `spendingCategory`, `source`; case-insensitive substring match) and applied in both `/webhook` and `/backfill`, before Starling's own category is resolved. `POST /rules/reload` picks up edits without a restart. This is separate from — and doesn't interact with — Actual's own rules feature, which never runs on anything this app imports (see `CLAUDE.md`).

### 3. Register the webhook

In the [Starling developer portal](https://developer.starlingbank.com), point a feed-item webhook at `https://your-host/webhook` and copy the webhook's public key (base64 DER/SPKI) into `STARLING_<NAME>_WEBHOOK_PUBLIC_KEY` for that profile — Starling's V2 webhook security signs each payload with SHA512withRSA using the *private* half of that key pair, so despite the field sometimes being labeled "secret" it is not an HMAC key. Starling requires HTTPS, so put this behind a reverse proxy or tunnel.

## Docker

```txt
cp .env.example .env    # fill in real values, as above
docker compose up -d --build
```

This mounts `./config` (so `mapping.json` — created by `/mapping/bootstrap` or by hand — lives on the host, not in the image) and a named volume for the downloaded budget cache. The container always listens on `3000` internally; set `HOST_PORT` in `.env` to change the published port.

The image installs with `npm ci` against the committed `package-lock.json`, not `bun install` — bun's installer can't resolve a working `better-sqlite3` build inside a container (falls back to compiling it, which then fails with no Python on the slim image). If you change dependencies in `package.json`, regenerate `package-lock.json` too: `npm install --package-lock-only` (alongside your normal `bun install`; the two lockfiles are independent).

Don't run `docker compose config` without `--no-interpolate` against your real `.env` — it prints every resolved secret (Starling token, webhook public key, Actual password) in plaintext.

## Routes

| Route                     | Purpose                                              |
| ------------------------- | ---------------------------------------------------- |
| `POST /webhook`           | Starling feed-item webhook (signature-verified)      |
| `POST /backfill`          | Historical import over a date range                  |
| `GET  /discover`          | Starling accounts/Spaces + Actual accounts + mapping |
| `POST /mapping/bootstrap` | Create missing Actual accounts, fill in the mapping  |
| `POST /mapping/reload`    | Re-read `config/mapping.json`                        |
| `POST /rules/reload`      | Re-read `config/rules.json`                          |
| `GET  /health`            | Liveness check                                       |

## Scripts

- `bun run dev` — watch mode
- `bun run start` — run once
- `bun run typecheck` — `tsc --noEmit`
