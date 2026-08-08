import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import { constants } from "node:fs";
import type { CommandResult, Runtime } from "./types.ts";

const WINDOWS_EXTENSIONS = [".exe", ".cmd", ".bat", ""];

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(
      path,
      process.platform === "win32" ? constants.F_OK : constants.X_OK,
    );
    return true;
  } catch {
    return false;
  }
}

export async function resolveCommand(
  command: string,
): Promise<string | undefined> {
  if (isAbsolute(command) || command.includes("/") || command.includes("\\")) {
    return (await isExecutable(command)) ? command : undefined;
  }

  const extensions =
    process.platform === "win32"
      ? (process.env.PATHEXT?.split(";").filter(Boolean) ?? WINDOWS_EXTENSIONS)
      : [""];

  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = join(directory, `${command}${extension}`);
      if (await isExecutable(candidate)) return candidate;
    }
  }
  return undefined;
}

export function execCommand(
  command: string,
  args: string[],
  options: {
    signal?: AbortSignal;
    timeoutMs?: number;
    maxBuffer?: number;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        encoding: "utf8",
        windowsHide: true,
        signal: options.signal,
        timeout: options.timeoutMs,
        maxBuffer: options.maxBuffer ?? 1024 * 1024,
        env: options.env,
      },
      (error, stdout, stderr) => {
        if (error) {
          const code = typeof error.code === "number" ? error.code : 1;
          resolve({ stdout: stdout ?? "", stderr: stderr ?? "", code });
          return;
        }
        resolve({ stdout: stdout ?? "", stderr: stderr ?? "", code: 0 });
      },
    ).once("error", reject);
  });
}

export function createRuntime(): Runtime {
  return { resolveCommand, exec: execCommand };
}
