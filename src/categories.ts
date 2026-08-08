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

/** Cache is keyed by the *resolved display name*, not the raw input — see the two callers below. */
const categoryIdCache = new Map<string, Promise<string>>();

/**
 * Resolve any category name to an Actual category id, creating it under a single "Starling"
 * category group the first time it's seen. Cached in memory for the process lifetime; safe
 * across restarts too, since categories are looked up by name — an existing one is reused
 * rather than duplicated.
 */
export function resolveCategoryByName(name: string, isIncome = false): Promise<string> {
	let promise = categoryIdCache.get(name);
	if (!promise) {
		promise = (async () => {
			const groupId = await resolveGroup();
			return ensureCategory(name, groupId, isIncome);
		})();
		categoryIdCache.set(name, promise);
	}
	return promise;
}

/** Resolve a Starling spendingCategory (e.g. "EATING_OUT") specifically — see resolveCategoryByName. */
export function resolveCategory(spendingCategory: string): Promise<string> {
	return resolveCategoryByName(humanizeSpendingCategory(spendingCategory), INCOME_CATEGORIES.has(spendingCategory));
}

/**
 * Resolve one transaction's category to a real Actual category id — a user rule's
 * `categoryOverride` (rules.ts) takes priority over Starling's own `spendingCategory` if both
 * are present.
 *
 * Must run to completion *before* actual.ts's importTransactions is called — ensureCategory/
 * ensureCategoryGroup each go through withActual(), and withActual() is a serial queue, not
 * reentrant, so calling it from inside an already-running withActual() callback would
 * deadlock. Keeping category resolution as a separate, prior step (here, not inside
 * importTransactions) avoids that.
 */
export async function resolveTransactionCategory(transaction: ActualTransaction): Promise<ActualTransaction> {
	if (transaction.categoryOverride) {
		const category = await resolveCategoryByName(transaction.categoryOverride);
		return { ...transaction, category };
	}
	if (!transaction.spendingCategory) return transaction;
	const category = await resolveCategory(transaction.spendingCategory);
	return { ...transaction, category };
}

/** Same as resolveTransactionCategory, for a batch — see its docs for the withActual caveat. */
export function resolveCategories(transactions: ActualTransaction[]): Promise<ActualTransaction[]> {
	return Promise.all(transactions.map(resolveTransactionCategory));
}
