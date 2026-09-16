import { spawn } from "node:child_process";
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

const USAGE_ENDPOINTS = [
  "https://chatgpt.com/backend-api/wham/usage",
  "https://chatgpt.com/backend-api/codex/usage",
];

function authPath(): string {
  return join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "auth.json");
}

function identityForWindow(
  seconds: number | undefined,
  fallbackId: string,
  fallbackLabel: string,
  fallbackKind: WindowKind,
  scoped: boolean,
) {
  const duration =
    seconds !== undefined && Math.abs(seconds - 18_000) < 120
      ? { id: "five_hour", label: "5-hour", kind: "five_hour" as const }
      : seconds !== undefined && Math.abs(seconds - 604_800) < 600
        ? { id: "seven_day", label: "weekly", kind: "weekly" as const }
        : undefined;
  if (!duration)
    return { id: fallbackId, label: fallbackLabel, kind: fallbackKind };
  if (!scoped) return duration;

  const scope = fallbackLabel
    .replace(/\s*(?:primary|secondary) window$/i, "")
    .trim();
  return {
    id: `${fallbackId}_${duration.id}`,
    label: `${scope} ${duration.label}`.trim(),
    kind: fallbackKind,
  };
}

function normalizeWindow(
  value: unknown,
  fallbackId: string,
  fallbackLabel: string,
  fallbackKind: WindowKind,
  scoped: boolean,
): AllowanceWindow | undefined {
  const record = asRecord(value);
  const usedPercent = finiteNumber(record?.used_percent ?? record?.usedPercent);
  if (!record || usedPercent === undefined) return undefined;
  const durationMinutes = finiteNumber(
    record.window_minutes ?? record.windowDurationMins,
  );
  const durationSeconds =
    finiteNumber(record.limit_window_seconds) ??
    (durationMinutes === undefined ? undefined : durationMinutes * 60);
  const identity = identityForWindow(
    durationSeconds,
    fallbackId,
    fallbackLabel,
    fallbackKind,
    scoped,
  );
  const resetAfter = finiteNumber(record.reset_after_seconds);
  return {
    ...identity,
    usedPercent: clampPercent(usedPercent),
    unit: "percent",
    resetsAt:
      isoDate(record.reset_at ?? record.resetsAt) ??
      (resetAfter === undefined
        ? undefined
        : new Date(Date.now() + resetAfter * 1000).toISOString()),
  };
}

function pairFromContainer(
  value: unknown,
  prefix = "",
  labelPrefix = "",
  kind: WindowKind = "other",
): AllowanceWindow[] {
  const container = asRecord(value);
  if (!container) return [];
  const scoped = prefix.length > 0 || labelPrefix.length > 0;
  return [
    normalizeWindow(
      container.primary_window ?? container.primary,
      `${prefix}primary`,
      `${labelPrefix}primary window`.trim(),
      kind,
      scoped,
    ),
    normalizeWindow(
      container.secondary_window ?? container.secondary,
      `${prefix}secondary`,
      `${labelPrefix}secondary window`.trim(),
      kind,
      scoped,
    ),
  ].filter((window): window is AllowanceWindow => window !== undefined);
}

function supplemental(value: unknown): SupplementalBalance[] | undefined {
  const credits = asRecord(value);
  if (!credits) return undefined;
  const remaining = finiteNumber(credits.balance ?? credits.remaining);
  const unlimited =
    typeof credits.unlimited === "boolean" ? credits.unlimited : undefined;
  const hasCredits =
    typeof (credits.hasCredits ?? credits.has_credits) === "boolean"
      ? Boolean(credits.hasCredits ?? credits.has_credits)
      : undefined;
  if (
    (hasCredits === false && unlimited !== true && (remaining ?? 0) <= 0) ||
    (remaining === undefined && unlimited === undefined)
  )
    return undefined;
  return [
    {
      id: "credits",
      label: "Codex credits",
      remaining,
      unlimited,
      unit: "credits",
    },
  ];
}

