import { homedir } from "node:os";
import { join } from "node:path";
import {
  asRecord,
  finiteNumber,
  readPrivateJson,
  safeString,
} from "../security.ts";
import type {
  AdapterDiagnostic,
  AllowanceWindow,
  Runtime,
  SupplementalBalance,
  UsageAdapter,
  UsageSnapshot,
  WindowKind,
} from "../types.ts";
import {
  AdapterFailure,
  clampPercent,
  commandVersion,
  isoDate,
  planName,
  rejectHttpFailure,
  requestJson,
} from "./shared.ts";

const API_URL = "https://api.anthropic.com/api/oauth/usage";
const CREDENTIAL_FILE = ".credentials.json";

function credentialPath(): string {
  return join(
    process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"),
    CREDENTIAL_FILE,
  );
}

function fixedWindow(
  value: unknown,
  id: string,
  label: string,
  kind: WindowKind,
): AllowanceWindow | undefined {
  const record = asRecord(value);
  const used = finiteNumber(record?.utilization);
  if (used === undefined) return undefined;
  return {
    id,
    label,
    kind,
    usedPercent: clampPercent(used),
    resetsAt: isoDate(record?.resets_at ?? record?.reset_at),
    unit: "percent",
  };
}

function scopedWindow(
  value: unknown,
  index: number,
): AllowanceWindow | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const used = finiteNumber(record.percent ?? record.utilization);
  if (used === undefined) return undefined;
  const group = safeString(record.group, 40);
  const scope = asRecord(record.scope);
  const model = asRecord(scope?.model);
  const modelName = safeString(model?.display_name ?? model?.name, 60);
  const kind: WindowKind =
    group === "session"
      ? "five_hour"
      : group === "weekly"
        ? "weekly"
        : modelName
          ? "model"
          : "other";
  const id =
    kind === "five_hour"
      ? "five_hour"
      : kind === "weekly"
        ? "seven_day"
        : (safeString(record.kind ?? model?.id, 80) ?? `limit_${index}`);
  const label =
    kind === "five_hour"
      ? "5-hour"
      : kind === "weekly"
        ? "weekly"
        : modelName
          ? `weekly (${modelName})`
          : (safeString(record.kind, 60) ?? "allowance");
  return {
    id,
    label,
    kind,
    usedPercent: clampPercent(used),
    resetsAt: isoDate(record.resets_at ?? record.reset_at),
    unit: "percent",
  };
}

function supplemental(value: unknown): SupplementalBalance[] | undefined {
  const record = asRecord(value);
  if (!record || record.is_enabled !== true) return undefined;
  const decimals = finiteNumber(record.decimal_places) ?? 2;
  const divisor = 10 ** decimals;
  const usedMinor = finiteNumber(record.used_credits);
  const limitMinor = finiteNumber(record.monthly_limit);
  const used = usedMinor === undefined ? undefined : usedMinor / divisor;
  const limit = limitMinor === undefined ? undefined : limitMinor / divisor;
  if (used === undefined && limit === undefined) return undefined;
  return [
    {
      id: "extra_usage",
      label: "Extra usage",
      used,
      limit,
      remaining:
        used !== undefined && limit !== undefined
          ? Math.max(0, limit - used)
          : undefined,
      unit: safeString(record.currency, 12) ?? "USD",
    },
  ];
}

