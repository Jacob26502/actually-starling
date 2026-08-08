import { config } from './config.ts';
import type { FeedItem } from './starling.ts';

/** The subset of Actual's ImportTransactionEntity we produce. */
export interface ActualTransaction {
	date: string;
	amount: number;
	payee_name?: string;
	imported_payee?: string;
	imported_id: string;
	notes?: string;
	cleared: boolean;
}

/** Starling statuses that never moved money and must not become transactions. */
const IGNORED_STATUSES = new Set(['DECLINED', 'ACCOUNT_CHECK']);

const dateFormatter = new Intl.DateTimeFormat('en-CA', {
	timeZone: config.timezone,
	year: 'numeric',
	month: '2-digit',
	day: '2-digit',
});

/**
 * Starling timestamps are UTC; a 23:30 BST purchase is 22:30Z and would land on the
 * previous day if we naively sliced the ISO string, so format in the configured zone.
 * `en-CA` yields YYYY-MM-DD, which is exactly Actual's required date format.
 */
export function toActualDate(isoTimestamp: string): string {
	return dateFormatter.format(new Date(isoTimestamp));
}

export function describeSource(item: FeedItem): string {
	return (item.source ?? 'STARLING').toLowerCase().replaceAll('_', ' ');
}

export type TransformResult =
	| { ok: true; transaction: ActualTransaction }
	| { ok: false; reason: string };

/**
 * Convert a feed item to an Actual transaction, or explain why it was skipped.
 *
 * `amount.minorUnits` is always positive and unsigned in Starling; `direction` carries the
 * sign. Actual wants signed minor units, negative for money leaving the account.
 */
export function toActualTransaction(item: FeedItem): TransformResult {
	if (item.status && IGNORED_STATUSES.has(item.status)) {
		return { ok: false, reason: `status ${item.status}` };
	}

	const minorUnits = item.amount?.minorUnits;
	if (typeof minorUnits !== 'number' || Number.isNaN(minorUnits)) {
		return { ok: false, reason: 'feed item has no usable amount' };
	}

	// Actual has one currency per budget, so a foreign-currency account would import at
	// face value and silently misstate the balance. Refuse rather than corrupt the budget.
	const currency = item.amount.currency?.toUpperCase();
	if (currency && currency !== config.budgetCurrency) {
		return {
			ok: false,
			reason: `currency ${currency} does not match budget currency ${config.budgetCurrency}`,
		};
	}

	const signed = item.direction === 'OUT' ? -Math.abs(minorUnits) : Math.abs(minorUnits);
	const payee = item.counterPartyName?.trim() || item.reference?.trim() || describeSource(item);

	const notes: string[] = [];
	// Only keep the reference when it adds something beyond the payee name.
	if (item.reference && item.reference.trim() !== payee) notes.push(item.reference.trim());
	if (item.userNote) notes.push(item.userNote.trim());
	if (item.sourceAmount && item.sourceAmount.currency !== item.amount.currency) {
		notes.push(`${item.sourceAmount.currency} ${(item.sourceAmount.minorUnits / 100).toFixed(2)}`);
	}

	return {
		ok: true,
		transaction: {
			date: toActualDate(item.transactionTime),
			amount: signed,
			payee_name: payee,
			imported_payee: item.counterPartyName?.trim() || undefined,
			// feedItemUid is stable across updates to the same transaction, so Actual
			// reconciles a PENDING import into its SETTLED version instead of duplicating.
			imported_id: item.feedItemUid,
			notes: notes.length ? notes.join(' · ') : undefined,
			cleared: item.status === 'SETTLED',
		},
	};
}
