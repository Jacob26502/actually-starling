import { mkdir } from 'node:fs/promises';
import * as actualApi from '@actual-app/api';
import { config } from './config.ts';
import type { ActualTransaction } from './transform.ts';

export interface ActualAccount {
	id: string;
	name: string;
	offbudget?: boolean;
	closed?: boolean;
}

let initialised: Promise<void> | null = null;
/**
 * `@actual-app/api` is a process-wide singleton backed by a local SQLite budget file, so
 * two overlapping imports would race on the same connection. Every call goes through this
 * promise chain to keep Actual work strictly serial.
 */
let tail: Promise<unknown> = Promise.resolve();

async function initialise(): Promise<void> {
	await mkdir(config.actual.dataDir, { recursive: true });

	await actualApi.init({
		serverURL: config.actual.serverUrl,
		password: config.actual.password,
		dataDir: config.actual.dataDir,
	});

	// downloadBudget takes the syncId positionally; the budget password is only for
	// end-to-end encrypted files.
	await actualApi.downloadBudget(config.actual.syncId, {
		password: config.actual.budgetPassword,
	});

	console.log(`[actual] budget ${config.actual.syncId} ready`);
}

function ensureInitialised(): Promise<void> {
	// Retry initialisation on a later call if it failed, rather than caching the rejection.
	if (!initialised) {
		initialised = initialise().catch((err) => {
			initialised = null;
			throw err;
		});
	}
	return initialised;
}

export function withActual<T>(fn: () => Promise<T>): Promise<T> {
	const result = tail.then(async () => {
		await ensureInitialised();
		return fn();
	});
	// Swallow failures on the chain itself so one error doesn't poison later callers.
	tail = result.then(
		() => undefined,
		() => undefined,
	);
	return result;
}

export function listAccounts(): Promise<ActualAccount[]> {
	return withActual(() => actualApi.getAccounts() as Promise<ActualAccount[]>);
}

/** Create an on-budget account and return its new id. */
export function createAccount(name: string, offbudget = false): Promise<string> {
	return withActual(async () => {
		const id = (await actualApi.createAccount({ name, offbudget }, 0)) as string;
		await actualApi.sync();
		return id;
	});
}

/** Look up a category group by name, creating it if it doesn't exist yet. */
export function ensureCategoryGroup(name: string): Promise<string> {
	return withActual(async () => {
		const groups = (await actualApi.getCategoryGroups()) as { id: string; name: string }[];
		const existing = groups.find((group) => group.name === name);
		if (existing) return existing.id;

		const id = (await actualApi.createCategoryGroup({ name, is_income: false, hidden: false })) as string;
		await actualApi.sync();
		return id;
	});
}

/** Look up a category by name within a group, creating it if it doesn't exist yet. */
export function ensureCategory(name: string, groupId: string, isIncome: boolean): Promise<string> {
	return withActual(async () => {
		const categories = (await actualApi.getCategories()) as { id: string; name: string; group_id: string }[];
		const existing = categories.find((category) => category.name === name && category.group_id === groupId);
		if (existing) return existing.id;

		const id = (await actualApi.createCategory({
			name,
			group_id: groupId,
			is_income: isIncome,
			hidden: false,
		})) as string;
		await actualApi.sync();
		return id;
	});
}

export interface ImportResult {
	added: number;
	updated: number;
	errors: number;
}

/**
 * Import transactions into one Actual account.
 *
 * Uses importTransactions (not addTransactions) so Actual reconciles on `imported_id` —
 * replaying the same feed item is a no-op. Note this does NOT run the budget's rules
 * (verified against @actual-app/api's bundled source: `importTransactions` calls straight
 * into `reconcileTransactions`, no rules step; `addTransactions` is the one that calls
 * `runRules`, and this project deliberately never uses it).
 */
export function importTransactions(accountId: string, transactions: ActualTransaction[]): Promise<ImportResult> {
	if (transactions.length === 0) return Promise.resolve({ added: 0, updated: 0, errors: 0 });

	return withActual(async () => {
		const result = (await actualApi.importTransactions(
			accountId,
			// spendingCategory is resolved into `category` by resolveCategories() before this is
			// called — drop the raw string so we don't send Actual a field it doesn't recognise.
			transactions.map(({ spendingCategory: _spendingCategory, ...txn }) => ({ ...txn, account: accountId })),
			// Respect each transaction's own `cleared` flag instead of forcing everything cleared.
			{ defaultCleared: false },
		)) as { added?: unknown[]; updated?: unknown[]; errors?: unknown[] };

		// Push the new local state up to the sync server so other clients see it.
		await actualApi.sync();

		return {
			added: result.added?.length ?? 0,
			updated: result.updated?.length ?? 0,
			errors: result.errors?.length ?? 0,
		};
	});
}

/** Current computed balance (sum of all non-tombstoned transactions), in signed minor units. */
export function getAccountBalance(accountId: string): Promise<number> {
	return withActual(() => actualApi.getAccountBalance(accountId));
}

/**
 * Attempts to set an account's balance directly via updateAccount, per explicit instruction
 * to use this despite it having no verified effect: the real underlying implementation only
 * ever persists `{id, name, last_reconciled}` — `balance_current` here is silently discarded,
 * not an error. See CLAUDE.md and src/balance.ts for the mechanism that actually works.
 */
export function setAccountBalance(accountId: string, balanceMinorUnits: number): Promise<void> {
	return withActual(async () => {
		await actualApi.updateAccount(accountId, { balance_current: balanceMinorUnits });
		await actualApi.sync();
	});
}

interface MinimalTransaction {
	id: string;
	imported_id?: string;
	amount: number;
}

export function getTransactions(accountId: string, startDate: string, endDate: string): Promise<MinimalTransaction[]> {
	return withActual(() => actualApi.getTransactions(accountId, startDate, endDate) as Promise<MinimalTransaction[]>);
}

/**
 * Directly patch a transaction's amount. Unlike importTransactions' reconciliation (which
 * deliberately never touches `amount` on an existing match — verified against source), this
 * always applies it: updateTransaction spreads `{...existing, ...fields}` with no filtering.
 */
export function updateTransactionAmount(id: string, amount: number): Promise<void> {
	return withActual(async () => {
		await actualApi.updateTransaction(id, { amount });
		await actualApi.sync();
	});
}

export async function shutdown(): Promise<void> {
	if (!initialised) return;
	try {
		await withActual(() => actualApi.shutdown());
	} catch (err) {
		console.error('[actual] shutdown failed', err);
	}
}
