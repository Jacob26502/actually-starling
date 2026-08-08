import { ensureCategory, ensureCategoryGroup } from './actual.ts';
import type { ActualTransaction } from './transform.ts';

const STARLING_GROUP_NAME = 'Starling';

/**
 * Starling spendingCategory values that represent money coming in rather than going out.
 * Only INCOME is expected on a personal account holder's token — REVENUE/OTHER_INCOME are
 * business-account values, included here in case a business profile is ever added.
 */
const INCOME_CATEGORIES = new Set(['INCOME', 'REVENUE', 'OTHER_INCOME']);

/** "EATING_OUT" -> "Eating Out". */
export function humanizeSpendingCategory(spendingCategory: string): string {
	return spendingCategory
		.toLowerCase()
		.split('_')
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
		.join(' ');
}

let groupIdPromise: Promise<string> | null = null;
function resolveGroup(): Promise<string> {
	// Lazy + cached: only ever created once, on first category actually seen.
	if (!groupIdPromise) groupIdPromise = ensureCategoryGroup(STARLING_GROUP_NAME);
	return groupIdPromise;
}

const categoryIdCache = new Map<string, Promise<string>>();

/**
 * Resolve a Starling spendingCategory to an Actual category id, creating it under a single
 * "Starling" category group the first time it's seen. Cached in memory for the process
 * lifetime; safe across restarts too, since categories are looked up by name — an existing
 * one is reused rather than duplicated.
 */
export function resolveCategory(spendingCategory: string): Promise<string> {
	let promise = categoryIdCache.get(spendingCategory);
	if (!promise) {
		promise = (async () => {
			const groupId = await resolveGroup();
			const name = humanizeSpendingCategory(spendingCategory);
			return ensureCategory(name, groupId, INCOME_CATEGORIES.has(spendingCategory));
		})();
		categoryIdCache.set(spendingCategory, promise);
	}
	return promise;
}

/**
 * Resolve one transaction's spendingCategory to a real Actual category id.
 *
 * Must run to completion *before* actual.ts's importTransactions is called — ensureCategory/
 * ensureCategoryGroup each go through withActual(), and withActual() is a serial queue, not
 * reentrant, so calling it from inside an already-running withActual() callback would
 * deadlock. Keeping category resolution as a separate, prior step (here, not inside
 * importTransactions) avoids that.
 */
export async function resolveTransactionCategory(transaction: ActualTransaction): Promise<ActualTransaction> {
	if (!transaction.spendingCategory) return transaction;
	const category = await resolveCategory(transaction.spendingCategory);
	return { ...transaction, category };
}

/** Same as resolveTransactionCategory, for a batch — see its docs for the withActual caveat. */
export function resolveCategories(transactions: ActualTransaction[]): Promise<ActualTransaction[]> {
	return Promise.all(transactions.map(resolveTransactionCategory));
}
