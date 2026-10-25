import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { runnerHeartbeatGenerationSchema } from "./runner-primitives";

const c = initContract();
const nativeWindowId = z.int().nonnegative();
const instanceIdentity = { instanceId: z.uuid() };
const windowIdentity = { ...instanceIdentity, primaryWindowId: nativeWindowId };
const browserWindowSchema = z.strictObject({
  chatThreadId: z.uuid(),
  state: z.enum(["active", "closing"]),
  expiresAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  primaryWindowId: nativeWindowId,
});

const actionSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("inspect"),
    instanceId: z.uuid().optional(),
  }),
  z.strictObject({ kind: z.literal("allocate"), providerProfileId: z.uuid() }),
  z.strictObject({
    kind: z.literal("publish"),
    ...instanceIdentity,
    providerSessionId: z.uuid(),
    timeoutAt: z.iso.datetime(),
  }),
  z.strictObject({ kind: z.literal("admit"), ...windowIdentity }),
  z.strictObject({ kind: z.literal("renew"), ...windowIdentity }),
  z.strictObject({
    kind: z.literal("retire"),
    ...windowIdentity,
    reason: z.enum(["expired", "closed"]),
  }),
  z.strictObject({ kind: z.literal("completeWindowClose"), ...windowIdentity }),
  z.strictObject({ kind: z.literal("beginStop"), ...instanceIdentity }),
  z.strictObject({ kind: z.literal("completeStop"), ...instanceIdentity }),
]);

const requestSchema = z.strictObject({
  runnerIdentity: z.strictObject({
    runnerId: z.uuid(),
    heartbeatGeneration: runnerHeartbeatGenerationSchema,
  }),
  action: actionSchema,
});

const instanceSchema = z.strictObject({
  id: z.uuid(),
  ownerProfileId: z.uuid(),
  providerProfileId: z.uuid(),
  providerSessionId: z.uuid().nullable(),
  status: z.enum(["creating", "active", "stopping", "stopped"]),
  creationExpiresAt: z.iso.datetime(),
  timeoutAt: z.iso.datetime(),
  // The host sees only the current Run's chat, including its cleanup identities.
  window: browserWindowSchema.nullable(),
});

export const runnerBrowserContract = c.router({
  control: {
    method: "POST",
    path: "/api/runners/runs/:runId/browser/control",
    pathParams: z.strictObject({ runId: z.uuid() }),
    headers: authHeadersSchema,
    body: requestSchema,
    responses: {
      200: z.discriminatedUnion("outcome", [
        z.strictObject({
          outcome: z.literal("accepted"),
          instance: instanceSchema,
        }),
        z.strictObject({ outcome: z.literal("unavailable") }),
      ]),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Control exact Browser lifetimes from the current official Runner",
  },
});

export type RunnerBrowserRequest = z.infer<typeof requestSchema>;
export type RunnerBrowserAction = z.infer<typeof actionSchema>;
export type RunnerBrowserResponse = z.infer<
  (typeof runnerBrowserContract.control.responses)[200]
>;
