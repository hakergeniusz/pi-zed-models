import type {
	Api,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Model,
	SimpleStreamOptions,
	TranscriptContext,
} from "@earendil-works/pi-ai/compat";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import { createLlmToken, sendZedCompletion } from "./api.js";
import { MODEL_MAP, type ZedModelDefinition } from "./models.js";

// Cache LLM token across streaming calls
let cachedLlmToken: string | null = null;
let cachedTokenUserId: string | null = null;
let cachedSystemId: string | null = null;

export function invalidateCachedLlmToken(): void {
	cachedLlmToken = null;
	cachedTokenUserId = null;
	cachedSystemId = null;
}

function currentSystemId(): string | undefined {
	return cachedSystemId ?? undefined;
}

export async function getOrMintLlmToken(userId: string, accessToken: string): Promise<string> {
	if (cachedLlmToken && cachedTokenUserId === userId) {
		return cachedLlmToken;
	}
	const systemId = crypto.randomUUID();
	const token = await createLlmToken(userId, accessToken, systemId);
	cachedLlmToken = token;
	cachedTokenUserId = userId;
	cachedSystemId = systemId;
	return token;
}

function parseCredentials(apiKeyOrCreds: string): { userId: string; accessToken: string } {
	const trimmed = apiKeyOrCreds.trim();
	if (trimmed.startsWith("{")) {
		try {
			const parsed = JSON.parse(trimmed);
			if (parsed.userId && parsed.accessToken) {
				return { userId: String(parsed.userId), accessToken: String(parsed.accessToken) };
			}
		} catch {
			// fallback
		}
	}
	const spaceIdx = trimmed.indexOf(" ");
	if (spaceIdx > 0) {
		return {
			userId: trimmed.slice(0, spaceIdx).trim(),
			accessToken: trimmed.slice(spaceIdx + 1).trim(),
		};
	}
	throw new Error("Invalid Zed credentials format. Run /login zed-models or sign into Zed desktop.");
}

function convertTranscriptToAnthropicMessages(context: TranscriptContext): {
	system?: string;
	messages: Array<{ role: string; content: unknown }>;
} {
	const systemParts: string[] = [];
	const messages: Array<{ role: string; content: unknown }> = [];

	for (const msg of context.messages) {
		if (msg.role === "system") {
			const text = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
			systemParts.push(text);
			continue;
		}

		if (msg.role === "user") {
			let content: unknown = msg.content;
			if (typeof content === "string") {
				content = [{ type: "text", text: content }];
			}
			messages.push({ role: "user", content });
			continue;
		}

		if (msg.role === "assistant") {
			const blocks: unknown[] = [];
			if (typeof msg.content === "string" && msg.content) {
				blocks.push({ type: "text", text: msg.content });
			} else if (Array.isArray(msg.content)) {
				for (const part of msg.content) {
					if (typeof part === "string") {
						blocks.push({ type: "text", text: part });
					} else if (part && typeof part === "object") {
						blocks.push(part);
					}
				}
			}

			// Tool calls
			if (msg.toolCalls && msg.toolCalls.length > 0) {
				for (const tc of msg.toolCalls) {
					blocks.push({
						type: "tool_use",
						id: tc.id,
						name: tc.name,
						input: tc.parameters ?? {},
					});
				}
			}

			if (blocks.length > 0) {
				messages.push({ role: "assistant", content: blocks });
			}
			continue;
		}

		if (msg.role === "toolResult") {
			const toolResult = {
				type: "tool_result",
				tool_use_id: msg.toolCallId,
				content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
				is_error: msg.isError === true,
			};

			const last = messages[messages.length - 1];
			if (last && last.role === "user" && Array.isArray(last.content)) {
				last.content.push(toolResult);
			} else {
				messages.push({ role: "user", content: [toolResult] });
			}
		}
	}

	return {
		system: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
		messages,
	};
}

function convertTranscriptToOpenAiMessages(context: TranscriptContext): Array<Record<string, unknown>> {
	const messages: Array<Record<string, unknown>> = [];

	for (const msg of context.messages) {
		if (msg.role === "system") {
			messages.push({
				role: "system",
				content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
			});
			continue;
		}

		if (msg.role === "user") {
			messages.push({
				role: "user",
				content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
			});
			continue;
		}

		if (msg.role === "assistant") {
			const m: Record<string, unknown> = {
				role: "assistant",
				content: typeof msg.content === "string" ? msg.content : "",
			};
			if (msg.toolCalls && msg.toolCalls.length > 0) {
				m.tool_calls = msg.toolCalls.map((tc) => ({
					id: tc.id,
					type: "function",
					function: {
						name: tc.name,
						arguments: JSON.stringify(tc.parameters ?? {}),
					},
				}));
			}
			messages.push(m);
			continue;
		}

		if (msg.role === "toolResult") {
			messages.push({
				role: "tool",
				tool_call_id: msg.toolCallId,
				content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
			});
		}
	}

	return messages;
}

/**
 * Zed proxies OpenAI models through the OpenAI Responses API, not Chat Completions.
 * A chat-completions payload is rejected by the gateway with
 * "failed to parse OpenAI Responses API request: missing field `input`".
 */
