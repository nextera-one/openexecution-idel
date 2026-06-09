/**
 * Core safety floors.
 *
 * These are the non-overridable minimum risk classifications. Registry content
 * resolves custom > official > core, but these floors resolve core-first: no
 * custom or official command definition may classify any of these situations
 * below the stated level. The detection rules in {@link ./ast} and
 * {@link ./resolved} are the *enforcement* of these floors; this list is the
 * declarative, auditable statement of them (used by the runtime to assert that
 * an assessment never came back softer than the floor it triggers).
 *
 * Each floor's `code` matches the `RiskFinding.code` the engine emits when the
 * corresponding situation is detected, so the runtime can cross-check them.
 */

import type { SafetyFloor } from "@openexecution/types";

export const SAFETY_FLOORS: readonly SafetyFloor[] = [
  {
    code: "root-delete",
    level: "CRITICAL",
    description:
      "Destructive operation whose target resolves to the filesystem root (/). Always CRITICAL.",
  },
  {
    code: "home-delete",
    level: "CRITICAL",
    description:
      "Destructive operation whose target resolves to the user's home directory. Always CRITICAL.",
  },
  {
    code: "drive-root-delete",
    level: "CRITICAL",
    description:
      "Destructive operation whose target resolves to a drive root (C:\\, a UNC share root, or /). Always CRITICAL.",
  },
  {
    code: "device-write",
    level: "CRITICAL",
    description:
      "Write/disk operation targeting a raw device path (/dev/sd*, /dev/nvme*, \\\\.\\PhysicalDrive*). Destroys the underlying disk. Always CRITICAL.",
  },
  {
    code: "recursive-chmod-777-broad",
    level: "CRITICAL",
    description:
      "Recursive permission change to mode 777 on a broad target (root, home, drive root, or a large tree). Always CRITICAL.",
  },
  {
    code: "empty-target",
    level: "HIGH",
    description:
      "Destructive verb invoked with an empty or missing target parameter. Blocked: classified at least HIGH.",
  },
];
