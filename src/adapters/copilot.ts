import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  asRecord,
  finiteNumber,
  inspectPrivateFile,
  readPrivateJson,
  safeString,
} from "../security.ts";
import type {
  AdapterDiagnostic,
  AllowanceWindow,
  Runtime,
  SupplementalBalance,
  UsageAdapter,
  UsageAdapterOptions,
  UsageSnapshot,
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

const USER_URL = "https://api.github.com/copilot_internal/user";

function appsPath(): string {
  if (process.env.GITHUB_COPILOT_APPS_JSON)
    return process.env.GITHUB_COPILOT_APPS_JSON;
  if (process.platform === "win32") {
    return join(
      process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"),
      "github-copilot",
      "apps.json",
    );
  }
  return join(
    process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
    "github-copilot",
    "apps.json",
  );
}

function copilotConfigPath(): string {
  return join(
    process.env.COPILOT_HOME ?? join(homedir(), ".copilot"),
    "config.json",
  );
}

type TokenResult =
  | { token: string; source: string }
  | { state: "missing" | "invalid" | "insecure"; detail?: string };

export function parseCurrentCopilotToken(value: unknown): string | undefined {
  const root = asRecord(value);
  const tokens = asRecord(root?.copilotTokens);
  if (!root || !tokens) return undefined;
  const current = asRecord(root.lastLoggedInUser);
  const host = safeString(current?.host, 300);
  const login = safeString(current?.login, 200);
  if (host && login) {
    const exact = safeString(tokens[`${host}:${login}`], 16_384);
    if (exact) return exact;
  }
  for (const [key, value] of Object.entries(tokens)) {
    if (!key.toLowerCase().includes("github.com")) continue;
    const token = safeString(value, 16_384);
    if (token) return token;
  }
  return undefined;
}

async function tokenFromCopilotConfig(): Promise<TokenResult> {
  const path = copilotConfigPath();
  const inspection = await inspectPrivateFile(path);
  if (inspection.state !== "available") return inspection;
  try {
    // The official CLI manages this JSONC file and commonly starts it with comments.
    const raw = (await readFile(path, "utf8")).replace(/^\s*\/\/.*$/gm, "");
    const token = parseCurrentCopilotToken(JSON.parse(raw) as unknown);
    return token ? { token, source: path } : { state: "invalid" };
  } catch {
    return {
      state: "invalid",
      detail: "Copilot CLI config is not valid JSONC",
    };
  }
}

function credentialHost(
  key: string,
  value: Record<string, unknown>,
): string | undefined {
  const candidate = safeString(
    value.host ??
      value.hostname ??
      value.github_host ??
      value.server_uri ??
      key,
    300,
  );
  if (!candidate) return undefined;
  try {
    return new URL(
      candidate.includes("://") ? candidate : `https://${candidate}`,
    ).hostname;
  } catch {
    return undefined;
  }
}

async function tokenFromApps(): Promise<TokenResult> {
  const result = await readPrivateJson(appsPath());
  if (result.state !== "available") {
    return {
      state: result.state,
      detail:
        result.state === "insecure" || result.state === "invalid"
          ? result.detail
          : undefined,
    };
  }
  const root = asRecord(result.value);
  if (!root) return { state: "invalid" };
  const candidates: Array<{ token: string; host?: string }> = [];
  for (const [key, raw] of Object.entries(root)) {
    const entry = asRecord(raw);
    const token = safeString(entry?.oauth_token, 16_384);
    if (entry && token)
      candidates.push({ token, host: credentialHost(key, entry) });
  }
  const selected =
    candidates.find(
      ({ host }) => host === "github.com" || host === "api.github.com",
    ) ?? candidates.find(({ host }) => !host);
  return selected
    ? { token: selected.token, source: appsPath() }
    : { state: "invalid" };
}

async function tokenFromKnownSources(
  runtime: Runtime,
  signal: AbortSignal | undefined,
  ghPath: string | undefined,
): Promise<TokenResult> {
  for (const variable of ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"]) {
    const token = safeString(process.env[variable], 16_384);
    if (token) return { token, source: variable };
  }
  const config = await tokenFromCopilotConfig();
  if ("token" in config) return config;
  const apps = await tokenFromApps();
  if ("token" in apps) return apps;
  if (ghPath) {
    const result = await runtime.exec(ghPath, ["auth", "token"], {
      signal,
      timeoutMs: 5000,
      maxBuffer: 64 * 1024,
    });
    const token =
      result.code === 0 ? safeString(result.stdout, 16_384) : undefined;
    if (token) return { token, source: "gh auth" };
  }
  return config.state === "insecure" || apps.state === "insecure"
    ? {
        state: "insecure",
        detail: config.detail ?? apps.detail ?? "credential file is insecure",
      }
    : config.state === "invalid" || apps.state === "invalid"
      ? { state: "invalid", detail: config.detail ?? apps.detail }
      : { state: "missing" };
}

async function acquireToken(
  runtime: Runtime,
  signal: AbortSignal,
  ghPath: string | undefined,
): Promise<string> {
  const credential = await tokenFromKnownSources(runtime, signal, ghPath);
  if ("token" in credential) return credential.token;
  if (credential.state === "insecure") {
    throw new AdapterFailure(
      "unsupported",
      `GitHub Copilot credential file ${credential.detail ?? "is insecure"}`,
    );
  }
  throw new AdapterFailure(
    "not_authenticated",
    "GitHub Copilot CLI is not signed in",
  );
}

function labelForSnapshot(id: string): string {
  const names: Record<string, string> = {
    premium_interactions: "premium requests",
    premium_requests: "premium requests",
    chat: "chat",
    completions: "completions",
  };
  return names[id] ?? id.replace(/_/g, " ");
}

function snapshotWindow(
  id: string,
  value: unknown,
  fallbackReset: unknown,
): { window?: AllowanceWindow; overage?: SupplementalBalance } {
  const record = asRecord(value);
  if (!record) return {};
  const remainingPercent = finiteNumber(record.percent_remaining);
  const entitlement = finiteNumber(record.entitlement ?? record.quota);
  const remaining = finiteNumber(record.quota_remaining ?? record.remaining);
  const unlimited = record.unlimited === true;
  if (remainingPercent === undefined && entitlement === undefined && !unlimited)
    return {};
  const used =
    entitlement !== undefined && remaining !== undefined
      ? Math.max(0, entitlement - remaining)
      : undefined;
  const unit = safeString(record.quota_id, 60) ?? labelForSnapshot(id);
  const window: AllowanceWindow = {
    id,
    label: labelForSnapshot(id),
    kind: "monthly",
    usedPercent:
      remainingPercent === undefined
        ? used !== undefined && entitlement && entitlement > 0
          ? clampPercent((used / entitlement) * 100)
          : undefined
        : clampPercent(100 - remainingPercent),
    used,
    limit: entitlement,
    remaining,
    unit,
    resetsAt: unlimited
      ? undefined
      : (isoDate(record.quota_reset_at) ?? isoDate(fallbackReset)),
    unlimited,
  };
  const overage = finiteNumber(record.overage_count);
  return {
    window,
    overage:
      overage !== undefined && overage > 0
        ? {
            id: `${id}_overage`,
            label: `${labelForSnapshot(id)} overage`,
            used: overage,
            unit,
          }
        : undefined,
  };
}

function aiCreditsWindow(
  value: unknown,
  fallbackReset: unknown,
  configuredLimit: number | undefined,
): AllowanceWindow | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const entitlement = finiteNumber(record.entitlement ?? record.quota);
  const reportedRemaining = finiteNumber(
    record.quota_remaining ?? record.remaining,
  );
  const creditsUsed = finiteNumber(record.credits_used);
  const derivedUsed =
    entitlement !== undefined &&
    entitlement > 0 &&
    reportedRemaining !== undefined
      ? Math.max(0, entitlement - reportedRemaining)
      : undefined;
  const used = creditsUsed ?? derivedUsed;
  const limit =
    entitlement !== undefined && entitlement > 0
      ? entitlement
      : configuredLimit;
  if (used === undefined && limit === undefined) return undefined;
  const normalizedUsed = used ?? 0;
  const remaining =
    limit === undefined ? undefined : Math.max(0, limit - normalizedUsed);
  return {
    id: "ai_credits",
    label: "AI credits",
    kind: "monthly",
    usedPercent:
      limit === undefined
        ? undefined
        : clampPercent((normalizedUsed / limit) * 100),
    used: normalizedUsed,
    limit,
    remaining,
    unit: "AI credits",
    resetsAt: isoDate(record.quota_reset_at) ?? isoDate(fallbackReset),
    ...(limit === undefined ? {} : { unlimited: false }),
  };
}