function convertTranscriptToOpenAiResponses(context: TranscriptContext): {
	instructions?: string;
	input: Array<Record<string, unknown>>;
} {
	const instructionParts: string[] = [];
	const input: Array<Record<string, unknown>> = [];

	const textOf = (content: unknown): string => {
		if (typeof content === "string") return content;
		if (!Array.isArray(content)) return JSON.stringify(content);
		return content
			.map((part) => {
				if (typeof part === "string") return part;
				if (part && typeof part === "object" && "text" in part) return String((part as { text: unknown }).text ?? "");
				return "";
			})
			.filter(Boolean)
			.join("");
	};

	for (const msg of context.messages) {
		if (msg.role === "system") {
			instructionParts.push(textOf(msg.content));
			continue;
		}

		if (msg.role === "user") {
			input.push({ role: "user", content: [{ type: "input_text", text: textOf(msg.content) }] });
			continue;
		}

		if (msg.role === "assistant") {
			const text = textOf(msg.content);
			if (text) input.push({ role: "assistant", content: [{ type: "output_text", text }] });
			for (const tc of msg.toolCalls ?? []) {
				input.push({
					type: "function_call",
					call_id: tc.id,
					name: tc.name,
					arguments: JSON.stringify(tc.parameters ?? {}),
				});
			}
			continue;
		}

		if (msg.role === "toolResult") {
			input.push({
				type: "function_call_output",
				call_id: msg.toolCallId,
				output: msg.isError === true ? `Error: ${textOf(msg.content)}` : textOf(msg.content),
			});
		}
	}

	return {
		instructions: instructionParts.length > 0 ? instructionParts.join("\n\n") : undefined,
		input,
	};
}

