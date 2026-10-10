import { randomUUID } from "node:crypto";
import type { ZedModelDefinition } from "./models.js";

export const CLOUD_URL = "https://cloud.zed.dev";
// Keep in sync with the Zed client you have installed; the cloud gates on these
// (x-zed-version / x-zed-minimum-required-version).
export const ZED_VERSION = process.env.ZED_CLIENT_VERSION ?? "1.23.2";
export const USER_AGENT = `Zed/${ZED_VERSION} (linux; x86_64)`;

export interface ZedRawModel {
	id: string;
	provider: "anthropic" | "open_ai" | "google";
	display_name: string;
	max_token_count: number;
	max_output_tokens: number;
	supports_tools: boolean;
	supports_images: boolean;
	supports_thinking: boolean;
}

export interface ZedTokenResponse {
	token: string;
}

export interface UserMeResponse {
	user: {
		id: number;
		username: string;
		github_login: string;
	};
	plan: {
		plan: string;
	};
}

export async function fetchUserMe(userId: string, accessToken: string): Promise<UserMeResponse> {
	const res = await fetch(`${CLOUD_URL}/client/users/me`, {
		headers: {
			Authorization: `${userId} ${accessToken}`,
			"User-Agent": USER_AGENT,
		},
	});
	if (!res.ok) {
		const text = await res.text();
		throw new Error(`Failed to verify Zed user (${res.status}): ${text}`);
	}
	return (await res.json()) as UserMeResponse;
}

export async function createLlmToken(
	userId: string,
	accessToken: string,
	systemId: string = randomUUID(),
	organizationId: string | null = null,
): Promise<string> {
	const res = await fetch(`${CLOUD_URL}/client/llm_tokens`, {
		method: "POST",
		headers: {
			Authorization: `${userId} ${accessToken}`,
			"Content-Type": "application/json",
			"User-Agent": USER_AGENT,
			"x-zed-system-id": systemId,
		},
		body: JSON.stringify({ organization_id: organizationId }),
	});

	if (!res.ok) {
		const text = await res.text();
		throw new Error(`Failed to create Zed LLM token (${res.status}): ${text}`);
	}

	const data = (await res.json()) as ZedTokenResponse;
	return data.token;
}

export async function fetchLiveModels(llmToken: string): Promise<ZedModelDefinition[]> {
	const res = await fetch(`${CLOUD_URL}/models`, {
		headers: {
			Authorization: `Bearer ${llmToken}`,
			"User-Agent": USER_AGENT,
			"x-zed-client-supports-x-ai": "true",
		},
	});

	if (!res.ok) {
		const text = await res.text();
		throw new Error(`Failed to fetch models from Zed (${res.status}): ${text}`);
	}

	const data = (await res.json()) as { models?: ZedRawModel[] };
	const rawList = data.models ?? [];

	return rawList.map((m) => {
		const provider = m.provider === "open_ai" ? "openai" : (m.provider as "anthropic" | "google");
		return {
			id: m.id,
			name: `${m.display_name} (Zed)`,
			provider,
			reasoning: m.supports_thinking ?? true,
			input: m.supports_images ? ["text", "image"] : ["text"],
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
			},
			contextWindow: m.max_token_count || 200000,
			maxTokens: m.max_output_tokens || 16384,
		};
	});
}

export async function sendZedCompletion(
	llmToken: string,
	provider: string,
	model: string,
	providerRequest: Record<string, unknown>,
	options?: { signal?: AbortSignal; systemId?: string },
): Promise<Response> {
	return await fetch(`${CLOUD_URL}/completions`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${llmToken}`,
			"Content-Type": "application/json",
			"User-Agent": USER_AGENT,
			"x-zed-version": ZED_VERSION,
			"x-zed-client-supports-status-messages": "true",
			"x-zed-client-supports-stream-ended-request-completion-status": "true",
			...(options?.systemId ? { "x-zed-system-id": options.systemId } : {}),
		},
		// Body mirrors Zed's CompletionBody: { thread_id?, prompt_id?, provider, model, provider_request }.
		body: JSON.stringify({ provider, model, provider_request: providerRequest }),
		signal: options?.signal,
	});
}
