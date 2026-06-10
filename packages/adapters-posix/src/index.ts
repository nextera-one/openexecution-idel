/**
 * @openexecution/adapters-posix — execution adapters for POSIX systems plus the
 * cross-platform in-process Node fs adapter (spec §22).
 *
 *  - {@link PosixAdapter}: spawns POSIX utilities (rm, mkdir, cp …) with an
 *    argument array and `shell: false`.
 *  - {@link NodeAdapter}: performs `@node`-marked file operations in-process
 *    via `node:fs/promises` — the safest, most portable executor.
 *  - {@link renderArgv}: the canonical structured-argv renderer, re-exported so
 *    other packages can import it from here.
 */

export { renderArgv } from "./render.js";
export { PosixAdapter, posixAdapter } from "./posix.js";
export type { ResolveFn } from "./posix.js";
export { NodeAdapter, nodeAdapter, SymlinkRefusedError } from "./node-adapter.js";
