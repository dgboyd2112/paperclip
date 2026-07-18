import path from "node:path";
import fs from "node:fs";
import pino from "pino";
import { pinoHttp } from "pino-http";
import { readConfigFile } from "../config-file.js";
import { resolveDefaultLogsDir, resolveHomeAwarePath } from "../home-paths.js";
import { shouldSilenceHttpSuccessLog } from "./http-log-policy.js";
import { redactEventPayload } from "../redaction.js";

// Recursively mask secret-bearing fields (password, token, cookie, jwt, api-key,
// …) before request body/params/query are attached to 4xx/5xx log lines — a
// failed login must not write its plaintext password to disk (upstream #4759).
// redactEventPayload handles plain objects; wrap it so array bodies are covered too.
function redactLoggedRequestData(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactLoggedRequestData);
  if (value && typeof value === "object") {
    return redactEventPayload(value as Record<string, unknown>);
  }
  return value;
}

function resolveServerLogDir(): string {
  const envOverride = process.env.PAPERCLIP_LOG_DIR?.trim();
  if (envOverride) return resolveHomeAwarePath(envOverride);

  const fileLogDir = readConfigFile()?.logging.logDir?.trim();
  if (fileLogDir) return resolveHomeAwarePath(fileLogDir);

  return resolveDefaultLogsDir();
}

const logDir = resolveServerLogDir();
fs.mkdirSync(logDir, { recursive: true });

const logFile = path.join(logDir, "server.log");

const sharedOpts = {
  translateTime: "SYS:HH:MM:ss",
  ignore: "pid,hostname",
  singleLine: true,
};

// Redact secret-bearing headers before anything reaches a transport. `cookie`
// carries the Supabase session JWT; without this it was written to disk in
// plaintext on every request (see upstream paperclipai/paperclip#3338).
const REDACTED_HEADER_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  'res.headers["set-cookie"]',
];

// The file log rotates by size via pino-roll so it can never grow unbounded
// again. removeOtherLogFiles makes the retention count span restarts instead of
// leaking one growing set per dev-server process. (The per-request bloat itself
// is cut off at the source by the trimmed req/res serializers on httpLogger
// below — this rotation is the belt-and-suspenders cap.)
const FILE_LOG_MAX_SIZE_MB = 50;
const FILE_LOG_RETAINED_FILES = 5;

export const logger = pino({
  level: "debug",
  redact: REDACTED_HEADER_PATHS,
}, pino.transport({
  targets: [
    {
      target: "pino-pretty",
      options: { ...sharedOpts, ignore: "pid,hostname,req,res,responseTime", colorize: true, destination: 1 },
      level: "info",
    },
    {
      target: "pino-roll",
      options: {
        file: logFile,
        size: FILE_LOG_MAX_SIZE_MB,
        mkdir: true,
        limit: { count: FILE_LOG_RETAINED_FILES, removeOtherLogFiles: true },
      },
      level: "debug",
    },
  ],
}));

export const httpLogger = pinoHttp({
  logger,
  // Trim the heavy request/response objects that used to dominate server.log —
  // pino-http otherwise serializes every header on every request, which is where
  // the session-cookie JWT was being written to disk. We keep only method/url/
  // status; the readable "METHOD /url STATUS" message and the 4xx/5xx error
  // context attached in customProps below are unaffected (those hooks receive the
  // raw req/res, not these serialized forms).
  serializers: {
    req(req: any) {
      return { id: req?.id, method: req?.method, url: req?.url };
    },
    res(res: any) {
      return { statusCode: res?.statusCode };
    },
  },
  customLogLevel(_req, res, err) {
    if (shouldSilenceHttpSuccessLog(_req.method, _req.url, res.statusCode)) {
      return "silent";
    }
    if (err || res.statusCode >= 500) return "error";
    if (res.statusCode >= 400) return "warn";
    return "info";
  },
  customSuccessMessage(req, res) {
    return `${req.method} ${req.url} ${res.statusCode}`;
  },
  customErrorMessage(req, res, err) {
    const ctx = (res as any).__errorContext;
    const errMsg = ctx?.error?.message || err?.message || (res as any).err?.message || "unknown error";
    return `${req.method} ${req.url} ${res.statusCode} — ${errMsg}`;
  },
  customProps(req, res) {
    if (res.statusCode >= 400) {
      const ctx = (res as any).__errorContext;
      if (ctx) {
        return {
          errorContext: ctx.error,
          reqBody: redactLoggedRequestData(ctx.reqBody),
          reqParams: redactLoggedRequestData(ctx.reqParams),
          reqQuery: redactLoggedRequestData(ctx.reqQuery),
        };
      }
      const props: Record<string, unknown> = {};
      const { body, params, query } = req as any;
      if (body && typeof body === "object" && Object.keys(body).length > 0) {
        props.reqBody = redactLoggedRequestData(body);
      }
      if (params && typeof params === "object" && Object.keys(params).length > 0) {
        props.reqParams = redactLoggedRequestData(params);
      }
      if (query && typeof query === "object" && Object.keys(query).length > 0) {
        props.reqQuery = redactLoggedRequestData(query);
      }
      if ((req as any).route?.path) {
        props.routePath = (req as any).route.path;
      }
      return props;
    }
    return {};
  },
});
