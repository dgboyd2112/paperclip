import { execFile } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { promisify } from "node:util";
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

const execFileAsync = promisify(execFile);

async function snapshotWindowsProcessParents(): Promise<Map<number, number>> {
  // pid -> parent pid for every process on the machine.
  const parents = new Map<number, number>();
  try {
    const { stdout } = await execFileAsync("powershell", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId) $($_.ParentProcessId)\" }",
    ]);
    for (const line of stdout.split(/\r?\n/)) {
      const [pidText, ppidText] = line.trim().split(/\s+/);
      const parsedPid = Number.parseInt(pidText, 10);
      const parsedPpid = Number.parseInt(ppidText, 10);
      if (Number.isInteger(parsedPid) && Number.isInteger(parsedPpid)) {
        parents.set(parsedPid, parsedPpid);
      }
    }
  } catch {
    // Best effort: an empty map degrades to killing only the known pids.
  }
  return parents;
}

/**
 * Best-effort termination of a postmaster and all of its child backends.
 *
 * On Windows, `taskkill /T` alone races the postmaster's rapid worker forking:
 * a worker spawned between the tree snapshot and the kill escapes, keeps the
 * cluster's shared memory mapped (failing the next start on this data dir with
 * "pre-existing shared memory block is still in use"), and holds the
 * postmaster's shared stderr pipe open. So, like the dev:stop teardown in
 * local-service-supervisor, accumulate a kill set across passes — each pass
 * reaps any live process still parented to a pid already in the set (a dead
 * parent stays referenced in the process table). This also works when `pid` is
 * already dead: its orphaned workers are still parented to it, so they land in
 * the kill set on the first pass.
 */
export async function terminatePostmasterTree(pid: number): Promise<void> {
  if (process.platform === "win32") {
    const killed = new Set<number>([pid]);
    for (let pass = 0; pass < 5; pass += 1) {
      const parents = await snapshotWindowsProcessParents();
      let grew = true;
      while (grew) {
        grew = false;
        for (const [childPid, parentPid] of parents) {
          if (!killed.has(childPid) && killed.has(parentPid)) {
            killed.add(childPid);
            grew = true;
          }
        }
      }
      await Promise.all(
        [...killed].map((target) =>
          new Promise<void>((resolve) => {
            execFile("taskkill", ["/F", "/PID", String(target)], () => resolve());
          }),
        ),
      );
      await delay(200);
      if (![...killed].some((target) => isPidAlive(target))) return;
    }
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

async function resolvesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    // A live timer would keep short-lived callers (the dev migration runner)
    // alive for the full timeout after a successful stop.
    if (timer) clearTimeout(timer);
  }
}

const embeddedPostgresStopTimeoutMs = 15_000;

/**
 * Stop an embedded-postgres instance and leave the cluster fully gone.
 *
 * The library's stop() force-kills the postmaster on Windows, which (1) can
 * leave a worker forked mid-kill running — it keeps the cluster's shared
 * memory mapped and pins the calling process's event loop via the shared
 * stderr pipe — and (2) always leaves postmaster.pid behind, because
 * TerminateProcess denies Postgres its own shutdown cleanup. Reap stragglers
 * rooted at the postmaster's pid and clear the pid file it could not remove.
 * The stop is also time-bounded so no caller (the dev runner's migration
 * preflight, the server's shutdown path) can hang on it.
 */
export async function stopEmbeddedPostmaster(
  instance: { stop(): Promise<void> },
  dataDir: string,
): Promise<void> {
  const pidInfo = readPostmasterPidFile(dataDir);
  let stopReturned = false;
  try {
    stopReturned = await resolvesWithin(instance.stop(), embeddedPostgresStopTimeoutMs);
  } finally {
    if (pidInfo && (!stopReturned || process.platform === "win32")) {
      await terminatePostmasterTree(pidInfo.pid);
    }
    // Remove the pid file only if it still names the postmaster we stopped —
    // a different pid means another supervisor already started a new cluster.
    const remaining = readPostmasterPidFile(dataDir);
    if (pidInfo && remaining && remaining.pid === pidInfo.pid) {
      removePostmasterPidFile(dataDir);
    }
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
    if (process.platform === "win32") {
      // Workers orphaned by the dead postmaster keep the cluster's shared
      // memory mapped, which would fail the start below; reap them via their
      // dead parent before starting fresh. (POSIX workers exit on their own
      // when they see the postmaster-death pipe close.)
      await terminatePostmasterTree(pidInfo.pid);
    }
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
