import { boolean, object, type infer as zInfer } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { desktopShellPayloadSchema } from "./desktop-shell-schemas";
import {
  computerUseCommandCreateResponseSchema,
  desktopShellKindSchema,
} from "./computer-use";

export {
  desktopShellSessionSchema,
  desktopShellResultSchema,
} from "./desktop-shell-schemas";

export const desktopShellRequestSchema = object({
  kind: desktopShellKindSchema,
  ...desktopShellPayloadSchema.omit({ shellPermissionId: true }).shape,
  waitMs: desktopShellPayloadSchema.shape.waitMs.default(10_000),
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
