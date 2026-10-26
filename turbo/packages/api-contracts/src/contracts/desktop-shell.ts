import {
  array,
  boolean,
  number,
  object,
  string,
  uuid,
  enum as zEnum,
  type infer as zInfer,
} from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import {
  computerUseCommandCreateResponseSchema,
  desktopShellKindSchema,
} from "./computer-use";

export const desktopShellRequestSchema = object({
  kind: desktopShellKindSchema,
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
  waitMs: number().int().min(1000).max(30_000).default(10_000),
  all: boolean().optional(),
  realtime: boolean().optional(),
})
  .superRefine((body, ctx) => {
    const invalid = (message: string) => {
      return ctx.addIssue({ code: "custom", message });
    };
    if (
      [body.command, body.input, body.key].filter((value) => {
        return value !== undefined;
      }).length > 1
    )
      invalid("Command, input and key are mutually exclusive");
    if (body.sessionId && body.newSession)
      invalid("Session and newSession are mutually exclusive");
    if (body.cwd && (body.sessionId || body.command === undefined))
      invalid("cwd is valid only when creating a session with a command");
    if (body.newSession && body.command === undefined)
      invalid("newSession requires a command");
  })
  .superRefine((body, ctx) => {
    const invalid = (message: string) => {
      ctx.addIssue({ code: "custom", message });
    };
    if (body.kind === "shell.status" && !body.sessionId)
      invalid("status requires sessionId");
    if (
      body.kind === "shell.close" &&
      Boolean(body.sessionId) === Boolean(body.all)
    )
      invalid("Choose sessionId or all for close");
    if (
      body.kind !== "shell.cmd" &&
      (body.command !== undefined ||
        body.input !== undefined ||
        body.key !== undefined ||
        body.newSession ||
        body.cwd ||
        body.cursor !== undefined)
    )
      invalid("Input and creation options require shell.cmd");
    if (body.kind !== "shell.close" && body.all)
      invalid("all requires shell.close");
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

export const desktopShellContract = initContract().router({
  create: {
    method: "POST",
    path: "/api/computer-use/shell/commands",
    headers: authHeadersSchema,
    body: desktopShellRequestSchema,
    responses: {
      200: computerUseCommandCreateResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary:
      "Interact with computer-scoped native Shell sessions through the existing command pipeline",
  },
});

export type DesktopShellRequest = zInfer<typeof desktopShellRequestSchema>;
