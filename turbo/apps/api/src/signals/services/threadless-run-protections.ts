import { piMemoryPhase2ThreadlessRunProtection } from "./pi-memory-phase2-threadless-protection.service";
import type { ThreadlessRunProtection } from "./threadless-run-protection.service";

/** Every module that launches protected threadless Runs registers here. */
export const THREADLESS_RUN_PROTECTIONS: readonly ThreadlessRunProtection[] = [
  piMemoryPhase2ThreadlessRunProtection,
];
