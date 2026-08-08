import { readFile } from 'node:fs/promises';
import { config } from './config.ts';
import type { FeedItem } from './starling.ts';
import type { ActualTransaction } from './transform.ts';

/** FeedItem fields worth matching rules against — free text a user might recognise. */
const MATCHABLE_FIELDS = ['userNote', 'reference', 'counterPartyName', 'spendingCategory', 'source'] as const;
export type MatchableField = (typeof MATCHABLE_FIELDS)[number];

export interface RuleCondition {
	field: MatchableField;
	/** Case-insensitive substring match. Only matcher supported for now. */
	contains: string;
}

export interface Rule {
	name: string;
	/** All conditions must match (AND) — no OR/anyOf yet, add if it's actually needed. */
	when: RuleCondition[];
	then: {
		/** An Actual category name — created lazily, same as Starling's own categories. */
		category?: string;
		payee?: string;
		notes?: string;
	};
}

export interface RulesFile {
	rules: Rule[];
}

let cache: RulesFile | null = null;

export async function loadRules(): Promise<RulesFile> {
	if (cache) return cache;
	try {
		const raw = await readFile(config.rulesPath, 'utf8');
		const parsed = JSON.parse(raw) as RulesFile;
		cache = { rules: parsed.rules ?? [] };
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
			console.warn(`[rules] no rules file at ${config.rulesPath} — no rules will be applied`);
			cache = { rules: [] };
		} else {
			throw err;
		}
	}
	return cache;
}

export function invalidateRules(): void {
	cache = null;
}

function matchesConditions(item: FeedItem, conditions: RuleCondition[]): boolean {
	return conditions.every((condition) => {
		const value = item[condition.field];
		if (typeof value !== 'string') return false;
		return value.toLowerCase().includes(condition.contains.toLowerCase());
	});
}

/**
 * Apply every matching rule's overrides on top of a transform.ts-produced transaction. Pure —
 * matches against the raw FeedItem (so rules can see fields transform.ts doesn't carry
 * through, like userNote or reference) and only ever returns a modified copy.
 *
 * Later rules win on conflicting fields if more than one matches, applied in file order.
 */
export function applyRules(item: FeedItem, transaction: ActualTransaction, rules: Rule[]): ActualTransaction {
	let result = transaction;
	for (const rule of rules) {
		if (!matchesConditions(item, rule.when)) continue;
		result = {
			...result,
			...(rule.then.category ? { categoryOverride: rule.then.category } : {}),
			...(rule.then.payee ? { payee_name: rule.then.payee } : {}),
			...(rule.then.notes ? { notes: rule.then.notes } : {}),
		};
	}
	return result;
}
