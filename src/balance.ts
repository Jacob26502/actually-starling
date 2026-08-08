import { getAccountBalance, getTransactions, importTransactions, updateTransactionAmount } from './actual.ts';

/**
 * Stable id for the single synthetic "balance adjustment" transaction each account can have.
 * Not a real Starling feedItemUid — deliberately outside that format so it can never collide.
 */
const ADJUSTMENT_ID = 'starling-balance-adjustment';

export interface ReconcileResult {
	action: 'none' | 'created' | 'updated';
	/** The adjustment transaction's amount after this call, in signed minor units. */
	adjustment: number;
}

/**
 * Force an Actual account's computed balance (sum of its transactions) to match a target —
 * e.g. Starling's real current balance — by adding or updating a single synthetic adjustment
 * transaction for the difference.
 *
 * This exists because backfilling from a cutoff date necessarily excludes everything before
 * it: an account with real history predating that cutoff would otherwise show a balance equal
 * to just the imported transactions, not the account's real balance (often confusingly
 * negative). The adjustment transaction represents that pre-cutoff history as a single lump
 * sum, dated just before it, rather than trying to import transactions Starling won't return.
 *
 * Recomputed fresh every call: `importTransactions`' reconciliation never touches `amount` on
 * an existing match (verified against source — see actual.ts), so a stale adjustment from a
 * previous run has to be found and patched directly via updateTransactionAmount, not
 * re-imported.
 */
export async function reconcileAccountBalance(
	accountId: string,
	targetMinorUnits: number,
	adjustmentDate: string,
): Promise<ReconcileResult> {
	const [currentBalance, transactions] = await Promise.all([
		getAccountBalance(accountId),
		// Wide enough to find the adjustment transaction regardless of when it was created.
		getTransactions(accountId, '0001-01-01', '9999-12-31'),
	]);

	const existing = transactions.find((txn) => txn.imported_id === ADJUSTMENT_ID);
	// The current balance already includes any prior adjustment — back it out before
	// recomputing, or a second run would double-count it.
	const balanceExcludingAdjustment = currentBalance - (existing?.amount ?? 0);
	const neededAdjustment = targetMinorUnits - balanceExcludingAdjustment;

	if (existing) {
		if (existing.amount === neededAdjustment) return { action: 'none', adjustment: neededAdjustment };
		await updateTransactionAmount(existing.id, neededAdjustment);
		return { action: 'updated', adjustment: neededAdjustment };
	}

	if (neededAdjustment === 0) return { action: 'none', adjustment: 0 };

	await importTransactions(accountId, [
		{
			date: adjustmentDate,
			amount: neededAdjustment,
			payee_name: 'Starling balance adjustment',
			notes: 'Represents Starling account history from before this sync began.',
			imported_id: ADJUSTMENT_ID,
			cleared: true,
		},
	]);
	return { action: 'created', adjustment: neededAdjustment };
}
