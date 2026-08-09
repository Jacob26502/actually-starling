import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { config, findProfile } from './config.ts';
import {
	createAccount,
	deleteTransactionById,
	getAccountBalance,
	getTransactions,
	importTransactions,
	listAccounts,
	shutdown,
} from './actual.ts';
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
	profilesWithWebhookPublicKey,
	resolveWebhookProfile,
	type FeedItem,
	type FeedItemWebhookPayload,
} from './starling.ts';
import { toActualTransaction } from './transform.ts';
import { tryLinkAnyTransfer } from './transfers.ts';

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

	if (profilesWithWebhookPublicKey().length === 0) {
		console.error('[webhook] no STARLING_<name>_WEBHOOK_PUBLIC_KEY configured — refusing unverifiable request');
		return c.json({ error: 'webhook public key not configured' }, 500);
	}

	// Each Starling account signs with its own key pair, so try them all.
	const profile = resolveWebhookProfile(rawBody, c.req.header('X-Hook-Signature'));
	if (!profile) {
		console.warn('[webhook] rejected request: signature matched no configured public key');
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

	// Best-effort: if this is one leg of a transfer (same-account Space, a payment between two
	// of the holder's own Starling accounts, or a configured external account like a credit
	// card) and the other leg has already landed, link them via transfer_id so Actual treats it
	// as one transfer instead of two unlinked transactions. If the peer hasn't arrived yet, its
	// own webhook event will find *this* transaction and link it then.
	const mapping = await loadMapping();
	const ownTransactionId = result.idsByImportedId[item.feedItemUid];
	const linked = ownTransactionId
		? await tryLinkAnyTransfer(
				item,
				profile,
				mapping.externalTransfers ?? [],
				mapped.actualAccountId,
				ownTransactionId,
				resolved.amount,
				resolved.date,
			)
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
 * Runs the proven-working balance-reconciliation mechanism (src/balance.ts) directly,
 * against every mapped account, without needing a full /backfill re-run. Uses a fixed,
 * clearly-pre-history date (2020-01-01) for the adjustment transaction — this endpoint is a
 * general "make the balance correct" tool now, not tied to any particular backfill's `from`.
 */
app.post('/debug/reconcile-balances', async (c) => {
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
		const targetBalance = group.reduce((sum, cat) => sum + (cat.balanceMinorUnits ?? 0), 0);
		try {
			const result = await reconcileAccountBalance(actualAccountId, targetBalance, '2020-01-01');
			results.push({ actualAccountId, categories: group.map((cat) => cat.label), targetBalance, ...result });
		} catch (err) {
			results.push({ actualAccountId, categories: group.map((cat) => cat.label), error: (err as Error).message });
		}
	}

	return c.json({ results });
});

/**
 * Full, unfiltered transaction dump for one account — every field, no top-15 limit. For
 * deep manual analysis without needing a new endpoint for each new question.
 */
app.get('/debug/transactions', async (c) => {
	const actualAccountId = c.req.query('actualAccountId');
	if (!actualAccountId) return c.json({ error: 'query param actualAccountId is required' }, 400);
	const transactions = await getTransactions(actualAccountId, '0001-01-01', '9999-12-31');
	return c.json({ actualAccountId, count: transactions.length, transactions });
});

/**
 * Free-text search across notes/payee fields for one account — case-insensitive substring.
 * For chasing a specific pattern (e.g. a merchant or reference fragment) without new code.
 */
app.get('/debug/search', async (c) => {
	const actualAccountId = c.req.query('actualAccountId');
	const q = (c.req.query('q') ?? '').toLowerCase();
	if (!actualAccountId || !q) return c.json({ error: 'query params actualAccountId and q are required' }, 400);

	const transactions = await getTransactions(actualAccountId, '0001-01-01', '9999-12-31');
	const matches = transactions.filter((txn) => {
		const haystack = `${txn.notes ?? ''} ${txn.payee_name ?? ''} ${txn.imported_payee ?? ''}`.toLowerCase();
		return haystack.includes(q);
	});

	return c.json({ actualAccountId, query: q, matchCount: matches.length, matches });
});

