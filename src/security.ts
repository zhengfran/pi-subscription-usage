import { readFile, stat } from "node:fs/promises";

type PrivateFileInspection =
  | { state: "available"; mode: number }
  | { state: "missing" }
  | { state: "invalid"; detail: string }
  | { state: "insecure"; mode: number; detail: string };

export type PrivateJsonResult =
  | { state: "available"; value: unknown; mode: number }
  | Exclude<PrivateFileInspection, { state: "available" }>;

export async function inspectPrivateFile(
  path: string,
): Promise<PrivateFileInspection> {
  try {
    const info = await stat(path);
    if (!info.isFile())
      return { state: "invalid", detail: "not a regular file" };
    const mode = info.mode & 0o777;
    if ((mode & 0o077) !== 0) {
      return {
        state: "insecure",
        mode,
        detail: `permissions ${mode.toString(8)} are not owner-only`,
      };
    }
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
      return {
        state: "insecure",
        mode,
        detail: "file is owned by another user",
      };
    }
    return { state: "available", mode };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { state: "missing" };
    return { state: "invalid", detail: "file could not be inspected" };
  }
}

export async function readPrivateJson(
  path: string,
): Promise<PrivateJsonResult> {
  const inspection = await inspectPrivateFile(path);
  if (inspection.state !== "available") return inspection;
  try {
    const raw = await readFile(path, "utf8");
    return {
      state: "available",
      value: JSON.parse(raw) as unknown,
      mode: inspection.mode,
    };
  } catch {
    return { state: "invalid", detail: "file is not valid JSON" };
  }
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function finiteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export function safeString(
  value: unknown,
  maxLength = 100,
): string | undefined {
  if (typeof value !== "string") return undefined;
  const sanitized = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return sanitized ? sanitized.slice(0, maxLength) : undefined;
}