export function normalizeClaudeUsage(
  value: unknown,
  plan?: string,
  observedAt = new Date().toISOString(),
): UsageSnapshot {
  const record = asRecord(value);
  if (!record)
    throw new AdapterFailure(
      "unsupported",
      "Claude usage response changed format",
    );

  let windows: AllowanceWindow[] = [];
  if (Array.isArray(record.limits)) {
    windows = record.limits
      .map(scopedWindow)
      .filter((window): window is AllowanceWindow => window !== undefined);
  }
  if (windows.length === 0) {
    windows = [
      fixedWindow(record.five_hour, "five_hour", "5-hour", "five_hour"),
      fixedWindow(record.seven_day, "seven_day", "weekly", "weekly"),
      fixedWindow(
        record.seven_day_opus,
        "seven_day_opus",
        "weekly (Opus)",
        "model",
      ),
      fixedWindow(
        record.seven_day_sonnet,
        "seven_day_sonnet",
        "weekly (Sonnet)",
        "model",
      ),
    ].filter((window): window is AllowanceWindow => window !== undefined);
  }
  if (windows.length === 0) {
    throw new AdapterFailure(
      "unsupported",
      "Claude usage response contained no allowance windows",
    );
  }

  return {
    provider: "claude",
    label: "Claude",
    observedAt,
    plan,
    windows,
    supplemental: supplemental(record.extra_usage),
  };
}

async function readCredential() {
  const path = credentialPath();
  const result = await readPrivateJson(path);
  if (result.state === "missing") {
    throw new AdapterFailure(
      "not_authenticated",
      "Claude Code is not signed in",
    );
  }
  if (result.state === "insecure") {
    throw new AdapterFailure(
      "unsupported",
      `Claude credential file ${result.detail}`,
    );
  }
  if (result.state !== "available") {
    throw new AdapterFailure(
      "not_authenticated",
      "Claude Code credentials are invalid",
    );
  }
  const root = asRecord(result.value);
  const oauth = asRecord(root?.claudeAiOauth);
  const accessToken = safeString(
    oauth?.accessToken ?? oauth?.access_token,
    16_384,
  );
  if (!accessToken) {
    throw new AdapterFailure(
      root && "apiKey" in root ? "no_subscription" : "not_authenticated",
      root && "apiKey" in root
        ? "Claude Code is using API billing"
        : "Claude Code OAuth credentials are missing",
    );
  }
  const expiresAt = finiteNumber(oauth?.expiresAt);
  if (expiresAt !== undefined && expiresAt <= Date.now()) {
    throw new AdapterFailure(
      "not_authenticated",
      "Claude Code OAuth credentials expired",
    );
  }
  return {
    accessToken,
    plan: planName(oauth?.subscriptionType ?? root?.subscriptionType),
  };
}

export const claudeAdapter: UsageAdapter = {
  id: "claude",
  label: "Claude",

  async fetch(runtime: Runtime, signal: AbortSignal): Promise<UsageSnapshot> {
    if (!(await runtime.resolveCommand("claude"))) {
      throw new AdapterFailure("not_installed", "Claude Code is not installed");
    }
    const credential = await readCredential();
    const response = await requestJson(
      API_URL,
      {
        headers: {
          Authorization: `Bearer ${credential.accessToken}`,
          "anthropic-beta": "oauth-2025-04-20",
          "User-Agent": "claude-code/2.0.0",
          Accept: "application/json",
        },
      },
      signal,
    );
    rejectHttpFailure(response, "Claude");
    return normalizeClaudeUsage(response.data, credential.plan);
  },

  async diagnose(runtime: Runtime): Promise<AdapterDiagnostic> {
    const commandPath = await runtime.resolveCommand("claude");
    const credentials = await readPrivateJson(credentialPath());
    const credentialRoot =
      credentials.state === "available"
        ? asRecord(credentials.value)
        : undefined;
    const credentialOauth = asRecord(credentialRoot?.claudeAiOauth);
    const hasOauthToken = Boolean(
      safeString(
        credentialOauth?.accessToken ?? credentialOauth?.access_token,
        16_384,
      ),
    );
    return {
      provider: "claude",
      label: "Claude",
      command: "claude",
      commandPath,
      version: await commandVersion(commandPath, runtime.exec),
      credentialSource: credentialPath(),
      credentialState:
        credentials.state === "available"
          ? hasOauthToken
            ? "available"
            : "invalid"
          : credentials.state,
      detail:
        credentials.state === "insecure" || credentials.state === "invalid"
          ? credentials.detail
          : undefined,
    };
  },
};