/**
 * Diagnostic: find likely duplicate transactions — same date, amount, AND notes, where one
 * copy has no imported_id (never came from Starling; likely entered by hand before this sync
 * existed) and another does. Read-only; classifies rather than acts.
 *
 * Deliberately conservative: a (date, amount) match with *different* notes, or a group with
 * no real imported_id to anchor against, is left for manual review rather than guessed at —
 * real data included both (JOHN LEWIS STORES vs STAGECOACH SERVICES sharing a date+amount by
 * coincidence; two genuinely separate "Round Up" entries with no imported original at all).
 */
app.get('/debug/duplicates', async (c) => {
	const actualAccountId = c.req.query('actualAccountId');
	if (!actualAccountId) return c.json({ error: 'query param actualAccountId is required' }, 400);
	// strict=false groups by (date, amount) only, ignoring notes — a wider net for cases where
	// a real Starling transaction and its manual duplicate don't share identical notes.
	const strict = c.req.query('strict') !== 'false';

	const transactions = await getTransactions(actualAccountId, '0001-01-01', '9999-12-31');

	const groups = new Map<string, typeof transactions>();
	for (const txn of transactions) {
		const key = `${txn.date}|${txn.amount}`;
		const group = groups.get(key) ?? [];
		group.push(txn);
		groups.set(key, group);
	}

	const safeToDelete: { id: string; date?: string; amount: number; notes: string | null }[] = [];
	const needsReview: Record<string, unknown>[] = [];

	for (const [key, group] of groups) {
		if (group.length < 2) continue;

		const byNotes = new Map<string, typeof group>();
		for (const txn of group) {
			const notesKey = strict ? (txn.notes ?? '').trim().toLowerCase() : '*';
			const sub = byNotes.get(notesKey) ?? [];
			sub.push(txn);
			byNotes.set(notesKey, sub);
		}

		for (const [notesKey, sub] of byNotes) {
			if (sub.length < 2) continue; // unique within this (date, amount, notes) — leave alone
			const withImportedId = sub.filter((txn) => txn.imported_id);
			const withoutImportedId = sub.filter((txn) => !txn.imported_id);

			// Safe: exactly one real, imported copy to anchor against, and the rest have no
			// imported_id at all — those are the ones to remove. Anything messier (multiple
			// real copies, or none at all) goes to manual review instead of being guessed at.
			// Never auto-classify in relaxed mode — without notes matching, "exactly one real +
			// one null" could just as easily be two unrelated transactions (confirmed real case:
			// JOHN LEWIS STORES vs STAGECOACH SERVICES sharing a date+amount by coincidence).
			if (strict && withImportedId.length === 1 && withoutImportedId.length >= 1) {
				for (const txn of withoutImportedId) {
					safeToDelete.push({ id: txn.id, date: txn.date, amount: txn.amount, notes: txn.notes ?? null });
				}
			} else {
				needsReview.push({
					key,
					notes: notesKey || '(blank)',
					transactions: sub.map((txn) => ({ id: txn.id, imported_id: txn.imported_id, notes: txn.notes })),
				});
			}
		}
	}

	return c.json({
		actualAccountId,
		strict,
		totalTransactions: transactions.length,
		safeToDelete: {
			count: safeToDelete.length,
			totalValue: safeToDelete.reduce((sum, txn) => sum + txn.amount, 0),
			transactions: safeToDelete,
		},
		needsReview,
	});
});

/**
 * Deletes an explicit, caller-provided list of transaction ids. Body: { "ids": ["...", ...] }.
 * Intended to be called with exactly the `safeToDelete` list from GET /debug/duplicates after
 * a human has reviewed it — never derives what to delete itself.
 */
