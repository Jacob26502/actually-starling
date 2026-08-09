import { findTransferPeer, linkTransferPair } from './actual.ts';
import type { StarlingProfile } from './config.ts';
import { type ExternalTransferRule, isUsable, loadMapping, resolveAccount } from './mapping.ts';
import type { FeedItem } from './starling.ts';

/**
 * True for a feed item that's Starling moving money between two of your own categories
 * (a main account <-> a Space, or Space <-> Space) rather than an external payment.
 * Verified against real feed data: these carry `source: "INTERNAL_TRANSFER"` and
 * `counterPartyType: "CATEGORY"`.
 */
export function isInternalTransfer(item: FeedItem): boolean {
	return item.source === 'INTERNAL_TRANSFER' && item.counterPartyType === 'CATEGORY' && Boolean(item.counterPartyUid);
}

/**
 * If this feed item is an internal transfer to/from another *mapped* category, try to find
 * its already-imported peer and link the two via transfer_id — so Actual treats it as one
 * transfer, excluded from income/expense totals, instead of two unlinked transactions that
 * both count as real spending/income (the "duplicate information" this exists to prevent).
 *
 * Best-effort and order-independent: if the peer hasn't been imported yet, this is a no-op.
 * Whichever leg gets imported second — the peer's own webhook event, or a later account in
 * the same backfill loop — will find *this* transaction already sitting there and complete
 * the link from its side instead. No separate "final pass" is needed.
 */
export async function tryLinkTransfer(
	item: FeedItem,
	ownAccountId: string,
	ownTransactionId: string,
	ownAmount: number,
	date: string,
): Promise<boolean> {
	if (!isInternalTransfer(item)) return false;

	const peerMapped = await resolveAccount(item.counterPartyUid!);
	// Unmapped/disabled destination (nothing to link to), or the "transfer" is actually within
	// a single Actual account (e.g. a Space merged into its parent via `accountName`) — in
	// that case both legs already landed in the same account and linking to itself is meaningless.
	if (!peerMapped || peerMapped.actualAccountId === ownAccountId) return false;

	const peer = await findTransferPeer(peerMapped.actualAccountId, -ownAmount, date);
	if (!peer) return false;

	await linkTransferPair(ownAccountId, ownTransactionId, peerMapped.actualAccountId, peer.id);
	return true;
}

/**
 * True for a payment between two of the account holder's *own* Starling accounts that Starling
 * does not model as a same-account category transfer — e.g. one main account paying a
 * different main account, or a Space under a *different* main account. Verified against real
 * feed data: these carry `source: "ON_US_PAY_ME"` and `counterPartyType: "CUSTOMER"`, with
 * `counterPartyUid` equal to the account holder's own stable customer id on both legs,
 * regardless of which account or direction — that id is what distinguishes this from a genuine
 * payment to a third party who happens to also bank with Starling.
 */
export function isSelfTransfer(item: FeedItem, profile: StarlingProfile): boolean {
	return (
		item.source === 'ON_US_PAY_ME' &&
		item.counterPartyType === 'CUSTOMER' &&
		Boolean(profile.selfCustomerUid) &&
		item.counterPartyUid === profile.selfCustomerUid
	);
}

/**
 * Unlike isInternalTransfer, a self-transfer's counterPartyUid identifies the payer/payee
 * (you), not the destination account or category — Starling doesn't say which of your other
 * accounts the money went to/from. So instead of a direct mapping lookup, search every other
 * mapped and usable Actual account for the matching peer (same day, exact opposite amount).
 *
 * **Deliberately strict, because the signal is weaker than it looks.** Verified against real
 * feed data: `ON_US_PAY_ME` + `counterPartyType: "CUSTOMER"` + your own `counterPartyUid` does
 * *not* mean "between two of my Starling accounts" — it means "a payment where I'm the named
 * counterparty", which equally covers money sent to Chip, Wise, or an unmapped Starling account
 * (a real EUR-account transfer here was labelled `counterPartyName: "Jacob Turner"`, identical
 * to a genuine Personal <-> Public Acc transfer). Matching on amount+date alone would therefore
 * attach such a payment to whichever mapped account happened to have an equal-and-opposite
 * transaction that day. So a candidate only counts when it is itself a *real imported Starling
 * transaction* (`imported_id` set — never a hand-entered or Actual-generated row) whose
 * counterparty is the same account holder, i.e. both legs independently look like this side of
 * a self-transfer. A destination outside Starling has no such feed item and can never match.
 *
 * Ambiguity is also refused rather than guessed: if two different accounts both offer a
 * qualifying candidate, there's no way to tell which is real, so nothing is linked.
 */
