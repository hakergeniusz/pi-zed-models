# pi-zed-models

Pi extension to access Zed-hosted models (Anthropic Claude, OpenAI, Google Gemini) via your Zed account.

## Features

- Integrates into `/login` -> `Sign in with an account` -> `Zed Hosted Models`.
- Supports existing Zed desktop login (`secret-tool` / Linux keyring or `ZED_USER_ID` / `ZED_ACCESS_TOKEN`).
- Supports native browser OAuth sign-in flow through `https://zed.dev/native_app_signin`.
- Connects directly to `cloud.zed.dev` completions gateway.
- Registers Claude (Fable, Opus, Sonnet, Haiku), OpenAI (GPT-6, GPT-5), and Gemini models.
- Registers only the models your account can actually use. When credentials are available at
  startup the extension queries `cloud.zed.dev/models` and uses that list instead of the bundled
  catalog.

## Installation

Symlink or copy the extension directory into `~/.pi/agent/extensions/pi-zed-models`:

```bash
mkdir -p ~/.pi/agent/extensions
ln -s /path/to/pi-zed-models ~/.pi/agent/extensions/pi-zed-models
```

## Authentication

Run inside Pi:
```text
/login
```
Select `Sign in with an account` -> `Zed Hosted Models`.

If signed into Zed desktop on Linux, the extension detects your credentials automatically and prompts to use them. Otherwise, it opens Zed's web sign-in in your browser.

## Plan and model availability

Zed gates models per plan. The live catalog is authoritative, so the model list depends on your plan:

- `zed_pro_trial`: `gpt-6-luna` only
- `zed_pro` / `zed_business`: full catalog
- `zed_free`: no hosted models

`https://cloud.zed.dev/models` returns only what your account may call. If a plan is wrong there, the extension registers the wrong models and every request is refused.

## Errors

| Error | Meaning |
| --- | --- |
| `Trial access is blocked` (HTTP 403) | Server-side account block, not an extension bug. Official Zed Agent fails the same way. Resolve with Zed billing (`billing-support@zed.dev`) or wait for the trial to end. |
| `payment required to use this language model` (HTTP 402) | Plan does not include the model. |
| `Failed to verify Zed user` / HTTP 401 | Credentials expired. Re-run `/login`. |

## Client version

The cloud gates clients by version (`x-zed-version`, `x-zed-minimum-required-version`). The extension reports `1.23.2` by default and matches the Zed desktop app's own user agent format.

Override when your installed Zed is newer:

```bash
ZED_CLIENT_VERSION=1.24.0 pi
```
