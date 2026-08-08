import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { PROVIDER_IDS, type ProviderId, type UsageSnapshot } from "./types.ts";
import { asRecord } from "./security.ts";

const CACHE_VERSION = 1;
const LOCK_STALE_MS = 60_000;

export interface CacheRead {
  snapshots: Partial<Record<ProviderId, UsageSnapshot>>;
  error?: string;
}

interface CacheDocument {
  version: 1;
  snapshots: Partial<Record<ProviderId, UsageSnapshot>>;
}

export function cacheDirectory(): string {
  return join(
    process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"),
    "pi-subscription-usage",
  );
}

export function cacheFile(): string {
  return join(cacheDirectory(), "snapshots.json");
}

function validSnapshot(
  value: unknown,
  provider: ProviderId,
): value is UsageSnapshot {
  const snapshot = asRecord(value);
  if (!snapshot) return false;
  return (
    snapshot.provider === provider &&
    typeof snapshot.label === "string" &&
    typeof snapshot.observedAt === "string" &&
    Number.isFinite(Date.parse(snapshot.observedAt)) &&
    Array.isArray(snapshot.windows)
  );
}

export async function readCache(path = cacheFile()): Promise<CacheRead> {
  try {
    const root = asRecord(JSON.parse(await readFile(path, "utf8")) as unknown);
    if (!root || root.version !== CACHE_VERSION) {
      return { snapshots: {}, error: "cache has an unsupported format" };
    }
    const rawSnapshots = asRecord(root.snapshots);
    if (!rawSnapshots) return { snapshots: {}, error: "cache is invalid" };
    const snapshots: Partial<Record<ProviderId, UsageSnapshot>> = {};
    for (const provider of PROVIDER_IDS) {
      if (validSnapshot(rawSnapshots[provider], provider)) {
        snapshots[provider] = rawSnapshots[provider];
      }
    }
    return { snapshots };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { snapshots: {} };
    return { snapshots: {}, error: "cache could not be read" };
  }
}

export async function writeCache(
  snapshots: Partial<Record<ProviderId, UsageSnapshot>>,
  path = cacheFile(),
): Promise<void> {
  const directory = path.slice(
    0,
    Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")),
  );
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const document: CacheDocument = { version: CACHE_VERSION, snapshots };
  const handle = await open(temp, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(document, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(temp, 0o600);
  await rename(temp, path);
  await chmod(path, 0o600);
}

export interface RefreshLock {
  release(): Promise<void>;
}

async function removeStaleLock(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    if (Date.now() - info.mtimeMs <= LOCK_STALE_MS) return false;
    await unlink(path);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

export async function acquireRefreshLock(): Promise<RefreshLock | undefined> {
  const directory = cacheDirectory();
  const path = join(directory, "refresh.lock");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = randomUUID();
    try {
      const handle = await open(path, "wx", 0o600);
      await handle.writeFile(`${token}\n`, "utf8");
      return {
        async release() {
          await handle.close().catch(() => undefined);
          try {
            if ((await readFile(path, "utf8")).trim() === token)
              await unlink(path);
          } catch {
            // Another process may already have recovered or removed the lock.
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (!(await removeStaleLock(path))) return undefined;
    }
  }
  return undefined;
}

export async function waitForPeerRefresh(maxWaitMs = 25_000): Promise<void> {
  const path = join(cacheDirectory(), "refresh.lock");
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    try {
      await stat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