export async function tryLinkSelfTransfer(
	item: FeedItem,
	profile: StarlingProfile,
	ownAccountId: string,
	ownTransactionId: string,
	ownAmount: number,
	date: string,
): Promise<boolean> {
	if (!isSelfTransfer(item, profile)) return false;

	const selfName = item.counterPartyName?.trim().toLowerCase();
	if (!selfName) return false;

	const mapping = await loadMapping();
	const candidateAccountIds = new Set(
		Object.values(mapping.categories)
			.filter(isUsable)
			.map((entry) => entry.actualAccountId)
			.filter((id) => id !== ownAccountId),
	);

	// The far leg of a genuine self-transfer is itself an imported Starling item naming the
	// same account holder — transform.ts puts counterPartyName on imported_payee.
	const isRealSelfTransferLeg = (candidate: { imported_id?: string; imported_payee?: string }) =>
		Boolean(candidate.imported_id) && candidate.imported_payee?.trim().toLowerCase() === selfName;

	const matches: { accountId: string; transactionId: string }[] = [];
	for (const candidateId of candidateAccountIds) {
		const peer = await findTransferPeer(candidateId, -ownAmount, date, isRealSelfTransferLeg);
		if (peer) matches.push({ accountId: candidateId, transactionId: peer.id });
	}

	if (matches.length !== 1) return false;

	const [match] = matches;
	await linkTransferPair(ownAccountId, ownTransactionId, match!.accountId, match!.transactionId);
	return true;
}

/** First configured externalTransfers rule (config/mapping.json) this feed item matches, if any. */
export function matchExternalTransfer(item: FeedItem, rules: ExternalTransferRule[]): ExternalTransferRule | null {
	for (const rule of rules) {
		const value = item[rule.match.field];
		if (typeof value !== 'string') continue;
		const haystack = value.toLowerCase();
		if (rule.match.equals && haystack === rule.match.equals.toLowerCase()) return rule;
		if (rule.match.contains && haystack.includes(rule.match.contains.toLowerCase())) return rule;
	}
	return null;
}

/**
 * A payment to a real third party (e.g. a credit card provider) that a configured
 * externalTransfers rule says should be tracked as a transfer to a separate, non-Starling
 * account instead of ordinary spending/income. Only links to an *existing* transaction there —
 * nothing is auto-created on an account this app doesn't own, so this is a no-op until whatever
 * process tracks that account records the matching entry.
 */
export async function tryLinkExternalTransfer(
	item: FeedItem,
	externalTransfers: ExternalTransferRule[],
	ownAccountId: string,
	ownTransactionId: string,
	ownAmount: number,
	date: string,
): Promise<boolean> {
	const rule = matchExternalTransfer(item, externalTransfers);
	if (!rule || rule.actualAccountId === ownAccountId) return false;

	const peer = await findTransferPeer(rule.actualAccountId, -ownAmount, date);
	if (!peer) return false;

	await linkTransferPair(ownAccountId, ownTransactionId, rule.actualAccountId, peer.id);
	return true;
}

/** Tries every transfer-detection mechanism in turn, stopping at the first that links. */
export async function tryLinkAnyTransfer(
	item: FeedItem,
	profile: StarlingProfile,
	externalTransfers: ExternalTransferRule[],
	ownAccountId: string,
	ownTransactionId: string,
	ownAmount: number,
	date: string,
): Promise<boolean> {
	if (await tryLinkTransfer(item, ownAccountId, ownTransactionId, ownAmount, date)) return true;
	if (await tryLinkSelfTransfer(item, profile, ownAccountId, ownTransactionId, ownAmount, date)) return true;
	return tryLinkExternalTransfer(item, externalTransfers, ownAccountId, ownTransactionId, ownAmount, date);
}
