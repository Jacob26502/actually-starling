import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { config, findProfile } from './config.ts';
import { createAccount, importTransactions, listAccounts, shutdown } from './actual.ts';
import { invalidateMapping, isUsable, loadMapping, resolveAccount, saveMapping } from './mapping.ts';
import {
	discoverCategories,
	getFeedItemsBetween,
	profilesWithWebhookSecret,
	resolveWebhookProfile,
	type FeedItem,
	type FeedItemWebhookPayload,
} from './starling.ts';
import { toActualTransaction } from './transform.ts';

const app = new Hono();

app.get('/health', (c) => c.json({ ok: true }));

/**
 * Starling feed-item webhook.
 *
 * Responds only after the transaction has been written to Actual: a 5xx makes Starling
 * retry, which is what we want for transient failures. Cases that will never succeed
 * (unknown category, non-transaction event) return 2xx so Starling stops resending.
 */
app.post('/webhook', async (c) => {
	// Signature is over the exact bytes received, so read the raw body before parsing.
	const rawBody = await c.req.text();

	if (profilesWithWebhookSecret().length === 0) {
		console.error('[webhook] no STARLING_<name>_WEBHOOK_SECRET configured — refusing unverifiable request');
		return c.json({ error: 'webhook secret not configured' }, 500);
	}

	// Each Starling account signs with its own secret, so try them all.
	const profile = resolveWebhookProfile(rawBody, c.req.header('X-Hook-Signature'));
	if (!profile) {
		console.warn('[webhook] rejected request: signature matched no configured secret');
		return c.json({ error: 'invalid signature' }, 401);
	}

	let payload: FeedItemWebhookPayload;
	try {
		payload = JSON.parse(rawBody) as FeedItemWebhookPayload;
	} catch {
		return c.json({ error: 'invalid JSON' }, 400);
	}

	const item = payload.content;
	if (!item?.feedItemUid || !item.categoryUid) {
		console.warn('[webhook] payload has no feed item content, ignoring');
		return c.json({ status: 'ignored', reason: 'not a feed item event' });
	}

	const mapped = await resolveAccount(item.categoryUid);
	if (!mapped) {
		console.warn(
			`[webhook] no mapping for categoryUid ${item.categoryUid} (feedItem ${item.feedItemUid}) — run GET /discover`,
		);
		return c.json({ status: 'skipped', reason: 'unmapped category', categoryUid: item.categoryUid });
	}

	const converted = toActualTransaction(item);
	if (!converted.ok) {
		console.warn(`[webhook] skipped ${item.feedItemUid}: ${converted.reason}`);
		return c.json({ status: 'skipped', reason: converted.reason });
	}

	const result = await importTransactions(mapped.actualAccountId, [converted.transaction]);
	console.log(
		`[webhook] ${profile.name}/${item.feedItemUid} → ${mapped.label ?? mapped.actualAccountId}: ` +
			`+${result.added} added, ${result.updated} updated`,
	);
	return c.json({ status: 'ok', ...result });
});

/**
 * Lists every Starling (account, space) alongside the Actual accounts, showing which
 * categoryUids are already mapped. Use this to write config/mapping.json.
 */
app.get('/discover', async (c) => {
	const [categories, actualAccounts, mapping] = await Promise.all([
		discoverCategories(),
		listAccounts(),
		loadMapping(),
	]);

	return c.json({
		budgetCurrency: config.budgetCurrency,
		starling: categories.map((category) => ({
			...category,
			mappedTo: mapping.categories[category.categoryUid]?.actualAccountId || null,
			// Flagged rather than hidden: these can't be imported into a single-currency budget.
			currencyMismatch: Boolean(category.currency) && category.currency !== config.budgetCurrency,
		})),
		actualAccounts: actualAccounts
			.filter((account) => !account.closed)
			.map(({ id, name, offbudget }) => ({ id, name, offbudget })),
		unmapped: categories
			.filter((category) => !isUsable(mapping.categories[category.categoryUid]))
			.map((category) => ({ categoryUid: category.categoryUid, label: category.label })),
	});
});

app.post('/mapping/reload', async (c) => {
	invalidateMapping();
	const mapping = await loadMapping();
	return c.json({ status: 'reloaded', categories: Object.keys(mapping.categories).length });
});

/**
 * Create an Actual account for every Starling category that doesn't have a usable one yet,
 * and write the ids back into the mapping file. Saves hand-copying UUIDs.
 *
 * Body: { "prefix"?: "Starling ", "profiles"?: ["primary"], "dryRun"?: true }
 * Existing mappings and entries marked `enabled: false` are left alone, so this is safe to
 * re-run after adding a Space. Names are prefixed with the profile when several are in play,
 * since "Main" collides across accounts.
 */