export function normalizeCodexUsage(
  value: unknown,
  observedAt = new Date().toISOString(),
): UsageSnapshot {
  const root = asRecord(value);
  if (!root)
    throw new AdapterFailure(
      "unsupported",
      "Codex usage response changed format",
    );
  const base =
    asRecord(root.rate_limit) ??
    asRecord(root.rateLimits) ??
    asRecord(root.rate_limits) ??
    root;
  const windows = pairFromContainer(base);

  const codeReview = asRecord(root.code_review_rate_limit);
  if (codeReview)
    windows.push(...pairFromContainer(codeReview, "review_", "code review "));

  if (Array.isArray(root.additional_rate_limits)) {
    for (const [index, item] of root.additional_rate_limits.entries()) {
      const entry = asRecord(item);
      const name = safeString(entry?.limit_name ?? entry?.metered_feature, 60);
      const limit = asRecord(entry?.rate_limit);
      if (limit) {
        windows.push(
          ...pairFromContainer(
            limit,
            `model_${safeString(entry?.metered_feature, 40) ?? index}_`,
            `${name ?? "model"} `,
            "model",
          ),
        );
      }
    }
  }

  const byId = asRecord(root.rateLimitsByLimitId);
  if (byId) {
    for (const [id, value] of Object.entries(byId)) {
      const entry = asRecord(value);
      const name = safeString(entry?.limitName ?? entry?.limit_name, 60);
      if (!entry || !name) continue;
      windows.push(
        ...pairFromContainer(entry, `model_${id}_`, `${name} `, "model"),
      );
    }
  }

  const deduplicated = windows.filter(
    (window, index) =>
      windows.findIndex(
        (candidate) =>
          candidate.id === window.id && candidate.resetsAt === window.resetsAt,
      ) === index,
  );
  if (deduplicated.length === 0) {
    throw new AdapterFailure(
      "unsupported",
      "Codex usage response contained no allowance windows",
    );
  }

  return {
    provider: "codex",
    label: "Codex",
    observedAt,
    plan: planName(
      base.planType ?? base.plan_type ?? root.planType ?? root.plan_type,
    ),
    windows: deduplicated,
    supplemental: supplemental(base.credits ?? root.credits),
  };
}

function rpcFailure(message: unknown): AdapterFailure {
  const text = safeString(asRecord(message)?.message, 200)?.toLowerCase() ?? "";
  if (text.includes("not logged") || text.includes("unauthorized")) {
    return new AdapterFailure("not_authenticated", "Codex is not signed in");
  }
  return new AdapterFailure(
    "unsupported",
    "Codex app-server usage protocol failed",
  );
}

async function fetchViaAppServer(
  executable: string,
  signal: AbortSignal,
): Promise<UsageSnapshot> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      executable,
      ["-s", "read-only", "-a", "never", "app-server"],
      {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, NO_COLOR: "1", TERM: "dumb" },
        windowsHide: true,
      },
    );
    let buffer = "";
    let settled = false;
    const timeout = setTimeout(
      () =>
        finish(
          new AdapterFailure("transient", "Codex app-server timed out", true),
        ),
      6500,
    );

    const cleanup = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 250).unref();
    };
    const finish = (error?: AdapterFailure, value?: UsageSnapshot) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(value!);
    };
    const abort = () =>
      finish(
        new AdapterFailure("transient", "Codex usage request timed out", true),
      );
    signal.addEventListener("abort", abort, { once: true });

    child.once("error", () =>
      finish(
        new AdapterFailure("unsupported", "Codex app-server could not start"),
      ),
    );
    child.once("close", () => {
      if (!settled)
        finish(new AdapterFailure("unsupported", "Codex app-server exited"));
    });
    child.stderr.resume();
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      if (buffer.length > 1024 * 1024) {
        finish(
          new AdapterFailure(
            "unsupported",
            "Codex app-server output was too large",
          ),
        );
        return;
      }
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let message: Record<string, unknown> | undefined;
        try {
          message = asRecord(JSON.parse(line) as unknown);
        } catch {
          continue;
        }
        if (message?.id === 1) {
          if (message.error) {
            finish(rpcFailure(message.error));
            return;
          }
          child.stdin.write(
            `${JSON.stringify({ id: 2, method: "account/rateLimits/read", params: {} })}\n`,
          );
        } else if (message?.id === 2) {
          if (message.error) {
            finish(rpcFailure(message.error));
            return;
          }
          try {
            finish(undefined, normalizeCodexUsage(message.result));
          } catch (error) {
            finish(
              error instanceof AdapterFailure
                ? error
                : new AdapterFailure(
                    "unsupported",
                    "Codex response could not be parsed",
                  ),
            );
          }
          return;
        }
      }
    });
    child.stdin.on("error", () => undefined);
    child.stdin.write(
      `${JSON.stringify({
        id: 1,
        method: "initialize",
        params: {
          clientInfo: { name: "pi-subscription-usage", version: "0.1.0" },
        },
      })}\n`,
    );
  });
}

