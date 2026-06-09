#!/usr/bin/env node
// idel — OpenExecution Runtime CLI entrypoint.
// Thin shim: delegate to the compiled main() and map its return to the exit code.
import { main } from "../dist/main.js";

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    process.stderr.write(`idel: ${err?.stack ?? err}\n`);
    process.exitCode = 1;
  });
