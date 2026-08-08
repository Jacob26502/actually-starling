import { createHash, timingSafeEqual } from 'node:crypto';
import { config, type StarlingProfile } from './config.ts';

export type Direction = 'IN' | 'OUT';

export interface CurrencyAndAmount {
	currency: string;
	minorUnits: number;
}

/** Subset of Starling's FeedItem we rely on. Extra fields are ignored. */
export interface FeedItem {
	feedItemUid: string;
	categoryUid: string;
	accountUid?: string;
	amount: CurrencyAndAmount;
	sourceAmount?: CurrencyAndAmount;
	direction: Direction;
	transactionTime: string;
	settlementTime?: string;
	updatedAt?: string;
	source?: string;
	sourceSubType?: string;
	status?: string;
	counterPartyType?: string;
	counterPartyName?: string;
	/**
	 * For an internal transfer (source: "INTERNAL_TRANSFER", counterPartyType: "CATEGORY"),
	 * this is the *destination category's* categoryUid — not a specific transaction id. Used
	 * by transfers.ts to look up which Actual account the other leg landed in.
	 */
	counterPartyUid?: string;
	reference?: string;
	spendingCategory?: string;
	userNote?: string;
}

export interface FeedItemWebhookPayload {
	webhookEventUid: string;
	eventTimestamp: string;
	accountHolderUid: string;
	content: FeedItem;
}

export interface StarlingAccount {
	accountUid: string;
	defaultCategory: string;
	currency: string;
	name?: string;
	accountType?: string;
}

/** A Starling (account, category) pair — the main account itself or one of its Spaces. */
export interface StarlingCategory {
	/** Which configured token this was found through. */
	profile: string;
	accountUid: string;
	categoryUid: string;
	label: string;
	currency: string;
	accountType?: string;
	kind: 'main' | 'savings-goal' | 'spending-space';
	/**
	 * Current real balance, in this category's own minor units, always non-negative — money
	 * literally present. For `kind: 'main'` this is `clearedBalance` (the spendable pot,
	 * excluding money already moved into Spaces — those are separate categories with their
	 * own balance). Absent if the balance couldn't be determined.
	 */
	balanceMinorUnits?: number;
}

export class StarlingError extends Error {
	status: number;

	constructor(message: string, status: number) {
		super(message);
		this.name = 'StarlingError';
		this.status = status;
	}
}

/**
 * Starling signs webhooks as base64(sha512(secret + rawBody)) in `X-Hook-Signature`.
 * Must be given the raw request body — re-serialised JSON will not match.
 */
export function verifyWebhookSignature(rawBody: string, signature: string | undefined, secret: string): boolean {
	if (!signature || !secret) return false;
	const expected = createHash('sha512').update(secret + rawBody, 'utf8').digest('base64');
	const a = Buffer.from(expected, 'utf8');
	const b = Buffer.from(signature, 'utf8');
	if (a.length !== b.length) return false;
	return timingSafeEqual(a, b);
}

/**
 * Each Starling account registers its own webhook with its own shared secret, so a single
 * endpoint has to work out which one signed this request. Returns the matching profile,
 * or null if no configured secret validates it.
 */
export function resolveWebhookProfile(rawBody: string, signature: string | undefined): StarlingProfile | null {
	for (const profile of config.starling.profiles) {
		if (verifyWebhookSignature(rawBody, signature, profile.webhookSecret)) return profile;
	}
	return null;
}

export function profilesWithWebhookSecret(): StarlingProfile[] {
	return config.starling.profiles.filter((profile) => Boolean(profile.webhookSecret));
}

const MAX_RATE_LIMIT_RETRIES = 5;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function starlingGet<T>(profile: StarlingProfile, path: string, params?: Record<string, string>): Promise<T> {
	const url = new URL(path, config.starling.apiUrl);
	for (const [key, value] of Object.entries(params ?? {})) url.searchParams.set(key, value);

	for (let attempt = 0; ; attempt++) {
		const res = await fetch(url, {
			headers: {
				Authorization: `Bearer ${profile.accessToken}`,
				Accept: 'application/json',
				'User-Agent': 'actually-starling',
			},
		});

		if (res.ok) return (await res.json()) as T;

		// A backfill across several accounts/months can throw dozens of requests at Starling
		// in quick succession — retry 429s with backoff instead of aborting the whole run.
		if (res.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
			const retryAfterHeader = res.headers.get('retry-after');
			const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : NaN;
			const delayMs = Number.isFinite(retryAfterMs) ? retryAfterMs : 2 ** attempt * 1000;
			console.warn(`[starling] 429 on ${path}, retrying in ${delayMs}ms (attempt ${attempt + 1}/${MAX_RATE_LIMIT_RETRIES})`);
			await sleep(delayMs);
			continue;
		}

		const body = await res.text().catch(() => '');
		throw new StarlingError(`Starling ${res.status} on ${path} (profile "${profile.name}"): ${body.slice(0, 400)}`, res.status);
	}
}

