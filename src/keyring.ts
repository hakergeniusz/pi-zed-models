import { spawn } from "node:child_process";
import { promisify } from "node:util";

export interface ZedDesktopCredentials {
	userId: string;
	accessToken: string;
}

export function normalizeAccessToken(value: string): string {
	const token = value.trim();
	if (token.startsWith("{")) {
		try {
			const parsed = JSON.parse(token);
			if (parsed.id && parsed.token) {
				return JSON.stringify({
					version: parsed.version ?? 2,
					id: String(parsed.id),
					token: String(parsed.token),
				});
			}
		} catch {
			// keep raw token
		}
	}
	return token;
}

export async function readCredentialsFromSecretTool(): Promise<ZedDesktopCredentials | null> {
	return new Promise((resolve) => {
		const child = spawn("secret-tool", ["search", "--all", "--unlock", "url", "https://zed.dev"], {
			stdio: ["ignore", "pipe", "pipe"],
		});

		let output = "";
		child.stdout.on("data", (chunk) => {
			output += chunk.toString();
		});
		child.stderr.on("data", (chunk) => {
			output += chunk.toString();
		});

		child.on("error", () => {
			resolve(null);
		});

		child.on("close", (code) => {
			if (code !== 0 && !output) {
				resolve(null);
				return;
			}

			const userIds = Array.from(
				output.matchAll(/^attribute\.username = (.+)$/gm),
				(m) => m[1].trim(),
			).filter(Boolean);

			const accessTokens = Array.from(
				output.matchAll(/^secret = (.+)$/gm),
				(m) => normalizeAccessToken(m[1]),
			).filter(Boolean);

			if (userIds.length > 0 && accessTokens.length > 0) {
				// Pick the latest one
				const lastUser = userIds[userIds.length - 1];
				const lastToken = accessTokens[accessTokens.length - 1];
				resolve({ userId: lastUser, accessToken: lastToken });
				return;
			}

			resolve(null);
		});
	});
}

export async function readLocalZedCredentials(): Promise<ZedDesktopCredentials | null> {
	const envUser = process.env.ZED_USER_ID;
	const envToken = process.env.ZED_ACCESS_TOKEN;
	if (envUser && envToken) {
		return { userId: envUser.trim(), accessToken: normalizeAccessToken(envToken) };
	}
	return await readCredentialsFromSecretTool();
}
