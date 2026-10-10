import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createLlmToken, fetchLiveModels, fetchUserMe } from "./src/api.js";
import { startBrowserSignIn } from "./src/browser-auth.js";
import { readCredentialsFromSecretTool, readLocalZedCredentials } from "./src/keyring.js";
import { KNOWN_MODELS, type ZedModelDefinition } from "./src/models.js";
import { invalidateCachedLlmToken, streamZedModel } from "./src/stream.js";

interface ZedAuthPayload {
	userId: string;
	accessToken: string;
}

function encodeZedCredentials(creds: ZedAuthPayload): OAuthCredentials {
	return {
		access: JSON.stringify(creds),
		refresh: creds.accessToken,
		// Zed desktop access tokens are long-lived sessions (no fixed expiration)
		expires: Date.now() + 365 * 24 * 60 * 60 * 1000,
	};
}

function decodeZedCredentials(credentials: OAuthCredentials): ZedAuthPayload {
	const raw = credentials.access;
	if (raw.startsWith("{")) {
		try {
			const parsed = JSON.parse(raw);
			if (parsed.userId && parsed.accessToken) {
				return parsed;
			}
		} catch {
			// ignore
		}
	}
	const spaceIdx = raw.indexOf(" ");
	if (spaceIdx > 0) {
		return {
			userId: raw.slice(0, spaceIdx).trim(),
			accessToken: raw.slice(spaceIdx + 1).trim(),
		};
	}
	throw new Error("Invalid Zed credentials payload");
}

async function loginZed(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	// 1. Check if user is already signed into Zed desktop or env
	const localCreds = await readLocalZedCredentials();

	if (localCreds) {
		const useLocal = await callbacks.confirm?.(
			`Found existing Zed desktop credentials for user ID ${localCreds.userId}. Use them?`,
		);

		if (useLocal !== false) {
			callbacks.progress?.("Verifying Zed credentials...");
			const user = await fetchUserMe(localCreds.userId, localCreds.accessToken);
			callbacks.progress?.(`Authenticated as ${user.user.username} (${user.plan.plan})`);
			invalidateCachedLlmToken();
			return encodeZedCredentials(localCreds);
		}
	}

	// 2. Browser sign-in flow
	callbacks.progress?.("Starting Zed browser sign-in...");
	const result = await startBrowserSignIn(async (authUrl) => {
		callbacks.progress?.("Opening Zed login in your browser...");
		await callbacks.openUrl?.(authUrl);
		callbacks.progress?.("Waiting for authentication in browser...");
	}, callbacks.signal);

	callbacks.progress?.("Verifying credentials...");
	const user = await fetchUserMe(result.userId, result.accessToken);
	callbacks.progress?.(`Authenticated as ${user.user.username} (${user.plan.plan})`);
	invalidateCachedLlmToken();

	return encodeZedCredentials(result);
}

async function refreshZedToken(
	credentials: OAuthCredentials,
	signal: AbortSignal,
): Promise<OAuthCredentials> {
	invalidateCachedLlmToken();
	// Check if newer credentials exist in keyring (desktop app re-login)
	const fresh = await readCredentialsFromSecretTool();
	if (fresh) {
		await fetchUserMe(fresh.userId, fresh.accessToken);
		return encodeZedCredentials(fresh);
	}

	const decoded = decodeZedCredentials(credentials);
	await fetchUserMe(decoded.userId, decoded.accessToken);
	return credentials;
}

export default async function (pi: ExtensionAPI) {
	let modelsToRegister: ZedModelDefinition[] = KNOWN_MODELS;

	// Attempt to query live available models from Zed if logged in
	try {
		const localCreds = await readLocalZedCredentials();
		if (localCreds) {
			const llmToken = await createLlmToken(localCreds.userId, localCreds.accessToken);
			const live = await fetchLiveModels(llmToken);
			if (live.length > 0) {
				modelsToRegister = live;
			}
		}
	} catch {
		// Fall back to KNOWN_MODELS catalog
	}

	pi.registerProvider("zed", {
		baseUrl: "https://cloud.zed.dev",
		apiKey: "zed-models",
		api: "zed-completions-api",
		models: modelsToRegister.map(({ id, name, reasoning, input, cost, contextWindow, maxTokens }) => ({
			id,
			name,
			reasoning,
			input,
			cost,
			contextWindow,
			maxTokens,
		})),
		oauth: {
			name: "Zed Hosted Models",
			login: loginZed,
			refreshToken: refreshZedToken,
			getApiKey: (cred) => cred.access,
		},
		streamSimple: streamZedModel,
	});
}
