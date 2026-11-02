import {
  array,
  boolean,
  number,
  object,
  string,
  uuid,
  enum as zEnum,
} from "zod";

/** Fields already sent through the Computer Use queue by Shell-capable Desktop builds. */
export const desktopShellPayloadSchema = object({
  sessionId: uuid().optional(),
  command: string().min(1).max(64_000).optional(),
  input: string().min(1).max(16_384).optional(),
  key: zEnum([
    "Ctrl+C",
    "Ctrl+D",
    "Ctrl+Z",
    "Enter",
    "Escape",
    "Tab",
  ]).optional(),
  newSession: boolean().optional(),
  cwd: string().startsWith("/").max(4096).optional(),
  cursor: number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  waitMs: number().int().min(1000).max(30_000).optional(),
  all: boolean().optional(),
  shellPermissionId: uuid().optional(),
});

export const desktopShellSessionSchema = object({
  id: uuid(),
  state: zEnum(["open", "closed"]),
  initialCwd: string(),
  cwd: string(),
  commandState: zEnum(["unknown", "running", "completed"]),
  exitCode: number().int().nullable(),
  shellExitCode: number().int().nullable(),
  shellExitSignal: number().int().nullable(),
  closeReason: string().nullable(),
  oldestCursor: number().int().nonnegative(),
  endCursor: number().int().nonnegative(),
  idleRemainingSeconds: number().nonnegative(),
  cols: number().int().positive(),
  rows: number().int().positive(),
});

export const desktopShellResultSchema = object({
  session: desktopShellSessionSchema.optional(),
  sessions: array(desktopShellSessionSchema).optional(),
  closed: boolean().optional(),
  outputBase64: string().max(45_000).optional(),
  nextCursor: number().int().nonnegative().optional(),
  lostBytes: number().int().nonnegative().optional(),
  moreAvailable: boolean().optional(),
  reason: zEnum([
    "command_completed",
    "output_idle",
    "output_limit",
    "wait_elapsed",
    "session_closed",
  ]).optional(),
});
