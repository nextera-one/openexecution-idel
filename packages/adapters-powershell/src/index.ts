/**
 * @openexecution/adapters-powershell — execution adapter for Windows PowerShell
 * (spec §22). Renders structured argv and invokes cmdlets through the PowerShell
 * host with an argument array (never a shell string).
 *
 * `renderArgv` is re-exported here for convenience; the canonical source lives
 * in `@openexecution/adapters-posix` and a byte-identical copy is kept locally
 * to avoid a cross-package runtime dependency.
 */

export { renderArgv } from "./render.js";
export {
  PowerShellAdapter,
  powerShellAdapter,
  buildPowerShellHostInvocation,
} from "./powershell.js";
export type { PowerShellHostInvocation, ResolveFn } from "./powershell.js";