app.post('/debug/duplicates/delete', async (c) => {
	const body = await c.req.json<{ ids?: string[] }>().catch(() => ({}) as { ids?: string[] });
	if (!body.ids?.length) return c.json({ error: 'body must include a non-empty "ids" array' }, 400);

	const results = [];
	for (const id of body.ids) {
		try {
			await deleteTransactionById(id);
			results.push({ id, status: 'deleted' });
		} catch (err) {
			results.push({ id, status: 'error', message: (err as Error).message });
		}
	}

	return c.json({ results });
});

/**
 * Diagnostic: raw SUM(amount) computed directly here from getTransactions, alongside
 * whatever getAccountBalance() itself reports — the two should always agree; if they don't,
 * something other than a straightforward SUM is happening. Also flags the largest individual
 * transactions, and confirms a given list of ids is (or isn't) still present.
 */
app.get('/debug/verify', async (c) => {
	const actualAccountId = c.req.query('actualAccountId');
	if (!actualAccountId) return c.json({ error: 'query param actualAccountId is required' }, 400);
	const checkIds = (c.req.query('checkIds') ?? '').split(',').filter(Boolean);

	const [reportedBalance, transactions] = await Promise.all([
		getAccountBalance(actualAccountId),
		getTransactions(actualAccountId, '0001-01-01', '9999-12-31'),
	]);

	const rawSum = transactions.reduce((sum, txn) => sum + txn.amount, 0);
	const byAmountDesc = [...transactions].sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount)).slice(0, 15);
	const stillPresent = checkIds.filter((id) => transactions.some((txn) => txn.id === id));

	return c.json({
		actualAccountId,
		transactionCount: transactions.length,
		reportedBalance,
		rawSum,
		agree: reportedBalance === rawSum,
		largestTransactions: byAmountDesc.map((txn) => ({
			id: txn.id,
			date: txn.date,
			amount: txn.amount,
			notes: txn.notes,
			imported_id: txn.imported_id,
			transfer_id: txn.transfer_id,
		})),
		checkIds: { requested: checkIds.length, stillPresent },
	});
});

/**
 * Diagnostic: across a set of accounts, find any transaction whose transfer_id points to a
 * transaction id that no longer exists — i.e. its transfer partner was deleted without also
 * clearing this side's reference. Read-only.
 */
app.get('/debug/orphaned-transfers', async (c) => {
	const accountIds = (c.req.query('actualAccountIds') ?? '').split(',').filter(Boolean);
	if (accountIds.length === 0) return c.json({ error: 'query param actualAccountIds (comma-separated) is required' }, 400);

	const perAccount = await Promise.all(
		accountIds.map(async (accountId) => ({ accountId, transactions: await getTransactions(accountId, '0001-01-01', '9999-12-31') })),
	);

	const allIds = new Set(perAccount.flatMap(({ transactions }) => transactions.map((txn) => txn.id)));

	const orphans = [];
	for (const { accountId, transactions } of perAccount) {
		for (const txn of transactions) {
			if (txn.transfer_id && !allIds.has(txn.transfer_id)) {
				orphans.push({ accountId, id: txn.id, date: txn.date, amount: txn.amount, notes: txn.notes, danglingTransferId: txn.transfer_id });
			}
		}
	}

	return c.json({ accountsChecked: accountIds.length, totalTransactions: allIds.size, orphanedCount: orphans.length, orphans });
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
			const didLink = await tryLinkAnyTransfer(
				item,
				profile,
				mapping.externalTransfers ?? [],
				entry.actualAccountId,
				ownTransactionId,
				txn.amount,
				txn.date,
			);
			if (didLink) linkedTransfers++;
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
			// Restored to the mechanism confirmed (via source) to actually persist a balance
			// change — updateAccount/setAccountBalance was proven to silently no-op. See
			// CLAUDE.md "Forcing an account's balance to match Starling".
			const result = await reconcileAccountBalance(actualAccountId, targetBalance, adjustmentDateStr);
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
