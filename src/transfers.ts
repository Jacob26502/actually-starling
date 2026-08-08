import { findTransferPeer, linkTransferPair } from './actual.ts';
import { resolveAccount } from './mapping.ts';
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
