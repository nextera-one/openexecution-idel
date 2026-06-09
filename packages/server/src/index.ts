/**
 * @openexecution/server — a local HTTP boundary over the OpenExecution Runtime.
 *
 * This is the shared core the web and desktop (Javelle/Electron) terminals talk
 * to. It does NOT re-implement any safety/policy/logging: every command flows
 * through {@link @openexecution/runtime#Runtime.run}, so a command typed in the
 * GUI gets exactly the same two-phase safety scan, policy decision, and signed
 * OpenLogs record as the CLI.
 *
 * Two layers:
 *  - {@link TerminalService} — transport-agnostic, unit-testable wrapper over a
 *    Runtime (run / complete / registry / explain / logs / verify).
 *  - {@link startServer} — a dependency-free node:http server exposing that
 *    service as JSON + SSE, optionally serving a bundled static UI.
 *
 * See packages/server/README is the spec §24 terminal, hosted instead of REPL.
 */

export { TerminalService, ServiceError } from "./service.js";
export type {
  ServiceOptions,
  RunRequest,
  CompleteRequest,
  RegistryEntry,
} from "./service.js";

export { startServer } from "./server.js";
export type { ServerOptions, RunningServer } from "./server.js";

export { complete } from "./complete.js";
