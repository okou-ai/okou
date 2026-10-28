import {
  discriminatedUnion,
  int,
  iso,
  literal,
  number,
  strictObject,
  uuid,
  enum as zEnum,
  type infer as zInfer,
} from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { runnerHeartbeatGenerationSchema } from "./runner-primitives";

const c = initContract();
const nativeWindowId = int().nonnegative();
const runnerIdentitySchema = strictObject({
  runnerId: uuid(),
  heartbeatGeneration: runnerHeartbeatGenerationSchema,
});
const instanceIdentity = { instanceId: uuid() };
const windowIdentity = { ...instanceIdentity, primaryWindowId: nativeWindowId };
const browserWindowSchema = strictObject({
  chatThreadId: uuid(),
  state: zEnum(["active", "closing"]),
  expiresAt: number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  primaryWindowId: nativeWindowId,
});

const actionSchema = discriminatedUnion("kind", [
  strictObject({
    kind: literal("inspect"),
    instanceId: uuid().optional(),
  }),
  strictObject({ kind: literal("allocate") }),
  strictObject({
    kind: literal("publish"),
    ...instanceIdentity,
    providerSessionId: uuid(),
    timeoutAt: iso.datetime(),
  }),
  strictObject({ kind: literal("admit"), ...instanceIdentity }),
  strictObject({ kind: literal("renew"), ...windowIdentity }),
  strictObject({
    kind: literal("retire"),
    ...windowIdentity,
    reason: zEnum(["expired", "closed"]),
  }),
  strictObject({ kind: literal("completeWindowClose"), ...windowIdentity }),
  strictObject({ kind: literal("beginStop"), ...instanceIdentity }),
  strictObject({ kind: literal("completeStop"), ...instanceIdentity }),
]);

const requestSchema = strictObject({
  runnerIdentity: runnerIdentitySchema,
  action: actionSchema,
});

const instanceSchema = strictObject({
  id: uuid(),
  ownerProfileId: uuid(),
  providerProfileId: uuid(),
  providerSessionId: uuid().nullable(),
  status: zEnum(["creating", "active", "stopping", "stopped"]),
  creationExpiresAt: iso.datetime(),
  timeoutAt: iso.datetime(),
  // The host sees only the current Run's chat, including its cleanup identities.
  window: browserWindowSchema.nullable(),
});

export const runnerBrowserContract = c.router({
  control: {
    method: "POST",
    path: "/api/runners/runs/:runId/browser/control",
    pathParams: strictObject({ runId: uuid() }),
    headers: authHeadersSchema,
    body: requestSchema,
    responses: {
      200: discriminatedUnion("outcome", [
        strictObject({
          outcome: literal("accepted"),
          instance: instanceSchema,
        }),
        strictObject({ outcome: literal("unavailable") }),
      ]),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
      502: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Control exact Browser lifetimes from the current official Runner",
  },
});

export type RunnerBrowserRequest = zInfer<typeof requestSchema>;
export type RunnerBrowserAction = zInfer<typeof actionSchema>;
export type RunnerBrowserResponse = zInfer<
  (typeof runnerBrowserContract.control.responses)[200]
>;
