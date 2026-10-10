import { generateKeyPairSync, privateDecrypt, constants, createPublicKey } from "node:crypto";
import http from "node:http";

export interface WebSignInResult {
	userId: string;
	accessToken: string;
}

/**
 * Perform native browser sign-in flow matching Zed's /native_app_signin endpoint.
 *
 * 1. Generates 2048-bit RSA key pair.
 * 2. Exports public key as PKCS#1 DER base64url.
 * 3. Starts local HTTP server on random port.
 * 4. Calls onAuthUrl with https://zed.dev/native_app_signin?native_app_port=...&native_app_public_key=...
 * 5. Handles redirect callback from browser, responds with redirect to /native_app_signin_succeeded.
 * 6. Decrypts access token using RSA private key (tries OAEP SHA-256 then PKCS1v15).
 */
export async function startBrowserSignIn(
	onAuthUrl: (url: string) => Promise<void> | void,
	signal?: AbortSignal,
): Promise<WebSignInResult> {
	const { publicKey, privateKey } = generateKeyPairSync("rsa", {
		modulusLength: 2048,
		publicKeyEncoding: { type: "pkcs1", format: "der" },
		privateKeyEncoding: { type: "pkcs1", format: "pem" },
	});

	const publicKeyB64 = publicKey.toString("base64url");

	return new Promise((resolve, reject) => {
		let cleanedUp = false;

		const server = http.createServer((req, res) => {
			try {
				const reqUrl = new URL(req.url ?? "/", `http://${req.headers.host}`);
				const userId = reqUrl.searchParams.get("user_id");
				const encryptedAccessToken = reqUrl.searchParams.get("access_token");

				if (!userId || !encryptedAccessToken) {
					res.writeHead(400, { "Content-Type": "text/plain" });
					res.end("Missing user_id or access_token parameters");
					return;
				}

				// Redirect user browser to Zed success page
				res.writeHead(302, {
					Location: "https://zed.dev/native_app_signin_succeeded",
				});
				res.end();

				cleanup();

				// Decrypt access token
				const encryptedBuf = Buffer.from(encryptedAccessToken, "base64url");
				let decrypted: string;
				try {
					// Modern format: OAEP with SHA-256
					decrypted = privateDecrypt(
						{
							key: privateKey,
							padding: constants.RSA_PKCS1_OAEP_PADDING,
							oaepHash: "sha256",
						},
						encryptedBuf,
					).toString("utf8");
				} catch {
					// Fallback legacy format: PKCS1 v1.5
					decrypted = privateDecrypt(
						{
							key: privateKey,
							padding: constants.RSA_PKCS1_PADDING,
						},
						encryptedBuf,
					).toString("utf8");
				}

				resolve({
					userId,
					accessToken: decrypted,
				});
			} catch (err) {
				cleanup();
				reject(err);
			}
		});

		const cleanup = () => {
			if (cleanedUp) return;
			cleanedUp = true;
			try {
				server.close();
			} catch {
				// ignore
			}
		};

		if (signal) {
			signal.addEventListener("abort", () => {
				cleanup();
				reject(new Error("Sign in was cancelled"));
			});
		}

		server.listen(0, "127.0.0.1", async () => {
			const addr = server.address();
			if (!addr || typeof addr === "string") {
				cleanup();
				reject(new Error("Failed to get local server port"));
				return;
			}

			const port = addr.port;
			const authUrl = `https://zed.dev/native_app_signin?native_app_port=${port}&native_app_public_key=${encodeURIComponent(publicKeyB64)}`;

			try {
				await onAuthUrl(authUrl);
			} catch (err) {
				cleanup();
				reject(err);
			}
		});

		server.on("error", (err) => {
			cleanup();
			reject(err);
		});
	});
}
