import { createHash } from "node:crypto";
import {
  discriminatedUnion,
  iso,
  literal,
  object,
  string,
  union,
  uuid,
  enum as zEnum,
  type infer as zInfer,
} from "zod";

// Versioned with Marketing's event inbox; this protocol carries source facts,
// never provider credentials, campaign eligibility or funding instructions.
const environment = zEnum(["production", "preview", "development"]);
export const marketingRewardOAuthEventSchema = object({
  version: literal(1),
  id: uuid(),
  environment,
  type: literal("connector.oauth-authorized"),
  occurredAt: iso.datetime(),
  orgId: string().min(1).max(256),
  userId: string().min(1).max(256),
  connectionId: uuid(),
  connector: discriminatedUnion("kind", [
    object({
      kind: literal("builtin"),
      connectorSlug: string()
        .min(1)
        .max(64)
        .regex(/^[a-z0-9][a-z0-9-]*$/u),
    }).strict(),
    object({ kind: literal("custom"), customConnectorId: uuid() }).strict(),
  ]),
}).strict();

export type MarketingRewardOAuthEvent = zInfer<
  typeof marketingRewardOAuthEventSchema
>;

const linkedSourceIdentity = Object.freeze({
  version: literal(2),
  id: uuid(),
  environment,
});
const linkedSourceOwnership = Object.freeze({
  occurredAt: iso.datetime(),
  orgId: string().min(1).max(256),
  userId: string().min(1).max(256),
});

const marketingRewardLinkEventSchema = discriminatedUnion("type", [
  object({
    ...linkedSourceIdentity,
    type: literal("imessage.identity-linked"),
    ...linkedSourceOwnership,
    linkId: uuid(),
  }).strict(),
  object({
    ...linkedSourceIdentity,
    type: literal("slack.oauth-authorized"),
    ...linkedSourceOwnership,
    workspaceId: string().min(1).max(255),
  }).strict(),
]);
export type MarketingRewardLinkEvent = zInfer<
  typeof marketingRewardLinkEventSchema
>;

export const marketingRewardSourceEventSchema = union([
  marketingRewardOAuthEventSchema,
  marketingRewardLinkEventSchema,
]);
export type MarketingRewardSourceEvent = zInfer<
  typeof marketingRewardSourceEventSchema
>;

export const marketingRewardEventReceiptSchema = object({
  version: literal(1),
  environment,
  eventId: uuid(),
  hash: string().regex(/^[a-f0-9]{64}$/u),
  receivedAt: iso.datetime(),
}).strict();

export function marketingRewardEventHash(event: MarketingRewardSourceEvent) {
  return createHash("sha256")
    .update(JSON.stringify(marketingRewardSourceEventSchema.parse(event)))
    .digest("hex");
}