export function streamZedModel(
	model: Model<Api>,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();

	(async () => {
		try {
			const credsKey = options?.apiKey;
			if (!credsKey) {
				throw new Error("No Zed credentials found. Run /login zed-models or sign into Zed desktop.");
			}

			const { userId, accessToken } = parseCredentials(credsKey);
			const modelDef = MODEL_MAP.get(model.id) ?? {
				id: model.id,
				name: model.name,
				provider: (model.provider === "openai" || model.provider === "google" ? model.provider : "anthropic") as
					| "anthropic"
					| "openai"
					| "google",
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: model.contextWindow || 200000,
				maxTokens: model.maxTokens || 16384,
			};

			let llmToken = await getOrMintLlmToken(userId, accessToken);

			const provider = modelDef.provider === "openai" ? "open_ai" : modelDef.provider;
			let providerRequest: Record<string, unknown>;

			if (modelDef.provider === "anthropic") {
				const { system, messages } = convertTranscriptToAnthropicMessages(context);
				providerRequest = {
					model: model.id,
					messages,
					stream: true,
					max_tokens: Math.min(options?.maxTokens || modelDef.maxTokens, modelDef.maxTokens),
				};
				if (system) providerRequest.system = system;

				// Convert tools
				if (context.tools && context.tools.length > 0) {
					providerRequest.tools = context.tools.map((t) => ({
						name: t.name,
						description: t.description || "",
						input_schema: t.parameters || { type: "object", properties: {} },
					}));
				}
			} else if (modelDef.provider === "openai") {
				// OpenAI Responses API
				const { instructions, input } = convertTranscriptToOpenAiResponses(context);
				providerRequest = {
					model: model.id,
					input,
					stream: true,
					max_output_tokens: Math.min(options?.maxTokens || modelDef.maxTokens, modelDef.maxTokens),
				};
				if (instructions) providerRequest.instructions = instructions;
				if (context.tools && context.tools.length > 0) {
					providerRequest.tools = context.tools.map((t) => ({
						type: "function",
						name: t.name,
						description: t.description || "",
						parameters: t.parameters || { type: "object", properties: {} },
					}));
				}
			} else {
				// Google format
				const messages = convertTranscriptToOpenAiMessages(context);
				providerRequest = {
					model: model.id,
					messages,
					stream: true,
					max_tokens: Math.min(options?.maxTokens || modelDef.maxTokens, modelDef.maxTokens),
				};
				if (context.tools && context.tools.length > 0) {
					providerRequest.tools = context.tools.map((t) => ({
						type: "function",
						function: {
							name: t.name,
							description: t.description || "",
							parameters: t.parameters || { type: "object", properties: {} },
						},
					}));
				}
			}

			const requestOpts = { signal: options?.signal, systemId: currentSystemId() };
			let response = await sendZedCompletion(llmToken, provider, model.id, providerRequest, requestOpts);

			if (response.status === 401) {
				invalidateCachedLlmToken();
				llmToken = await getOrMintLlmToken(userId, accessToken);
				response = await sendZedCompletion(llmToken, provider, model.id, providerRequest, requestOpts);
			}

			if (!response.ok) {
				const errBody = await response.text();
				throw new Error(`Zed completion error (${response.status}): ${errBody}`);
			}

			if (!response.body) {
				throw new Error("No response body from Zed API");
			}

			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = "";

			const messageId = `msg_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
			let currentText = "";
			let inputTokens = 0;
			let outputTokens = 0;
			let stopReason = "stop";

			const toolCallsMap = new Map<number | string, { id: string; name: string; rawArgs: string }>();

			// Emit initial start event
			stream.push({
				type: "start",
				message: {
					role: "assistant",
					content: [],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					timestamp: Date.now(),
				},
			});

			const processLine = (line: string) => {
				const trimmed = line.trim();
				if (!trimmed) return;

				let parsed: any;
				try {
					parsed = JSON.parse(trimmed);
				} catch {
					return;
				}

				if (parsed.status?.failed) {
					throw new Error(parsed.status.failed.message || "Zed upstream failure");
				}

				const ev = parsed.event || (parsed.type ? parsed : null);
				if (!ev) return;

				// Anthropic events
				if (ev.type === "content_block_delta") {
					if (ev.delta?.type === "text_delta") {
						const chunk = ev.delta.text;
						currentText += chunk;
						stream.push({
							type: "text_delta",
							contentIndex: 0,
							delta: chunk,
						});
					} else if (ev.delta?.type === "input_json_delta") {
						const idx = ev.index ?? 0;
						const tc = toolCallsMap.get(idx);
						if (tc) {
							tc.rawArgs += ev.delta.partial_json;
						}
					}
				} else if (ev.type === "content_block_start") {
					if (ev.content_block?.type === "tool_use") {
						const idx = ev.index ?? toolCallsMap.size;
						toolCallsMap.set(idx, {
							id: ev.content_block.id,
							name: ev.content_block.name,
							rawArgs: "",
						});
					}
				} else if (ev.type === "message_start") {
					if (ev.message?.usage) {
						inputTokens = ev.message.usage.input_tokens || 0;
					}
				} else if (ev.type === "message_delta") {
					if (ev.delta?.stop_reason) {
						stopReason = ev.delta.stop_reason === "tool_use" ? "toolUse" : "stop";
					}
					if (ev.usage) {
						outputTokens = ev.usage.output_tokens || 0;
					}
				}

				// OpenAI Responses API events
				else if (ev.type === "response.output_text.delta") {
					const chunk = ev.delta;
					currentText += chunk;
					stream.push({
						type: "text_delta",
						contentIndex: 0,
						delta: chunk,
					});
				} else if (ev.type === "response.output_item.added") {
					if (ev.item?.type === "function_call") {
						const idx = ev.output_index ?? toolCallsMap.size;
						toolCallsMap.set(idx, {
							id: ev.item.call_id,
							name: ev.item.name,
							rawArgs: "",
						});
					}
				} else if (ev.type === "response.function_call_arguments.delta") {
					const idx = ev.output_index ?? toolCallsMap.size - 1;
					const tc = toolCallsMap.get(idx);
					if (tc) {
						tc.rawArgs += ev.delta;
					}
				} else if (ev.type === "response.completed") {
					if (ev.response?.usage) {
						inputTokens = ev.response.usage.input_tokens || 0;
						outputTokens = ev.response.usage.output_tokens || 0;
					}
				}
			};

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";

				for (const line of lines) {
					processLine(line);
				}
			}

			if (buffer.trim()) {
				processLine(buffer);
			}

			// Emit completed message
			const finalContent: any[] = [];
			if (currentText) {
				finalContent.push({ type: "text", text: currentText });
			}

			const toolCalls: any[] = [];
			for (const tc of toolCallsMap.values()) {
				let parsedArgs = {};
				try {
					parsedArgs = JSON.parse(tc.rawArgs);
				} catch {
					// empty args
				}
				toolCalls.push({
					id: tc.id,
					name: tc.name,
					parameters: parsedArgs,
				});
				finalContent.push({
					type: "toolCall",
					id: tc.id,
					name: tc.name,
					arguments: parsedArgs,
				});
			}

			const costCalc = {
				input: (inputTokens / 1_000_000) * modelDef.cost.input,
				output: (outputTokens / 1_000_000) * modelDef.cost.output,
				cacheRead: 0,
				cacheWrite: 0,
				total: (inputTokens / 1_000_000) * modelDef.cost.input + (outputTokens / 1_000_000) * modelDef.cost.output,
			};

			stream.push({
				type: "done",
				reason: toolCalls.length > 0 ? "toolUse" : (stopReason as any),
				message: {
					role: "assistant",
					content: finalContent,
					toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: {
						input: inputTokens,
						output: outputTokens,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: inputTokens + outputTokens,
						cost: costCalc,
					},
					stopReason: toolCalls.length > 0 ? "toolUse" : (stopReason as any),
					timestamp: Date.now(),
				},
			});

			stream.end();
		} catch (error) {
			stream.push({
				type: "error",
				reason: "error",
				error: {
					role: "assistant",
					content: [],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "error",
					errorMessage: error instanceof Error ? error.message : String(error),
					timestamp: Date.now(),
				},
			});
			stream.end();
		}
	})();

	return stream;
}
