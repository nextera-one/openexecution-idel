/** Defense-in-depth boundary for commands originating in a language model. */

export const MODEL_NATIVE_REJECTION =
  "Model-proposed native passthrough (`! ...`) is not allowed; propose a typed IDEL command.";

/**
 * Native passthrough remains a deliberate human-facing runtime feature, but a
 * model must never select it. Reject every leading-bang spelling before the
 * command reaches parsing, safety classification, approval, or execution.
 */
export function isModelProposedNative(command: string): boolean {
  return command.trimStart().startsWith("!");
}
