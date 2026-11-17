import {
  discriminatedUnion,
  iso,
  literal,
  object,
  string,
  uuid,
  enum as zEnum,
} from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

export const marketingInvitationSourceObservationSchema = object({
  version: literal(1),
  environment: zEnum(["production", "preview", "development"]),
  observedAt: iso.datetime(),
  source: object({
    eventId: uuid(),
    occurredAt: iso.datetime(),
    orgId: string().min(1).max(256),
    inviterUserId: string().min(1).max(256),
    claimId: uuid(),
    sourceKey: string().min(1).max(256),
    invitationId: string().min(1).max(256),
  }).strict(),
  observation: discriminatedUnion("kind", [
    object({ kind: literal("unavailable") }).strict(),
    object({
      kind: literal("invitation"),
      status: zEnum(["pending", "accepted", "revoked", "expired"]),
      expiresAt: iso.datetime(),
    }).strict(),
  ]),
}).strict();

export const marketingInvitationSourceContract = initContract().router({
  observe: {
    method: "GET",
    path: "/api/internal/marketing/get-started/invitation-sources/:eventId",
    headers: authHeadersSchema,
    pathParams: object({ eventId: uuid() }),
    responses: {
      200: marketingInvitationSourceObservationSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary:
      "Read exact invitation authority facts using the dedicated source capability",
  },
});