app.post('/mapping/bootstrap', async (c) => {
	type BootstrapBody = { prefix?: string; profiles?: string[]; dryRun?: boolean };
	const body: BootstrapBody = await c.req.json<BootstrapBody>().catch(() => ({}) as BootstrapBody);
	const prefix = body.prefix ?? 'Starling ';

	const [allCategories, existingAccounts, mapping] = await Promise.all([
		discoverCategories(),
		listAccounts(),
		loadMapping(),
	]);

	const categories = body.profiles?.length
		? allCategories.filter((category) => body.profiles!.includes(category.profile))
		: allCategories;

	const multiProfile = new Set(categories.map((category) => category.profile)).size > 1;
	const byName = new Map(existingAccounts.map((account) => [account.name.toLowerCase(), account]));
	const next = { categories: { ...mapping.categories } };
	const results: Record<string, unknown>[] = [];

	for (const category of categories) {
		const current = next.categories[category.categoryUid];
		if (isUsable(current)) continue;
		// Respect a deliberate opt-out instead of creating an account for it anyway.
		if (current?.enabled === false) continue;

		// Don't create an account that could never receive transactions.
		if (category.currency && category.currency !== config.budgetCurrency) {
			results.push({
				profile: category.profile,
				label: category.label,
				action: 'skipped',
				reason: `currency ${category.currency} does not match budget currency ${config.budgetCurrency}`,
			});
			continue;
		}

		const generated = multiProfile ? `${prefix}${category.profile} ${category.label}` : `${prefix}${category.label}`;
		const name = current?.accountName ?? generated;
		// Reuse an identically named account if one already exists, rather than duplicating it.
		const existing = byName.get(name.toLowerCase());

		if (body.dryRun) {
			results.push({
				profile: category.profile,
				label: category.label,
				name,
				action: existing ? 'would reuse' : 'would create',
			});
			// Record it so a later category sharing this accountName reports "would reuse" too.
			if (!existing) byName.set(name.toLowerCase(), { id: `pending:${name}`, name });
			continue;
		}

		const actualAccountId = existing?.id ?? (await createAccount(name));
		// Must go in before the next iteration, or two categories sharing an accountName
		// would each create their own account.
		byName.set(name.toLowerCase(), { id: actualAccountId, name });

		next.categories[category.categoryUid] = {
			...current,
			actualAccountId,
			label: category.label,
			profile: category.profile,
			starlingAccountUid: category.accountUid,
			kind: category.kind,
		};
		results.push({
			profile: category.profile,
			label: category.label,
			name,
			actualAccountId,
			action: existing ? 'reused' : 'created',
		});
	}

	if (!body.dryRun) await saveMapping(next);

	return c.json({ status: body.dryRun ? 'dry-run' : 'ok', accounts: results });
});

/**
 * Historical import. Body: { "from": "2024-01-01", "to": "2024-12-31", "categoryUid"?: "..." }
 * Omit `categoryUid` to backfill every mapped category. `to` defaults to now.
 */
app.post('/backfill', async (c) => {
	const body = await c.req.json<{ from?: string; to?: string; categoryUid?: string }>().catch(() => ({}) as never);
	if (!body.from) return c.json({ error: 'body must include "from" (e.g. "2024-01-01")' }, 400);

	const from = new Date(body.from);
	const to = body.to ? new Date(body.to) : new Date();
	if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
		return c.json({ error: 'could not parse "from"/"to" as dates' }, 400);
	}
	if (from > to) return c.json({ error: '"from" is after "to"' }, 400);

	const mapping = await loadMapping();
	const categories = await discoverCategories();
	const targets = categories.filter((category) => {
		if (body.categoryUid && category.categoryUid !== body.categoryUid) return false;
		return isUsable(mapping.categories[category.categoryUid]);
	});

	if (targets.length === 0) {
		return c.json(
			{ error: 'no mapped Starling categories matched — run POST /mapping/bootstrap or fill in config/mapping.json' },
			400,
		);
	}

	const report: Record<string, unknown>[] = [];
	for (const target of targets) {
		const entry = mapping.categories[target.categoryUid]!;
		const profile = findProfile(target.profile);
		if (!profile) {
			report.push({ label: target.label, error: `no configured token for profile "${target.profile}"` });
			continue;
		}
		let fetched = 0;
		const transactions = [];
		// Aggregated so a wholly-skipped account (e.g. wrong currency) is obvious, not silent.
		const skipReasons = new Map<string, number>();

		// Starling caps how wide a transactions-between window may be, so walk it in months.
		for (const [windowStart, windowEnd] of monthlyWindows(from, to)) {
			const items: FeedItem[] = await getFeedItemsBetween(
				profile,
				target.accountUid,
				target.categoryUid,
				windowStart.toISOString(),
				windowEnd.toISOString(),
			);
			fetched += items.length;
			for (const item of items) {
				const converted = toActualTransaction(item);
				if (converted.ok) transactions.push(converted.transaction);
				else skipReasons.set(converted.reason, (skipReasons.get(converted.reason) ?? 0) + 1);
			}
		}

		const result = await importTransactions(entry.actualAccountId, transactions);
		const skipped = Object.fromEntries(skipReasons);
		console.log(
			`[backfill] ${target.profile}/${target.label}: fetched ${fetched}, added ${result.added}, ` +
				`updated ${result.updated}${skipReasons.size ? `, skipped ${JSON.stringify(skipped)}` : ''}`,
		);
		report.push({
			profile: target.profile,
			label: target.label,
			categoryUid: target.categoryUid,
			fetched,
			...result,
			...(skipReasons.size ? { skipped } : {}),
		});
	}

	return c.json({ status: 'ok', from: from.toISOString(), to: to.toISOString(), results: report });
});

app.onError((err, c) => {
	console.error('[error]', err);
	// 5xx signals Starling to retry the webhook later.
	return c.json({ error: err.message }, 500);
});

/** Split [from, to] into consecutive month-long windows. */
function monthlyWindows(from: Date, to: Date): [Date, Date][] {
	const windows: [Date, Date][] = [];
	let cursor = from;
	while (cursor < to) {
		const next = new Date(cursor);
		next.setUTCMonth(next.getUTCMonth() + 1);
		windows.push([cursor, next > to ? to : next]);
		cursor = next;
	}
	return windows;
}

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
	console.log(`[server] listening on http://localhost:${info.port}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
	process.on(signal, () => {
		server.close();
		void shutdown().then(() => process.exit(0));
	});
}
