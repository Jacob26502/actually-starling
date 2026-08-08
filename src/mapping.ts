import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { config } from './config.ts';

export interface MappingEntry {
	actualAccountId: string;
	/** Human label, only for readability of the config file and logs. */
	label?: string;
	/** Set false to knowingly ignore a Starling category without it showing up as unmapped. */
	enabled?: boolean;
	/**
	 * Overrides the Actual account name bootstrap would generate. Give two categories the
	 * same `accountName` to collapse them into one Actual account — e.g. a savings account
	 * whose balance really lives in a single Space, where separate accounts would be noise.
	 */
	accountName?: string;
	/** Which configured Starling token this category belongs to; used by backfill. */
	profile?: string;
	/** Recorded for readability only; lookups never key on it — see loadMapping(). */
	starlingAccountUid?: string;
	kind?: string;
}

export interface MappingFile {
	categories: Record<string, MappingEntry>;
}

let cache: MappingFile | null = null;

/**
 * Mapping is keyed on Starling's `categoryUid` because that is the only account-identifying
 * field guaranteed to be on every feed item and webhook payload — `accountUid` is often
 * omitted, since feed items are normally fetched via a URL that already contains it.
 */
export async function loadMapping(): Promise<MappingFile> {
	if (cache) return cache;
	try {
		const raw = await readFile(config.mappingPath, 'utf8');
		const parsed = JSON.parse(raw) as MappingFile;
		cache = { categories: parsed.categories ?? {} };
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
			console.warn(`[mapping] no mapping file at ${config.mappingPath} — every category will be unmapped`);
			cache = { categories: {} };
		} else {
			throw err;
		}
	}
	return cache;
}

export function invalidateMapping(): void {
	cache = null;
}

export async function saveMapping(mapping: MappingFile): Promise<void> {
	await mkdir(dirname(config.mappingPath), { recursive: true });
	await writeFile(config.mappingPath, `${JSON.stringify(mapping, null, 2)}\n`, 'utf8');
	cache = mapping;
}

/**
 * True once the entry actually points at an Actual account and hasn't been disabled.
 *
 * Deliberately not a type guard: an entry with a blank `actualAccountId` is still a valid
 * entry (that's how bootstrap records "discovered but not wired up"), so narrowing it out
 * of the false branch would be wrong.
 */
export function isUsable(entry: MappingEntry | undefined): boolean {
	return Boolean(entry?.actualAccountId) && entry?.enabled !== false;
}

export async function resolveAccount(categoryUid: string): Promise<MappingEntry | null> {
	const mapping = await loadMapping();
	const entry = mapping.categories[categoryUid];
	return entry && isUsable(entry) ? entry : null;
}
