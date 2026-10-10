import { test, expect } from "bun:test";
import { KNOWN_MODELS, MODEL_MAP } from "./src/models.js";
import { normalizeAccessToken } from "./src/keyring.js";
import { fetchUserMe } from "./src/api.js";

test("models catalog is loaded with known Zed models", () => {
	expect(KNOWN_MODELS.length).toBeGreaterThan(15);
	expect(MODEL_MAP.has("claude-sonnet-4-6")).toBe(true);
	expect(MODEL_MAP.has("gpt-6.1-sol")).toBe(true);
	expect(MODEL_MAP.has("gemini-3.1-pro")).toBe(true);
});

test("normalizeAccessToken handles JSON objects and strings", () => {
	const raw = JSON.stringify({ version: 2, id: "client_1", token: "tok_123" });
	const normalized = normalizeAccessToken(raw);
	expect(normalized).toBe(raw);

	const plain = "tok_abc";
	expect(normalizeAccessToken(plain)).toBe("tok_abc");
});

test("fetchUserMe validates against live zed api with invalid creds", async () => {
	try {
		await fetchUserMe("999999", "invalid");
		expect(false).toBe(true);
	} catch (e: any) {
		expect(e.message).toContain("Failed to verify Zed user");
	}
});
