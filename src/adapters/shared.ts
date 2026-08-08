import type { AdapterFailureKind } from "../types.ts";
import { finiteNumber, safeString } from "../security.ts";

const MAX_RESPONSE_BYTES = 1024 * 1024;

export class AdapterFailure extends Error {
  readonly kind: AdapterFailureKind;
  readonly retryable: boolean;

  constructor(kind: AdapterFailureKind, message: string, retryable = false) {
    super(message);
    this.name = "AdapterFailure";
    this.kind = kind;
    this.retryable = retryable;
  }
}

export interface JsonResponse {
  status: number;
  ok: boolean;
  headers: Headers;
  data?: unknown;
}

export async function requestJson(
  url: string,
  init: RequestInit,
  signal: AbortSignal,
): Promise<JsonResponse> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal });
  } catch {
    throw new AdapterFailure("transient", "network request failed", true);
  }

  let raw: string;
  try {
    raw = await response.text();
  } catch {
    throw new AdapterFailure(
      "transient",
      "provider response could not be read",
      true,
    );
  }
  if (Buffer.byteLength(raw, "utf8") > MAX_RESPONSE_BYTES) {
    throw new AdapterFailure(
      "unsupported",
      "provider response was unexpectedly large",
    );
  }

  let data: unknown;
  if (raw.trim()) {
    try {
      data = JSON.parse(raw) as unknown;
    } catch {
      if (response.ok) {
        throw new AdapterFailure(
          "unsupported",
          "provider returned invalid JSON",
        );
      }
    }
  }
  return {
    status: response.status,
    ok: response.ok,
    headers: response.headers,
    data,
  };
}

export function rejectHttpFailure(
  response: JsonResponse,
  provider: string,
): void {
  if (response.ok) return;
  if (response.status === 401 || response.status === 403) {
    throw new AdapterFailure(
      "not_authenticated",
      `${provider} authentication was rejected`,
    );
  }
  if (response.status === 429) {
    throw new AdapterFailure(
      "transient",
      `${provider} usage endpoint is rate limited`,
    );
  }
  if (response.status >= 500) {
    throw new AdapterFailure(
      "transient",
      `${provider} usage endpoint is unavailable`,
      true,
    );
  }
  throw new AdapterFailure(
    "unsupported",
    `${provider} usage endpoint returned HTTP ${response.status}`,
  );
}

export function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

export function isoDate(value: unknown): string | undefined {
  const numeric = finiteNumber(value);
  if (numeric !== undefined) {
    if (numeric <= 0) return undefined;
    const millis = numeric > 10_000_000_000 ? numeric : numeric * 1000;
    const date = new Date(millis);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  const text = safeString(value, 100);
  if (!text) return undefined;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export function planName(value: unknown): string | undefined {
  return safeString(value, 60);
}

export async function commandVersion(
  executable: string | undefined,
  run: (
    command: string,
    args: string[],
    options: { timeoutMs: number; maxBuffer: number },
  ) => Promise<{ stdout: string; stderr: string; code: number }>,
): Promise<string | undefined> {
  if (!executable) return undefined;
  const result = await run(executable, ["--version"], {
    timeoutMs: 3000,
    maxBuffer: 16 * 1024,
  });
  if (result.code !== 0) return undefined;
  return safeString(result.stdout.split(/\r?\n/, 1)[0], 120);
}