export function normalizeCopilotUsage(
  value: unknown,
  observedAt = new Date().toISOString(),
  configuredAiCreditsLimit?: number,
): UsageSnapshot {
  const root = asRecord(value);
  const snapshots = asRecord(root?.quota_snapshots);
  if (!root || !snapshots) {
    throw new AdapterFailure(
      "unsupported",
      "GitHub Copilot usage response changed format",
    );
  }
  const premiumInteractions = asRecord(snapshots.premium_interactions);
  const tokenBasedBilling =
    root.token_based_billing === true ||
    premiumInteractions?.token_based_billing === true;
  if (tokenBasedBilling) {
    const window = aiCreditsWindow(
      premiumInteractions,
      root.quota_reset_date_utc ?? root.quota_reset_date,
      configuredAiCreditsLimit,
    );
    if (!window) {
      throw new AdapterFailure(
        "unsupported",
        "GitHub Copilot response contained no AI-credit usage",
      );
    }
    return {
      provider: "copilot",
      label: "GitHub Copilot",
      observedAt,
      plan: planName(root.copilot_plan ?? root.access_type_sku ?? root.sku),
      windows: [window],
    };
  }

  const normalized = Object.entries(snapshots).map(([id, snapshot]) =>
    snapshotWindow(
      id,
      snapshot,
      root.quota_reset_date_utc ?? root.quota_reset_date,
    ),
  );
  const windows = normalized
    .map(({ window }) => window)
    .filter((window): window is AllowanceWindow => window !== undefined)
    .sort((a, b) => {
      const rank = (id: string) =>
        id.startsWith("premium_") ? 0 : id === "chat" ? 1 : 2;
      return rank(a.id) - rank(b.id);
    });
  if (windows.length === 0) {
    throw new AdapterFailure(
      "unsupported",
      "GitHub Copilot response contained no monthly allowance",
    );
  }
  const supplemental = normalized
    .map(({ overage }) => overage)
    .filter((item): item is SupplementalBalance => item !== undefined);
  return {
    provider: "copilot",
    label: "GitHub Copilot",
    observedAt,
    plan: planName(root.copilot_plan ?? root.access_type_sku ?? root.sku),
    windows,
    supplemental: supplemental.length ? supplemental : undefined,
  };
}