export async function getAccounts(profile: StarlingProfile): Promise<StarlingAccount[]> {
	const data = await starlingGet<{ accounts: StarlingAccount[] }>(profile, '/api/v2/accounts');
	return data.accounts ?? [];
}

type AccountBalanceResponse = { clearedBalance?: CurrencyAndAmount };

/**
 * The main account's current spendable balance — `clearedBalance`, not `totalClearedBalance`
 * (which also includes money held in this account's Spaces, double-counting balances that
 * are tracked as their own separate categories).
 */
export async function getAccountBalance(profile: StarlingProfile, accountUid: string): Promise<CurrencyAndAmount | null> {
	const data = await starlingGet<AccountBalanceResponse>(profile, `/api/v2/accounts/${accountUid}/balance`);
	return data.clearedBalance ?? null;
}

/**
 * Enumerate every (accountUid, categoryUid) pair visible across all configured tokens.
 *
 * Spaces live behind `/spaces` on current Starling accounts, but older accounts only
 * expose `/savings-goals`, so we try the former and fall back. Either way a space's own
 * uid doubles as its categoryUid, which is what feed items and webhooks are keyed on.
 */
export async function discoverCategories(): Promise<StarlingCategory[]> {
	const perProfile = await Promise.all(
		config.starling.profiles.map(async (profile) => {
			const found: StarlingCategory[] = [];
			for (const account of await getAccounts(profile)) {
				const accountLabel = account.name ?? account.accountType ?? 'Starling';
				const balance = await getAccountBalance(profile, account.accountUid).catch(() => null);
				found.push({
					profile: profile.name,
					accountUid: account.accountUid,
					categoryUid: account.defaultCategory,
					label: accountLabel,
					currency: account.currency,
					accountType: account.accountType,
					kind: 'main',
					balanceMinorUnits: balance?.minorUnits,
				});

				for (const space of await getSpaces(profile, account.accountUid)) {
					found.push({
						...space,
						currency: space.currency || account.currency,
						accountType: account.accountType,
					});
				}
			}
			return found;
		}),
	);
	return perProfile.flat();
}

type SpacesResponse = {
	savingsGoals?: { savingsGoalUid: string; name?: string; totalSaved?: CurrencyAndAmount }[];
	spendingSpaces?: { spaceUid: string; name?: string; balance?: CurrencyAndAmount }[];
};

async function getSpaces(profile: StarlingProfile, accountUid: string): Promise<StarlingCategory[]> {
	let data: SpacesResponse;
	try {
		data = await starlingGet<SpacesResponse>(profile, `/api/v2/account/${accountUid}/spaces`);
	} catch (err) {
		if (err instanceof StarlingError && (err.status === 404 || err.status === 403)) {
			data = await starlingGet<SpacesResponse>(profile, `/api/v2/account/${accountUid}/savings-goals`).catch(() => ({}));
		} else {
			throw err;
		}
	}

	const spaces: StarlingCategory[] = [];
	for (const goal of data.savingsGoals ?? []) {
		spaces.push({
			profile: profile.name,
			accountUid,
			categoryUid: goal.savingsGoalUid,
			label: goal.name ?? 'Savings goal',
			currency: goal.totalSaved?.currency ?? '',
			kind: 'savings-goal',
			balanceMinorUnits: goal.totalSaved?.minorUnits,
		});
	}
	for (const space of data.spendingSpaces ?? []) {
		spaces.push({
			profile: profile.name,
			accountUid,
			categoryUid: space.spaceUid,
			label: space.name ?? 'Spending space',
			currency: space.balance?.currency ?? '',
			kind: 'spending-space',
			balanceMinorUnits: space.balance?.minorUnits,
		});
	}
	return spaces;
}

export async function getFeedItemsBetween(
	profile: StarlingProfile,
	accountUid: string,
	categoryUid: string,
	minTransactionTimestamp: string,
	maxTransactionTimestamp: string,
): Promise<FeedItem[]> {
	const data = await starlingGet<{ feedItems: FeedItem[] }>(
		profile,
		`/api/v2/feed/account/${accountUid}/category/${categoryUid}/transactions-between`,
		{ minTransactionTimestamp, maxTransactionTimestamp },
	);
	return data.feedItems ?? [];
}
