import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { config, findProfile } from './config.ts';
import { createAccount, getAccountBalance, getTransactions, importTransactions, listAccounts, setAccountBalance, shutdown } from './actual.ts';
// reconcileAccountBalance is the mechanism confirmed (via source) to actually work — see the
// comment at its call site below. Kept imported, not deleted, per instruction to comment out
// rather than remove.
import { reconcileAccountBalance } from './balance.ts';
import { resolveCategories, resolveTransactionCategory } from './categories.ts';
import { invalidateMapping, isUsable, loadMapping, resolveAccount, saveMapping } from './mapping.ts';
import { applyRules, invalidateRules, loadRules } from './rules.ts';
import {
	discoverCategories,
	getFeedItemsBetween,
	profilesWithWebhookSecret,
	resolveWebhookProfile,
	type FeedItem,
	type FeedItemWebhookPayload,
} from './starling.ts';
import { toActualTransaction } from './transform.ts';
import { tryLinkTransfer } from './transfers.ts';

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

	const rules = await loadRules();
	const withRules = applyRules(item, converted.transaction, rules.rules);
	const resolved = await resolveTransactionCategory(withRules);
	const result = await importTransactions(mapped.actualAccountId, [resolved]);

	// Best-effort: if this is one leg of an internal transfer and the other leg has already
	// landed (via its own webhook event, or an earlier backfill), link them via transfer_id
	// so Actual treats it as one transfer instead of two unlinked transactions. If the peer
	// hasn't arrived yet, its own webhook event will find *this* transaction and link it then.
	const ownTransactionId = result.idsByImportedId[item.feedItemUid];
	const linked = ownTransactionId
		? await tryLinkTransfer(item, mapped.actualAccountId, ownTransactionId, resolved.amount, resolved.date)
		: false;

	console.log(
		`[webhook] ${profile.name}/${item.feedItemUid} → ${mapped.label ?? mapped.actualAccountId}: ` +
			`+${result.added} added, ${result.updated} updated${linked ? ', linked as transfer' : ''}`,
	);
	return c.json({ status: 'ok', ...result, linkedTransfer: linked });
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

/**
 * Diagnostic: for every mapped Actual account, compare Actual's actual computed balance
 * (sum of its real transactions) against Starling's real current balance right now, plus the
 * stored adjustment transaction's amount if one exists. Read-only — makes no changes.
 */
app.get('/debug/balance', async (c) => {
	const [categories, mapping] = await Promise.all([discoverCategories(), loadMapping()]);
	const usable = categories.filter((category) => isUsable(mapping.categories[category.categoryUid]));

	const byAccount = new Map<string, typeof usable>();
	for (const category of usable) {
		const entry = mapping.categories[category.categoryUid]!;
		const group = byAccount.get(entry.actualAccountId) ?? [];
		group.push(category);
		byAccount.set(entry.actualAccountId, group);
	}

	const results = [];
	for (const [actualAccountId, group] of byAccount) {
		const starlingTarget = group.reduce((sum, cat) => sum + (cat.balanceMinorUnits ?? 0), 0);
		const [actualBalance, transactions] = await Promise.all([
			getAccountBalance(actualAccountId),
			getTransactions(actualAccountId, '0001-01-01', '9999-12-31'),
		]);
		const adjustment = transactions.find((txn) => txn.imported_id === 'starling-balance-adjustment');

		results.push({
			actualAccountId,
			categories: group.map((cat) => cat.label),
			starlingTarget,
			actualBalance,
			discrepancy: actualBalance - starlingTarget,
			adjustmentTransaction: adjustment ? { id: adjustment.id, amount: adjustment.amount } : null,
			transactionCount: transactions.length,
		});
	}

	return c.json({ results });
});

/**
 * Diagnostic: group an Actual account's transactions by (date, amount) to surface anything
 * that looks like the same real-world event counted more than once — different imported_id,
 * same date+amount. Read-only.
 */
app.get('/debug/duplicates', async (c) => {
	const actualAccountId = c.req.query('actualAccountId');
	if (!actualAccountId) return c.json({ error: 'query param actualAccountId is required' }, 400);

	const transactions = await getTransactions(actualAccountId, '0001-01-01', '9999-12-31');

	const groups = new Map<string, typeof transactions>();
	for (const txn of transactions) {
		const key = `${txn.date}|${txn.amount}`;
		const group = groups.get(key) ?? [];
		group.push(txn);
		groups.set(key, group);
	}

	const suspicious = [...groups.entries()]
		.filter(([, group]) => group.length > 1)
		.map(([key, group]) => ({
			key,
			count: group.length,
			// If this really is the same event counted N times, N-1 copies are excess value.
			excessValue: (group.reduce((sum, txn) => sum + txn.amount, 0) / group.length) * (group.length - 1),
			transactions: group.map((txn) => ({
				id: txn.id,
				imported_id: txn.imported_id,
				transfer_id: txn.transfer_id,
				notes: txn.notes,
			})),
		}));

	return c.json({
		actualAccountId,
		totalTransactions: transactions.length,
		suspiciousGroups: suspicious.length,
		totalExcessValue: suspicious.reduce((sum, g) => sum + g.excessValue, 0),
		groups: suspicious,
	});
});

