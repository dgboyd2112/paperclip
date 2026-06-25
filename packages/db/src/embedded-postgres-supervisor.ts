import { execFile } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import postgres from "postgres";
import { getPostgresDataDirectory } from "./client.js";

// Shared, health-aware lifecycle helpers for the persistent embedded PostgreSQL
// cluster. The dev migration runner and the server both used to decide whether an
// embedded cluster was reusable purely from `process.kill(pid, 0)` (i.e. "does a
// process with this PID exist?"). A postmaster that is alive but wedged (stuck
// mid-start, never accepting connections) passes that check, so callers would
// then try to connect to it — and, without a connect timeout, hang forever.
//
// These helpers instead verify the cluster actually *accepts connections* before
// reusing it, clean up a wedged/stale postmaster when it does not, and never
// start a second postmaster against the same data directory (which fails with
// "pre-existing shared memory block is still in use").

export type EmbeddedPostmasterDecision =
  | { action: "reuse"; port: number }
  | { action: "start"; port: number };

type LogLevel = "info" | "warn";
type LogFn = (level: LogLevel, message: string) => void;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function adminConnectionStringFor(port: number): string {
  return `postgres://paperclip:paperclip@127.0.0.1:${port}/postgres`;
}

export function readPostmasterPidFile(
  dataDir: string,
): { pid: number; port: number | null } | null {
  const postmasterPidFile = path.resolve(dataDir, "postmaster.pid");
  if (!existsSync(postmasterPidFile)) return null;
  try {
    const lines = readFileSync(postmasterPidFile, "utf8").split("\n");
    const pid = Number(lines[0]?.trim());
    if (!Number.isInteger(pid) || pid <= 0) return null;
    const portValue = Number(lines[3]?.trim());
    const port = Number.isInteger(portValue) && portValue > 0 ? portValue : null;
    return { pid, port };
  } catch {
    return null;
  }
}

export function removePostmasterPidFile(dataDir: string): void {
  const postmasterPidFile = path.resolve(dataDir, "postmaster.pid");
  if (existsSync(postmasterPidFile)) {
    rmSync(postmasterPidFile, { force: true });
  }
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function isPortInUse(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once("error", (error: NodeJS.ErrnoException) => {
      resolve(error.code === "EADDRINUSE");
    });
    server.listen(port, "127.0.0.1", () => {
      server.close();
      resolve(false);
    });
  });
}

async function waitForPortToFree(port: number, timeoutMs: number): Promise<boolean> {
  const start = process.hrtime.bigint();
  const timeoutNs = BigInt(timeoutMs) * 1_000_000n;
  while (process.hrtime.bigint() - start < timeoutNs) {
    if (!(await isPortInUse(port))) return true;
    await delay(300);
  }
  return !(await isPortInUse(port));
}

/**
 * Returns true once the cluster on `port` accepts and answers a trivial query.
 * Retries to tolerate a cluster that is still completing crash recovery, but
 * stays bounded so a genuinely wedged postmaster does not block forever.
 */
export async function probePostgresAcceptsConnections(
  port: number,
  options: { attempts?: number; connectTimeoutSeconds?: number; intervalMs?: number } = {},
): Promise<boolean> {
  const attempts = options.attempts ?? 5;
  const connectTimeoutSeconds = options.connectTimeoutSeconds ?? 3;
  const intervalMs = options.intervalMs ?? 1500;
  const url = adminConnectionStringFor(port);

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const sql = postgres(url, {
      max: 1,
      connect_timeout: connectTimeoutSeconds,
      onnotice: () => {},
    });
    try {
      await sql`select 1`;
      return true;
    } catch {
      // Not ready yet (starting up), wedged, or unreachable — fall through and retry.
    } finally {
      try {
        await sql.end({ timeout: 1 });
      } catch {
        // ignore teardown failures for a probe connection
      }
    }
    if (attempt < attempts) await delay(intervalMs);
  }
  return false;
}

/** Best-effort termination of a postmaster and all of its child backends. */
export async function terminatePostmasterTree(pid: number): Promise<void> {
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      execFile("taskkill", ["/F", "/T", "/PID", String(pid)], () => resolve());
    });
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // already gone
  }
  await delay(2000);
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // already gone
  }
}

/**
 * Decide how to bring up the embedded cluster for `dataDir`:
 *  - reuse an existing postmaster only if it actually accepts connections;
 *  - clean up a wedged/stale postmaster instead of trusting its PID;
 *  - always (re)start on `preferredPort` against the same data dir — never hop to
 *    a different port, which would start a second postmaster and collide on the
 *    cluster's shared-memory segment.
 */
export async function ensureEmbeddedPostmasterPlan(opts: {
  dataDir: string;
  preferredPort: number;
  clusterInitialized: boolean;
  log?: LogFn;
}): Promise<EmbeddedPostmasterDecision> {
  const { dataDir, preferredPort, clusterInitialized } = opts;
  const log: LogFn = opts.log ?? (() => {});

  const pidInfo = readPostmasterPidFile(dataDir);

  if (pidInfo && isPidAlive(pidInfo.pid)) {
    const port = pidInfo.port ?? preferredPort;
    const healthy = await probePostgresAcceptsConnections(port);
    if (healthy) {
      log("info", `Reusing healthy embedded PostgreSQL (pid=${pidInfo.pid}, port=${port}).`);
      return { action: "reuse", port };
    }
    log(
      "warn",
      `Embedded PostgreSQL (pid=${pidInfo.pid}, port=${port}) is not accepting connections; ` +
        `treating it as a wedged/orphaned process and cleaning it up.`,
    );
    await terminatePostmasterTree(pidInfo.pid);
    removePostmasterPidFile(dataDir);
    await waitForPortToFree(port, 6000);
  } else if (pidInfo) {
    log("warn", `Removing stale embedded PostgreSQL lock file (dead pid=${pidInfo.pid}).`);
    removePostmasterPidFile(dataDir);
  }

  // No (live) pid file. An initialized cluster may still be reachable if it was
  // started out-of-band; adopt it rather than starting a duplicate.
  if (clusterInitialized) {
    const reachable = await probePostgresAcceptsConnections(preferredPort, {
      attempts: 1,
      connectTimeoutSeconds: 3,
    });
    if (reachable) {
      const actualDataDir = await getPostgresDataDirectory(adminConnectionStringFor(preferredPort));
      if (actualDataDir && path.resolve(actualDataDir) === path.resolve(dataDir)) {
        log(
          "warn",
          `Embedded PostgreSQL is reachable on port ${preferredPort} without a pid file; reusing it.`,
        );
        return { action: "reuse", port: preferredPort };
      }
      // A different cluster is serving this port. Do not adopt it, and do not try
      // to start on top of it — fall through to the port-in-use guard below.
      log(
        "warn",
        `Port ${preferredPort} is served by a different PostgreSQL (data dir ${actualDataDir ?? "unknown"}); not adopting it.`,
      );
    }
  }

  // Refuse to start a second postmaster on the same data dir if the port is held
  // by an unmanaged process we could not clean up — that path only ever produces
  // the "pre-existing shared memory block is still in use" failure.
  if (await isPortInUse(preferredPort)) {
    const freed = await waitForPortToFree(preferredPort, 3000);
    if (!freed) {
      throw new Error(
        `Embedded PostgreSQL port ${preferredPort} is in use by an unmanaged process for data dir ${dataDir}. ` +
          `Stop the existing Paperclip server (run "pnpm dev:stop") or terminate the stray postgres process, then retry. ` +
          `Refusing to start a second postmaster on the same data directory.`,
      );
    }
  }

  return { action: "start", port: preferredPort };
}
