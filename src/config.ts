function required(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`Missing required env var: ${name}`);
	return value;
}

/**
 * One Starling personal access token and its webhook public key.
 *
 * A Starling token is scoped to a single account holder, and personal vs business are
 * separate account holders — so covering several real-world accounts needs several tokens.
 */
export interface StarlingProfile {
	name: string;
	accessToken: string;
	/**
	 * Base64 DER (SPKI) RSA public key from the webhook's registration page. Starling's V2
	 * webhook security signs the raw payload with SHA512withRSA using the *private* half of
	 * this key pair — this is not a shared secret, don't treat it like an HMAC key.
	 */
	webhookPublicKey: string;
}

function envKey(profileName: string): string {
	return profileName.toUpperCase().replaceAll(/[^A-Z0-9]/g, '_');
}

function parseProfiles(): StarlingProfile[] {
	const names = (process.env.STARLING_ACCOUNTS ?? '')
		.split(',')
		.map((name) => name.trim())
		.filter(Boolean);

	if (names.length === 0) {
		throw new Error('STARLING_ACCOUNTS must list at least one profile name, e.g. STARLING_ACCOUNTS=primary,secondary');
	}

	return names.map((name) => {
		const key = envKey(name);
		return {
			name,
			accessToken: required(`STARLING_${key}_TOKEN`),
			webhookPublicKey: process.env[`STARLING_${key}_WEBHOOK_PUBLIC_KEY`] ?? '',
		};
	});
}

export const config = {
	port: Number(process.env.PORT ?? 3000),
	/** IANA zone used to derive the Actual transaction date from Starling's UTC timestamps. */
	timezone: process.env.STARLING_TIMEZONE ?? 'Europe/London',
	/**
	 * An Actual budget is single-currency, so anything in another currency would import at
	 * face value (€50.00 becoming £50.00). Feed items not in this currency are refused.
	 */
	budgetCurrency: (process.env.BUDGET_CURRENCY ?? 'GBP').toUpperCase(),
	starling: {
		apiUrl: process.env.STARLING_API_URL ?? 'https://api.starlingbank.com',
		profiles: parseProfiles(),
	},
	actual: {
		serverUrl: required('ACTUAL_SERVER_URL'),
		password: required('ACTUAL_SERVER_PASSWORD'),
		/** Actual's "Sync ID" from Settings → Advanced, not the budget name. */
		syncId: required('ACTUAL_SYNC_ID'),
		/** Only needed when the budget file is end-to-end encrypted. */
		budgetPassword: process.env.ACTUAL_BUDGET_PASSWORD || undefined,
		dataDir: process.env.ACTUAL_DATA_DIR ?? './.actual-cache',
	},
	mappingPath: process.env.MAPPING_PATH ?? './config/mapping.json',
	rulesPath: process.env.RULES_PATH ?? './config/rules.json',
} as const;

export function findProfile(name: string): StarlingProfile | undefined {
	return config.starling.profiles.find((profile) => profile.name === name);
}