export const copilotAdapter: UsageAdapter = {
  id: "copilot",
  label: "GitHub Copilot",

  async fetch(
    runtime: Runtime,
    signal: AbortSignal,
    options?: UsageAdapterOptions,
  ): Promise<UsageSnapshot> {
    const copilotPath = await runtime.resolveCommand("copilot");
    const ghPath = await runtime.resolveCommand("gh");
    if (!copilotPath && !ghPath) {
      throw new AdapterFailure(
        "not_installed",
        "GitHub Copilot CLI or GitHub CLI is not installed",
      );
    }
    const token = await acquireToken(runtime, signal, ghPath);
    const response = await requestJson(
      USER_URL,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          "User-Agent": "GitHubCopilotCLI/1.0",
          "Editor-Plugin-Version": "copilot-chat/0.26.7",
          "X-GitHub-Api-Version": "2025-04-01",
        },
      },
      signal,
    );
    rejectHttpFailure(response, "GitHub Copilot");
    return normalizeCopilotUsage(
      response.data,
      new Date().toISOString(),
      options?.aiCreditsLimit,
    );
  },

  async diagnose(runtime: Runtime): Promise<AdapterDiagnostic> {
    const copilotPath = await runtime.resolveCommand("copilot");
    const ghPath = await runtime.resolveCommand("gh");
    const credential = await tokenFromKnownSources(runtime, undefined, ghPath);
    return {
      provider: "copilot",
      label: "GitHub Copilot",
      command: copilotPath ? "copilot" : "gh",
      commandPath: copilotPath ?? ghPath,
      version: await commandVersion(copilotPath ?? ghPath, runtime.exec),
      credentialSource:
        "token" in credential ? credential.source : copilotConfigPath(),
      credentialState: "token" in credential ? "available" : credential.state,
      detail: "token" in credential ? undefined : credential.detail,
    };
  },
};
