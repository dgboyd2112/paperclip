import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { ensurePostgresDatabase } from "./client.js";
import { createEmbeddedPostgresLogBuffer, formatEmbeddedPostgresError } from "./embedded-postgres-error.js";
import { ensureEmbeddedPostmasterPlan, stopEmbeddedPostmaster } from "./embedded-postgres-supervisor.js";
import { resolveDatabaseTarget } from "./runtime-config.js";

type EmbeddedPostgresInstance = {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
};

type EmbeddedPostgresCtor = new (opts: {
  databaseDir: string;
  user: string;
  password: string;
  port: number;
  persistent: boolean;
  initdbFlags?: string[];
  onLog?: (message: unknown) => void;
  onError?: (message: unknown) => void;
}) => EmbeddedPostgresInstance;

export type MigrationConnection = {
  connectionString: string;
  source: string;
  stop: () => Promise<void>;
};

async function loadEmbeddedPostgresCtor(): Promise<EmbeddedPostgresCtor> {
  try {
    const mod = await import("embedded-postgres");
    return mod.default as EmbeddedPostgresCtor;
  } catch {
    throw new Error(
      "Embedded PostgreSQL support requires dependency `embedded-postgres`. Reinstall dependencies and try again.",
    );
  }
}

async function ensureEmbeddedPostgresConnection(
  dataDir: string,
  preferredPort: number,
): Promise<MigrationConnection> {
  const EmbeddedPostgres = await loadEmbeddedPostgresCtor();
  const pgVersionFile = path.resolve(dataDir, "PG_VERSION");
  const clusterInitialized = existsSync(pgVersionFile);
  const logBuffer = createEmbeddedPostgresLogBuffer();

  // Migration tooling emits JSON on stdout (see migration-status.ts --json), so
  // every lifecycle log here must go to stderr to avoid corrupting that output.
  const plan = await ensureEmbeddedPostmasterPlan({
    dataDir,
    preferredPort,
    clusterInitialized,
    log: (_level, message) => process.emitWarning(`[embedded-postgres] ${message}`),
  });

  if (plan.action === "reuse") {
    const adminConnectionString = `postgres://paperclip:paperclip@127.0.0.1:${plan.port}/postgres`;
    await ensurePostgresDatabase(adminConnectionString, "paperclip");
    return {
      connectionString: `postgres://paperclip:paperclip@127.0.0.1:${plan.port}/paperclip`,
      source: `embedded-postgres@${plan.port}`,
      stop: async () => {},
    };
  }

  const port = plan.port;
  const instance = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: "paperclip",
    password: "paperclip",
    port,
    persistent: true,
    initdbFlags: ["--encoding=UTF8", "--locale=C", "--lc-messages=C"],
    onLog: logBuffer.append,
    onError: logBuffer.append,
  });

  if (!clusterInitialized) {
    try {
      await instance.initialise();
    } catch (error) {
      throw formatEmbeddedPostgresError(error, {
        fallbackMessage:
          `Failed to initialize embedded PostgreSQL cluster in ${dataDir} on port ${port}`,
        recentLogs: logBuffer.getRecentLogs(),
      });
    }
  }

  const postmasterPidFile = path.resolve(dataDir, "postmaster.pid");
  if (existsSync(postmasterPidFile)) {
    rmSync(postmasterPidFile, { force: true });
  }

  try {
    await instance.start();
  } catch (error) {
    throw formatEmbeddedPostgresError(error, {
      fallbackMessage: `Failed to start embedded PostgreSQL on port ${port}`,
      recentLogs: logBuffer.getRecentLogs(),
    });
  }

  const adminConnectionString = `postgres://paperclip:paperclip@127.0.0.1:${port}/postgres`;
  await ensurePostgresDatabase(adminConnectionString, "paperclip");

  return {
    connectionString: `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`,
    source: `embedded-postgres@${port}`,
    stop: async () => {
      await stopEmbeddedPostmaster(instance, dataDir);
    },
  };
}

export async function resolveMigrationConnection(): Promise<MigrationConnection> {
  const target = resolveDatabaseTarget();
  if (target.mode === "postgres") {
    return {
      connectionString: target.connectionString,
      source: target.source,
      stop: async () => {},
    };
  }

  return ensureEmbeddedPostgresConnection(target.dataDir, target.port);
}
