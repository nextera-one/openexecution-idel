/**
 * @openexecution/cli — the `idel` executable (spec §10, §24, §27).
 *
 * Thin layer over the runtime. Responsibilities:
 *  - parse process argv into a runtime context + an IDEL command string
 *  - run one-shot commands, native passthrough, and the interactive terminal
 *  - render outcomes (spec §25) and set the process exit code from the result
 *
 * All execution logic lives in @openexecution/runtime; the CLI never touches
 * the safety/policy/adapter layers directly.
 */
export { main } from "./main.js";
