# pi-subscription-usage

A pi package that displays provider-reported, account-wide subscription usage for:

- Claude: 5-hour, weekly, and provider-reported model windows
- Codex: base windows, model-scoped additional limits, and credits
- GitHub Copilot: monthly AI-credit usage and legacy request quotas
- Kiro: monthly credits and bonus/overage balances

It does not estimate subscription usage from local tokens or sessions. Provider units are preserved and never combined into a cross-provider score. When an organization-managed Copilot response reports used AI credits but omits the included allowance, an optional user-confirmed limit can complete that one display; it is never inferred.

## Install

From GitHub:

```sh
pi install git:github.com/zhengfran/pi-subscription-usage
```

For local development:

```sh
pi install /absolute/path/to/pi-subscription-usage
```

The package requires pi 0.82 or newer and Node.js 22.5 or newer. Linux and WSL are the supported platforms for 0.1; macOS and Windows credential discovery are experimental.

## Commands

- `/usage` — open the account usage dashboard
- `/usage refresh` — open the dashboard and force a refresh
- `/usage doctor` — show sanitized CLI, credential, cache, and adapter diagnostics

In the dashboard, press `r` to refresh, arrow keys to scroll, and `Esc` to close. Usage is shown only when `/usage` is invoked; the package does not add a persistent footer or status-bar indicator. Dashboard data is UI-only: the package registers no LLM tool, injects no messages, and writes nothing to pi session history.

## Authentication

The package owns no login flow and stores no credentials. Sign in using each official CLI:

```sh
claude auth login
codex login
copilot login
kiro-cli login
```

Adapters prefer official CLI protocols where available. Otherwise they narrowly read the official CLI credential store into memory and call a read-only provider-operated usage endpoint. Credential files with group or world permissions are refused. Tokens, response bodies, account email, and organization names are never logged or cached.

The provider usage contracts are not all public or stable. A changed response is reported as `unsupported`; data is never fabricated.

## Refresh and cache

Snapshots are cached globally at:

```text
$XDG_CACHE_HOME/pi-subscription-usage/snapshots.json
# fallback: ~/.cache/pi-subscription-usage/snapshots.json
```

The cache contains normalized usage only, uses owner-only permissions, and retains the latest successful snapshot per provider. It never contains credentials or raw responses.

- Cached data is shown immediately.
- Data refreshes at startup when older than five minutes.
- Open pi processes refresh every five minutes.
- Refreshes use a cross-process lock, so parallel pi sessions do not multiply requests.
- Provider failures are independent; a successful provider remains visible when another fails.
- Stale data is explicitly marked with its age in the dashboard.
- `PI_OFFLINE=1` disables every network refresh, including forced refresh.

Each adapter has a 10-second attempt timeout and one retry for transient network or server failures. Authentication, rate-limit, and response-schema failures are not retried.

## Provider-specific behavior

### Codex

Codex base limits and model-specific additional limits remain distinct. For example, a Pro account may report one base weekly allowance plus separate `GPT-5.3-Codex-Spark 5-hour` and `GPT-5.3-Codex-Spark weekly` windows. Duration recognition never strips the model scope from an additional limit.

### GitHub Copilot

When GitHub reports `token_based_billing`, the legacy-named `premium_interactions` snapshot is displayed as one **AI credits** window. Its provider-reported `credits_used` value replaces the misleading unlimited `premium requests`, `chat`, and `completions` rows. If GitHub also reports a positive entitlement, that value is used automatically.

Organization-managed accounts may report `credits_used` while returning a zero entitlement. Set `providers.copilot.aiCreditsLimit` to the monthly allowance shown in your GitHub account so the dashboard can display `used/limit`; without it, the dashboard shows provider-reported used credits only.

## Configuration

Configuration is optional. Defaults are zero-config. To override them, create `<pi-agent-dir>/subscription-usage.json` (normally `~/.pi/agent/subscription-usage.json`):

```json
{
  "refreshIntervalMinutes": 5,
  "providers": {
    "claude": { "enabled": true },
    "codex": { "enabled": true },
    "copilot": { "enabled": true, "aiCreditsLimit": 20000 },
    "kiro": { "enabled": true }
  }
}
```

`refreshIntervalMinutes` must be from 1 through 1440. `providers.copilot.aiCreditsLimit` must be greater than zero when set. It is an optional, user-confirmed monthly allowance—not a plan default or an estimate—and is used only when a token-billed Copilot response omits its included limit. Unknown keys and invalid values are reported in `/usage` and `/usage doctor`; safe defaults remain active.

## Provider credential sources

| Provider | Preferred source                                                                      | Fallback endpoint                              |
| -------- | ------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Claude   | Claude Code OAuth credential store                                                    | `api.anthropic.com/api/oauth/usage`            |
| Codex    | Codex app-server `account/rateLimits/read`                                            | ChatGPT Codex usage endpoint using Codex OAuth |
| Copilot  | Copilot CLI managed config, environment token, legacy `apps.json`, or `gh auth token` | GitHub Copilot internal user quota endpoint    |
| Kiro     | Kiro CLI credential database; refresh delegated to Kiro CLI                           | Kiro management `Get-Usage-Limits`             |

No package telemetry or crash reporting is sent.

## Development

```sh
npm install
npm test
npm run check
npm run format:check
```

Fixture/contract tests contain only sanitized provider responses. Opt-in live tests use existing official CLI authentication and never print raw responses:

```sh
npm run test:live
```

## License

MIT
