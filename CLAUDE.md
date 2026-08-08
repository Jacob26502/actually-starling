# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Node service that syncs [Starling Bank](https://www.starlingbank.com/) transactions into [Actual Budget](https://actualbudget.org/) — the name "actually-starling" = Actual + Starling. It does two things:

1. **Backfill** — `POST /backfill` pulls historical feed items over a date range.
2. **Live sync** — `POST /webhook` receives Starling feed-item webhooks as transactions happen.

Reference docs:

- Starling API: https://developer.starlingbank.com/docs
- Actual Budget API: https://actualbudget.org/docs/api/reference

## Commands

Package manager is bun (`bun.lock` is the lockfile).

- `bun install` — install dependencies
- `bun run dev` — watch-mode server (`node --env-file=.env --watch src/index.ts`)
- `bun run start` — run once
- `bun run typecheck` — `tsc --noEmit`

No test suite or linter is configured.

## This is NOT a Cloudflare Worker — don't try to make it one

It started as one (`wrangler.jsonc`, `hono/adapter`), and that was removed because it fundamentally cannot work: `@actual-app/api` does `require("better-sqlite3")` at `dist/index.js:46`, a **native `.node` binary**, and needs a real filesystem for its `dataDir` budget cache. No `nodejs_compat` flag fixes either. If edge hosting is ever wanted again, the Worker must be a thin signature-verifying proxy that forwards to a Node process — the Actual writes cannot happen at the edge.

Consequences for how the code is written:

- Runs on Node ≥22.18 using **native TypeScript type stripping** — no build step, no `tsx`. This is why `tsconfig.json` sets `erasableSyntaxOnly` and why relative imports carry explicit `.ts` extensions (`./config.ts`). Constructor parameter properties (`constructor(private x: T)`) and `enum` will fail to compile.
- Env vars come from `process.env` via `node --env-file=.env`, not `hono/adapter` and not `dotenv`.

### The runtime also can't be Bun, for the same underlying reason

Tried 2026-08-08: `bun run src/index.ts` imports `@actual-app/api` fine, but `downloadBudget()` fails at `ERR_DLOPEN_FAILED` — Bun's own error is explicit: `'better-sqlite3' is not yet supported in Bun` ([oven-sh/bun#4290](https://github.com/oven-sh/bun/issues/4290)). Worse, `@actual-app/api` swallows that error internally, so `downloadBudget()` returns without throwing and the failure only surfaces later as `"No budget file is open"` — meaning under Bun the server looks like it started fine while every write silently fails.

