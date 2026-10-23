import * as z from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import {
  computerUseCommandCreateResponseSchema,
  desktopShellKindSchema,
} from "./computer-use";

export const desktopShellRequestSchema = z
  .object({
    kind: desktopShellKindSchema,
    sessionId: z.uuid().optional(),
    command: z.string().min(1).max(64_000).optional(),
    input: z.string().min(1).max(16_384).optional(),
    key: z
      .enum(["Ctrl+C", "Ctrl+D", "Ctrl+Z", "Enter", "Escape", "Tab"])
      .optional(),
    newSession: z.boolean().optional(),
    cwd: z.string().startsWith("/").max(4096).optional(),
    cursor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    waitMs: z.number().int().min(1000).max(30_000).default(10_000),
    all: z.boolean().optional(),
    realtime: z.boolean().optional(),
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

export const desktopShellSessionSchema = z.object({
  id: z.uuid(),
  state: z.enum(["open", "closed"]),
  initialCwd: z.string(),
  cwd: z.string(),
  commandState: z.enum(["unknown", "running", "completed"]),
  exitCode: z.number().int().nullable(),
  shellExitCode: z.number().int().nullable(),
  shellExitSignal: z.number().int().nullable(),
  closeReason: z.string().nullable(),
  oldestCursor: z.number().int().nonnegative(),
  endCursor: z.number().int().nonnegative(),
  idleRemainingSeconds: z.number().nonnegative(),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
});

export const desktopShellResultSchema = z.object({
  session: desktopShellSessionSchema.optional(),
  sessions: z.array(desktopShellSessionSchema).optional(),
  closed: z.boolean().optional(),
  outputBase64: z.string().max(45_000).optional(),
  nextCursor: z.number().int().nonnegative().optional(),
  lostBytes: z.number().int().nonnegative().optional(),
  moreAvailable: z.boolean().optional(),
  reason: z
    .enum([
      "command_completed",
      "output_idle",
      "output_limit",
      "wait_elapsed",
      "session_closed",
    ])
    .optional(),
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

export type DesktopShellRequest = z.infer<typeof desktopShellRequestSchema>;