app.post('/mapping/reload', async (c) => {
	invalidateMapping();
	const mapping = await loadMapping();
	return c.json({ status: 'reloaded', categories: Object.keys(mapping.categories).length });
});

app.post('/rules/reload', async (c) => {
	invalidateRules();
	const rules = await loadRules();
	return c.json({ status: 'reloaded', rules: rules.rules.length });
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
	const rules = await loadRules();
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
		// Kept alongside `transactions` (same order) so transfer linking below can get back to
		// each imported transaction's raw feed item — feedItemUid doubles as imported_id.
		const itemsByFeedItemUid = new Map<string, FeedItem>();
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
				if (converted.ok) {
					transactions.push(applyRules(item, converted.transaction, rules.rules));
					itemsByFeedItemUid.set(item.feedItemUid, item);
				} else {
					skipReasons.set(converted.reason, (skipReasons.get(converted.reason) ?? 0) + 1);
				}
			}
		}

		const resolved = await resolveCategories(transactions);
		const result = await importTransactions(entry.actualAccountId, resolved);
		const skipped = Object.fromEntries(skipReasons);
		console.log(
			`[backfill] ${target.profile}/${target.label}: fetched ${fetched}, added ${result.added}, ` +
				`updated ${result.updated}${skipReasons.size ? `, skipped ${JSON.stringify(skipped)}` : ''}`,
		);

		// Best-effort, order-independent (see transfers.ts) — attempted for every transaction
		// just imported, not only newly-added ones, so a re-run can still link anything that
		// missed its peer on a previous pass (e.g. the peer account backfilled after this one).
		let linkedTransfers = 0;
		for (const txn of resolved) {
			const item = itemsByFeedItemUid.get(txn.imported_id);
			const ownTransactionId = result.idsByImportedId[txn.imported_id];
			if (!item || !ownTransactionId) continue;
			if (await tryLinkTransfer(item, entry.actualAccountId, ownTransactionId, txn.amount, txn.date)) linkedTransfers++;
		}

		report.push({
			profile: target.profile,
			label: target.label,
			categoryUid: target.categoryUid,
			fetched,
			...result,
			...(skipReasons.size ? { skipped } : {}),
			...(linkedTransfers ? { linkedTransfers } : {}),
		});
	}

	// Backfilling from a cutoff necessarily excludes everything before it, so an account with
	// real history predating `from` would otherwise show a balance of just the imported
	// transactions — often confusingly negative. Force each account to its real Starling
	// balance via a single adjustment transaction representing that pre-cutoff history.
	//
	// Grouped by actualAccountId across *every* mapped category (not just `targets`, which
	// may be narrowed to one categoryUid this call) because merged categories — e.g. a Space
	// collapsed into its parent account via a shared `accountName` — must always have their
	// real balances summed together, regardless of which one this particular request touched;
	// otherwise reconciling just "Car" on a Car+Easy Saver merged account would wipe out Easy
	// Saver's share of the target balance.
	const adjustmentDate = new Date(from);
	adjustmentDate.setUTCDate(adjustmentDate.getUTCDate() - 1);
	const adjustmentDateStr = adjustmentDate.toISOString().slice(0, 10);

	const allMappedCategories = categories.filter((category) => isUsable(mapping.categories[category.categoryUid]));
	const targetsByAccount = new Map<string, typeof allMappedCategories>();
	for (const category of allMappedCategories) {
		const entry = mapping.categories[category.categoryUid]!;
		const group = targetsByAccount.get(entry.actualAccountId) ?? [];
		group.push(category);
		targetsByAccount.set(entry.actualAccountId, group);
	}

	const balanceReport: Record<string, unknown>[] = [];
	for (const [actualAccountId, group] of targetsByAccount) {
		const missingBalance = group.filter((t) => t.balanceMinorUnits === undefined);
		const targetBalance = group.reduce((sum, t) => sum + (t.balanceMinorUnits ?? 0), 0);

		try {
			// Commented out per instruction to use updateAccount instead, despite this being the
			// mechanism confirmed (via source, not the docs) to actually persist a balance change —
			// see CLAUDE.md "Forcing an account's balance to match Starling".
			// const result = await reconcileAccountBalance(actualAccountId, targetBalance, adjustmentDateStr);
			await setAccountBalance(actualAccountId, targetBalance);
			const result = { action: 'attempted' as const, adjustment: targetBalance };
			balanceReport.push({
				actualAccountId,
				categories: group.map((t) => t.label),
				targetBalance,
				...result,
				...(missingBalance.length ? { warning: `no balance from Starling for: ${missingBalance.map((t) => t.label).join(', ')}` } : {}),
			});
		} catch (err) {
			balanceReport.push({ actualAccountId, categories: group.map((t) => t.label), error: (err as Error).message });
		}
	}

	return c.json({
		status: 'ok',
		from: from.toISOString(),
		to: to.toISOString(),
		results: report,
		balanceAdjustments: balanceReport,
	});
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
