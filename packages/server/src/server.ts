import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import type { AddressInfo } from "node:net";

import { TerminalService, ServiceError } from "./service.js";
import type {
  RunRequest,
  CompleteRequest,
  ServiceOptions,
} from "./service.js";

/**
 * A dependency-free HTTP server over the {@link TerminalService}. It is the
 * local boundary the web and desktop (Javelle/Electron) terminals talk to.
 *
 * Endpoints (all JSON unless noted):
 *   GET  /api/health                 → { ok, version }
 *   GET  /api/registry               → RegistryEntry[]
 *   GET  /api/registry/:id           → { resolved, shadowed }
 *   POST /api/complete   {input,cwd} → string[]
 *   POST /api/run        RunRequest  → RuntimeOutcome
 *   GET  /api/logs?limit=N           → OpenLogRecord[]   (redacted by the writer)
 *   GET  /api/logs/verify            → VerifyResult
 *   GET  /  (+ static)               → the bundled UI, when `staticDir` is set
 *
 * Streaming: `POST /api/run/stream` runs the command and emits the same outcome
 * over Server-Sent Events (one `event: outcome`, then `event: done`). SSE is
 * used deliberately — it needs no extra dependency and matches Javelle's own
 * patch-stream contract (`EventSource`), so the desktop/web bridge is uniform.
 */

export interface ServerOptions extends ServiceOptions {
  /** Port to listen on. 0 picks a free port (useful for tests). Default 7878. */
  port?: number;
  /** Host/interface to bind. Default 127.0.0.1 (loopback only — never 0.0.0.0). */
  host?: string;
  /** Directory of built UI assets to serve at `/`. Omit for an API-only server. */
  staticDir?: string;
  /** Allow cross-origin browser requests (dev). Default true for loopback dev. */
  cors?: boolean;
}

const VERSION = "1.1.0";
const DEFAULT_PORT = 7878;
const MAX_BODY_BYTES = 1_000_000; // 1MB — command lines are tiny; cap abuse.

export interface RunningServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const service = new TerminalService(opts);
  const host = opts.host ?? "127.0.0.1";
  const cors = opts.cors ?? true;
  const staticDir = opts.staticDir ? resolve(opts.staticDir) : undefined;

  const httpServer = createServer((req, res) => {
    handle(req, res, service, { cors, staticDir }).catch((err) => {
      // A ServiceError carries the intended HTTP status (e.g. 413 for an
      // oversized body thrown while reading the request stream); honor it here
      // so transport-level failures don't all collapse to 500.
      const status = err instanceof ServiceError ? err.status : 500;
      sendJson(res, status, { error: String((err as Error)?.message ?? err) }, cors);
    });
  });

  await new Promise<void>((resolveListen, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(opts.port ?? DEFAULT_PORT, host, () => {
      httpServer.removeListener("error", reject);
      resolveListen();
    });
  });

  const addr = httpServer.address() as AddressInfo;
  const url = `http://${host}:${addr.port}`;

  return {
    url,
    port: addr.port,
    close: () =>
      new Promise<void>((resolveClose, reject) =>
        httpServer.close((err) => (err ? reject(err) : resolveClose())),
      ),
  };
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  service: TerminalService,
  cfg: { cors: boolean; staticDir: string | undefined },
): Promise<void> {
  const { cors, staticDir } = cfg;
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;

  // Preflight.
  if (method === "OPTIONS") {
    if (cors) setCors(res);
    res.writeHead(204);
    res.end();
    return;
  }

  // --- API routes ---------------------------------------------------------
  if (path === "/api/health") {
    return sendJson(res, 200, { ok: true, version: VERSION }, cors);
  }

  if (path === "/api/registry" && method === "GET") {
    return sendJson(res, 200, service.registry(), cors);
  }

  if (path.startsWith("/api/registry/") && method === "GET") {
    const id = decodeURIComponent(path.slice("/api/registry/".length));
    return sendJson(res, 200, service.explain(id), cors);
  }

  if (path === "/api/complete" && method === "POST") {
    const body = await readJsonBody<CompleteRequest>(req);
    return sendJson(res, 200, service.complete(body), cors);
  }

  if (path === "/api/run" && method === "POST") {
    const body = await readJsonBody<RunRequest>(req);
    try {
      const outcome = await service.run(body);
      return sendJson(res, 200, outcome, cors);
    } catch (err) {
      if (err instanceof ServiceError) {
        return sendJson(res, err.status, { error: err.message }, cors);
      }
      throw err;
    }
  }

  if (path === "/api/run/stream" && method === "POST") {
    const body = await readJsonBody<RunRequest>(req);
    return runStream(res, service, body, cors);
  }

  if (path === "/api/logs" && method === "GET") {
    const limit = clampLimit(url.searchParams.get("limit"));
    return sendJson(res, 200, await service.logs(limit), cors);
  }

  if (path === "/api/logs/verify" && method === "GET") {
    return sendJson(res, 200, await service.verifyLogs(), cors);
  }

  // --- Static UI (optional) ----------------------------------------------
  if (staticDir && method === "GET") {
    const served = await serveStatic(res, staticDir, path, cors);
    if (served) return;
  }

  sendJson(res, 404, { error: `not found: ${method} ${path}` }, cors);
}

/** Run a command and stream the outcome as SSE (matches Javelle EventSource). */
async function runStream(
  res: ServerResponse,
  service: TerminalService,
  body: RunRequest,
  cors: boolean,
): Promise<void> {
  if (cors) setCors(res);
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  try {
    const outcome = await service.run(body);
    writeSse(res, "outcome", outcome);
  } catch (err) {
    const status = err instanceof ServiceError ? err.status : 500;
    writeSse(res, "error", { error: String((err as Error).message), status });
  } finally {
    writeSse(res, "done", {});
    res.end();
  }
}

// --- helpers ---------------------------------------------------------------

function clampLimit(raw: string | null): number {
  const n = raw ? Number.parseInt(raw, 10) : 50;
  if (!Number.isFinite(n) || n <= 0) return 50;
  return Math.min(n, 1000);
}

async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > MAX_BODY_BYTES) {
      throw new ServiceError("request body too large", 413);
    }
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {} as T;
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new ServiceError("invalid JSON body", 400);
  }
}

function sendJson(
  res: ServerResponse,
  status: number,
  payload: unknown,
  cors: boolean,
): void {
  if (cors) setCors(res);
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function writeSse(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function setCors(res: ServerResponse): void {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type");
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

/**
 * Serve a static file from `dir`, defending against path traversal. Returns true
 * if a response was sent. Falls back to index.html for SPA routes (no extension).
 */
async function serveStatic(
  res: ServerResponse,
  dir: string,
  urlPath: string,
  cors: boolean,
): Promise<boolean> {
  const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  // Resolve and confirm the target stays inside `dir` (traversal guard).
  const target = normalize(join(dir, rel));
  if (target !== dir && !target.startsWith(dir + sep)) {
    return false;
  }

  let filePath = target;
  try {
    const s = await stat(filePath);
    if (s.isDirectory()) filePath = join(filePath, "index.html");
  } catch {
    // SPA fallback: a path with no file extension serves index.html so the
    // client router can handle it. Anything with an extension is a real 404.
    if (extname(rel)) return false;
    filePath = join(dir, "index.html");
  }

  let data: Buffer;
  try {
    data = await readFile(filePath);
  } catch {
    return false;
  }
  if (cors) setCors(res);
  res.writeHead(200, {
    "content-type": MIME[extname(filePath)] ?? "application/octet-stream",
    "content-length": data.length,
  });
  res.end(data);
  return true;
}