async function readOauthCredential() {
  const result = await readPrivateJson(authPath());
  if (result.state === "missing") {
    throw new AdapterFailure("not_authenticated", "Codex is not signed in");
  }
  if (result.state === "insecure") {
    throw new AdapterFailure(
      "unsupported",
      `Codex credential file ${result.detail}`,
    );
  }
  if (result.state !== "available") {
    throw new AdapterFailure(
      "not_authenticated",
      "Codex credentials are invalid",
    );
  }
  const root = asRecord(result.value);
  if (root?.auth_mode === "apikey" || (root?.OPENAI_API_KEY && !root.tokens)) {
    throw new AdapterFailure("no_subscription", "Codex is using API billing");
  }
  const tokens = asRecord(root?.tokens);
  const accessToken = safeString(
    tokens?.access_token ?? tokens?.accessToken,
    16_384,
  );
  const accountId = safeString(tokens?.account_id ?? tokens?.accountId, 200);
  if (!accessToken)
    throw new AdapterFailure(
      "not_authenticated",
      "Codex OAuth credentials are missing",
    );
  return { accessToken, accountId };
}

async function fetchDirect(signal: AbortSignal): Promise<UsageSnapshot> {
  const credential = await readOauthCredential();
  let lastStatus: number | undefined;
  for (const endpoint of USAGE_ENDPOINTS) {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${credential.accessToken}`,
      Accept: "application/json",
      "User-Agent": "codex-cli",
    };
    if (credential.accountId)
      headers["ChatGPT-Account-Id"] = credential.accountId;
    const response = await requestJson(endpoint, { headers }, signal);
    lastStatus = response.status;
    if (response.ok) return normalizeCodexUsage(response.data);
    if (response.status !== 404) rejectHttpFailure(response, "Codex");
  }
  throw new AdapterFailure(
    "unsupported",
    `Codex usage endpoint returned HTTP ${lastStatus ?? "unknown"}`,
  );
}

export const codexAdapter: UsageAdapter = {
  id: "codex",
  label: "Codex",

  async fetch(runtime: Runtime, signal: AbortSignal): Promise<UsageSnapshot> {
    const executable = await runtime.resolveCommand("codex");
    if (!executable)
      throw new AdapterFailure("not_installed", "Codex CLI is not installed");
    try {
      return await fetchViaAppServer(executable, signal);
    } catch (error) {
      if (signal.aborted) throw error;
      try {
        return await fetchDirect(signal);
      } catch (fallbackError) {
        if (fallbackError instanceof AdapterFailure) throw fallbackError;
        if (error instanceof AdapterFailure) throw error;
        throw new AdapterFailure(
          "unsupported",
          "Codex usage could not be read",
        );
      }
    }
  },

  async diagnose(runtime: Runtime): Promise<AdapterDiagnostic> {
    const commandPath = await runtime.resolveCommand("codex");
    const credentials = await readPrivateJson(authPath());
    const credentialRoot =
      credentials.state === "available"
        ? asRecord(credentials.value)
        : undefined;
    const credentialTokens = asRecord(credentialRoot?.tokens);
    const hasCredential = Boolean(
      safeString(
        credentialTokens?.access_token ?? credentialTokens?.accessToken,
        16_384,
      ) ?? credentialRoot?.OPENAI_API_KEY,
    );
    return {
      provider: "codex",
      label: "Codex",
      command: "codex",
      commandPath,
      version: await commandVersion(commandPath, runtime.exec),
      credentialSource: authPath(),
      credentialState:
        credentials.state === "available"
          ? hasCredential
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