Swapping the driver for `bun:sqlite` (Bun's built-in SQLite) was also evaluated and is a dead end, not just more work: `bun:sqlite`'s `Database` has no `.function()` method at all, and `openDatabase()` in `@actual-app/api`'s bundled `dist/index.js` registers five custom SQL functions on the connection (`UNICODE_LOWER`, `UNICODE_UPPER`, `UNICODE_LIKE`, `REGEXP`, `NORMALISE`) that the query engine relies on throughout. There's no userspace shim for a missing C-level SQLite feature. (`.backup()`, used by `exportDatabase()`, is also absent.) Patching around this would mean altering behavior inside Actual's own ~120k-line bundled query engine against real financial data with no way to verify correctness — not worth it. Package management stays on bun (`bun install`, `bun.lock`); only the runtime is Node. Don't re-attempt this without checking whether upstream `bun:sqlite` has gained custom-function support.

This isn't just a runtime-import issue either — the Docker build itself briefly used `oven/bun:1-slim` to install deps (Node ran the container, bun just resolved packages), and that also failed: bun's `prebuild-install` can't resolve a matching prebuilt binary for `better-sqlite3` under bun, falls back to `node-gyp rebuild`, which then fails on a slim image with no Python. So the Dockerfile's builder stage is plain Node/npm too — see below.

## Docker

`Dockerfile` is a two-stage **Node-only** build (`node:22-slim` for both stages): the `deps` stage runs `npm ci` against a committed `package-lock.json`, then `runtime` copies `node_modules` across. This diverges from local dev, which uses `bun install`/`bun.lock` — the two lockfiles can drift, so if `package.json`'s dependencies change, regenerate `package-lock.json` too (`npm install --package-lock-only`, without touching the bun-managed `node_modules` on the host).

`docker-compose.yml` mounts two things that must **not** be baked into the image: `./config` (holds `mapping.json`, which contains your personal account UUIDs and is gitignored) and a named volume for `.actual-cache` (the downloaded budget SQLite file — losing it just means Actual re-downloads on next start, not data loss, since the source of truth is the Actual server). `PORT`/`ACTUAL_DATA_DIR`/`MAPPING_PATH` are pinned in `environment:` rather than left to a mounted `.env`, so the container-internal port always matches the compose `ports:` mapping regardless of what a stray `.env` says.

`CMD` uses `--env-file-if-exists=.env` (Node ≥21.7/22.9), not `--env-file=.env` — the latter errors if the file is absent, but the normal path here is `docker compose`/`docker run -e` injecting env vars directly into `process.env`, with no `.env` file in the container at all.

**Never run `docker compose config` (without `--no-interpolate`) against the real `.env`** — it resolves and prints every secret in plaintext to stdout, including the Starling token and Actual server password.

## Architecture

Request flow: `src/index.ts` (routes) → `src/mapping.ts` (which Actual account?) → `src/transform.ts` (shape conversion) → `src/actual.ts` (write).

- **`src/starling.ts`** — typed `fetch` client plus webhook signature verification. Deliberately does **not** use the installed-then-removed `starling-developer-sdk`: it returns `Promise<any>` throughout, pulls in axios, and has no Spaces endpoint. Don't reintroduce it.
- **`src/mapping.ts`** — `categoryUid` → Actual account. Cached in memory; `POST /mapping/reload` clears it.
- **`src/transform.ts`** — feed item → Actual transaction. Pure and unit-testable.
- **`src/actual.ts`** — owns the `@actual-app/api` lifecycle and serialises access.
- **`src/categories.ts`** — Starling `spendingCategory` → Actual category, created lazily.
- **`src/balance.ts`** — forces an Actual account's balance to match Starling's real one via a synthetic adjustment transaction (backfill only excludes pre-cutoff history, not pre-cutoff *balance*).

### One Starling token per account holder ("profiles")

A Starling personal access token is scoped to a **single account holder**, and personal vs business are *separate account holders* — so `GET /api/v2/accounts` on one token can never return another holder's accounts. Covering several real-world accounts therefore requires several tokens.

Tokens are configured as named profiles:

```
STARLING_ACCOUNTS=primary,secondary
STARLING_PRIMARY_TOKEN=...
STARLING_PRIMARY_WEBHOOK_SECRET=...
```

`config.starling.profiles` is the parsed list; `findProfile(name)` looks one up. Names are arbitrary labels. Every Starling call takes a `StarlingProfile` as its first argument — there is no implicit "current token".

Because each Starling account registers its own webhook with its own secret, `/webhook` is a single endpoint that tries every configured secret via `resolveWebhookProfile()` and reports which one matched. A profile with no secret can never match, so it can be listed for backfill-only use.

### Mapping is keyed on `categoryUid`, not `accountUid`

Every Starling account has a primary category, and **every Space (Savings Goal / Spending Space) has its own `categoryUid`**. That pair `(accountUid, categoryUid)` is what Starling's feed endpoints address, and each one maps to a **separate Actual account** so balances reconcile 1:1.

The mapping key is `categoryUid` alone because **`accountUid` is frequently absent from webhook payloads** — feed items are normally fetched through a URL that already contains it, so it's redundant there and not guaranteed. `categoryUid` is globally unique and always present. Don't "improve" this to a composite key without checking real payloads first.

`GET /discover` exists to build this config: it enumerates Starling categories, lists Actual accounts, and flags unmapped ones. `POST /mapping/bootstrap` then creates any missing Actual accounts and writes their ids back to the file. Spaces come from `/api/v2/account/{uid}/spaces`, falling back to legacy `/savings-goals` on 404/403 — the exact `/spaces` response schema is not publicly documented, so the parsing is intentionally tolerant of both `savingsGoals` and `spendingSpaces`.

An entry counts as mapped only when `isUsable()` passes: `actualAccountId` non-empty **and** `enabled !== false`. A blank id means "discovered but not wired up yet", which is what bootstrap fills in — so never treat mere key presence as mapped. `isUsable` is deliberately *not* a TypeScript type guard: narrowing a blank-id entry out of the false branch would type it as `never` and break the `enabled === false` check.

Bootstrap skips both usable entries and ones explicitly marked `enabled: false`, so opting a Space out survives a re-run. It also prefixes account names with the profile when more than one profile is in play, because labels like "Main" collide across accounts.

### Details that are easy to get wrong

- **`@actual-app/api` is a process-wide singleton** over one local SQLite file. Concurrent writes race. All access must go through `withActual()` in `src/actual.ts`, which chains calls into a serial queue. Never call the API directly from a route.
- **`downloadBudget(syncId, { password })` is positional** — the published web docs show an object argument, which is wrong. Trust `node_modules/@actual-app/api/@types/methods.d.ts` over the website.
- **Amount signs**: Starling's `amount.minorUnits` is always positive and `direction` (`IN`/`OUT`) carries the sign; Actual wants signed minor units, negative for outflow.
- **An Actual budget is single-currency.** Starling accounts can be in other currencies (there's a real EUR account on this token), and minor units are indistinguishable across currencies — €50.00 and £50.00 are both `5000`. So `toActualTransaction` refuses any feed item whose `amount.currency` isn't `BUDGET_CURRENCY` (default GBP), and bootstrap won't create accounts for mismatched categories. Note this checks `amount` (the *account's* currency), not `sourceAmount` — a GBP card used abroad has a foreign `sourceAmount` and must still import, with the original noted.
- **`toActualTransaction` returns `{ ok, transaction | reason }`**, not `null`, so skips are explainable. Backfill aggregates reasons per account, which is what makes "every transaction in this account was refused" visible instead of looking like an empty account.
- **Dates need timezone conversion, not string slicing.** Starling timestamps are UTC. A 00:30 BST transaction is `23:30Z` the previous day, so `.slice(0, 10)` lands it on the wrong day. `toActualDate()` formats via `Intl` in `STARLING_TIMEZONE` (default `Europe/London`); `en-CA` conveniently yields `YYYY-MM-DD`.
- **Dedupe is `imported_id = feedItemUid`** with `importTransactions` (not `addTransactions`), so Actual reconciles rather than duplicating — a PENDING item later becomes SETTLED in place, and re-running a backfill is a no-op.
- **Webhook signature is over the raw body**: `base64(sha512(secret + rawBody))` in `X-Hook-Signature`. Read `c.req.text()` and verify *before* parsing — re-serialised JSON won't match. Compared with `timingSafeEqual`.
- **Webhook status codes are deliberate**: 5xx makes Starling retry, so permanent conditions (unmapped category, `DECLINED`/`ACCOUNT_CHECK` status, non-feed-item event) return **2xx** to stop redelivery. Only genuine transient failures should 5xx. The route intentionally writes to Actual *before* responding rather than backgrounding the work.
- **Backfill walks the range in monthly windows** because Starling limits how wide a `transactions-between` query may be.

### Categories: Starling's `spendingCategory` → Actual, lazily

Every feed item carries a `spendingCategory` (`EATING_OUT`, `FUEL`, `GROCERIES`, ...) — Starling's own spending-insights classification, a large fixed enum (~150+ values across personal *and* business accounts, not published anywhere; empirically ~30 show up on a real personal account over a year). `src/categories.ts` resolves these to real Actual category ids **lazily**: the first time a given value is actually seen, it creates (or reuses, by name) a category under a single "Starling" category group, then caches the id in memory for the process lifetime. This deliberately avoids pre-declaring the full enum — most of it (business/accounting categories like `VAT`, `DIRECTORS_WAGES`) can never occur on a personal-only token anyway, so lazy creation naturally converges on exactly what's needed.

`humanizeSpendingCategory()` turns `EATING_OUT` into `Eating Out`. `INCOME`/`REVENUE`/`OTHER_INCOME` get created with `is_income: true`; everything else `is_income: false`.

**`resolveCategory`/`resolveCategories`/`resolveTransactionCategory` must run to completion *before* `actual.ts`'s `importTransactions` is called, never from inside it.** `ensureCategoryGroup`/`ensureCategory` each go through `withActual()`, which is a serial promise-chain queue, not reentrant — calling it from a callback that's already running inside another `withActual()` call deadlocks (the inner call waits on the queue tail, which can't advance until the outer call, which is waiting on the inner call, finishes). This is why category resolution happens as a distinct step in `index.ts`'s route handlers, not inside `actual.ts`.

`transform.ts` stays pure: it puts the *raw* Starling string on `ActualTransaction.spendingCategory`, not a resolved id — resolving it requires an Actual API call, which would make `toActualTransaction` impure. `actual.ts`'s `importTransactions` strips `spendingCategory` back off before sending to `actualApi.importTransactions`, since by then it's expected to have already been resolved into `category`.

**Existing imported transactions can be retroactively categorized for free, but only once.** Actual's reconciliation (`reconcileTransactions` in the bundled `dist/index.js`) does `category: existing.category || trans.category || null` on a matched transaction — the existing value wins if set. Since transactions imported before this feature existed all have `category: null`, re-running `/backfill` fills them in. Once any transaction has a category (from us or a manual edit in Actual's UI), future backfills won't touch it again — this is correct/intentional, not a bug, but means the free retroactive pass is a one-time window.

**Rules do not run on anything this app imports.** Verified against source, not the docs: this project's `importTransactions()` calls straight into `reconcileTransactions`, which has no rules step at all. The *other* Actual API method, `addTransactions()` (deliberately unused here), explicitly calls `runRules(...)` — that's the one rules-aware path, and it's not the one this project uses. There's also no API-exposed way to trigger rules on demand; it's UI-only in Actual today. Don't build a "run my rules after sync" feature without first re-verifying this against whatever `@actual-app/api` version is actually installed — it could change upstream.

### Forcing an account's balance to match Starling (`src/balance.ts`)

**`updateAccount(id, fields)` cannot set a balance, even though `balance_current` is technically part of its accepted type.** Verified against source: the real underlying function only ever writes `{id, name, last_reconciled}` — anything else, `balance_current` included, is silently discarded, not an error. For a normal (non-bank-synced) account, balance isn't stored at all; `getAccounts()`/`getAccountBalance()` compute it live as `SUM(amount)` over the account's transactions. The only direct DB write to `balance_current` (`updateAccountBalance()`) isn't exposed by `@actual-app/api` at all — it's reserved for bank-sync-linked accounts (GoCardless/SimpleFin) caching the bank's own reported figure separately from the local ledger, which doesn't apply to accounts this project creates.

So `src/balance.ts` achieves "set the balance" the only way that actually works: a single synthetic **adjustment transaction** for the delta between Actual's computed balance and Starling's real one, dated the day before the backfill's `from` cutoff. This exists because backfilling from a cutoff necessarily excludes everything before it — an account with real history predating that cutoff would otherwise show a balance of just the imported transactions (often confusingly negative), not the account's actual balance.

- **Recomputed fresh on every `/backfill` call, not created once and left alone.** `importTransactions`' reconciliation never touches `amount` on an existing match (same `reconcileTransactions` code as above — `amount` isn't in its `updates` object at all), so a stale adjustment from a previous run can't be corrected by just re-importing it. `reconcileAccountBalance()` finds the existing adjustment (a fixed `imported_id: 'starling-balance-adjustment'`), backs its current contribution out of the account's computed balance, recomputes the delta fresh, and calls `updateTransactionAmount()` — a direct `actualApi.updateTransaction(id, {amount})` — which *does* apply unconditionally (`{...existing, ...fields}`, no field filtering, unlike `updateAccount`).
- **Grouped by `actualAccountId` across every mapped category, not just the ones a particular `/backfill` call touches.** Two Starling categories can share one Actual account (e.g. `Easy Saver` + its `Car` Space, collapsed via a shared `accountName` in `mapping.json`) — their real balances must be summed before reconciling, never applied one after another, or reconciling just one of them would silently erase the other's share. Scoping a backfill to a single `categoryUid` still reconciles balance using the *complete* mapped set for whichever account that category belongs to.
- Uses Starling's `clearedBalance` for main accounts (the spendable pot only) rather than `totalClearedBalance` (which also includes money already sitting in that account's Spaces — using it would double-count balances already tracked as their own separate mapped categories). Spaces use their own `totalSaved`/`balance` from the same `/spaces` or `/savings-goals` call `discoverCategories()` already makes — no extra request needed, that data was already being fetched and discarded before this feature existed.

### Known limitation

A transfer between two mapped Spaces produces two independent feed items, so it lands in Actual as two unlinked transactions rather than one transfer. Linking them would require correlating the pair and setting `transfer_id`.
