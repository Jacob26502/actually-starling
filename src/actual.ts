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

export interface ImportResult {
	added: number;
	updated: number;
	errors: number;
}

/**
 * Import transactions into one Actual account.
 *
 * Uses importTransactions (not addTransactions) so Actual reconciles on `imported_id` and
 * applies the budget's payee/category rules — replaying the same feed item is a no-op.
 */
export function importTransactions(accountId: string, transactions: ActualTransaction[]): Promise<ImportResult> {
	if (transactions.length === 0) return Promise.resolve({ added: 0, updated: 0, errors: 0 });

	return withActual(async () => {
		const result = (await actualApi.importTransactions(
			accountId,
			transactions.map((txn) => ({ ...txn, account: accountId })),
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

export async function shutdown(): Promise<void> {
	if (!initialised) return;
	try {
		await withActual(() => actualApi.shutdown());
	} catch (err) {
		console.error('[actual] shutdown failed', err);
	}
}
