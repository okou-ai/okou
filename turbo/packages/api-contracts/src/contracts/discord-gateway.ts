import {
  discriminatedUnion,
  literal,
  object,
  record,
  strictObject,
  string,
  enum as zEnum,
  unknown as zUnknown,
  type infer as zInfer,
} from "zod";

import { initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const DISCORD_GATEWAY_TIMESTAMP_HEADER =
  "x-discord-gateway-timestamp" as const;
export const DISCORD_GATEWAY_SIGNATURE_HEADER =
  "x-discord-gateway-signature" as const;
/** The verifier rejects both older and further-future signed requests. */
export const DISCORD_GATEWAY_MAX_CLOCK_SKEW_SECONDS = 300;

/** The API resolves Okou identities; transport may supply only Discord data. */
export const discordGatewayEnvelopeSchema = strictObject({
  version: literal(1),
  applicationId: string().regex(/^\d{17,20}$/),
  eventType: zEnum(["MESSAGE_CREATE", "GUILD_DELETE"]),
  eventId: string().min(1).max(255),
  // The ingress owner validates the actual Discord event for its eventType.
  payload: record(string(), zUnknown()),
});

export const discordGatewayHeadersSchema = object({
  // Optional here so the handler classifies absent credentials as 401.
  [DISCORD_GATEWAY_TIMESTAMP_HEADER]: string().optional(),
  [DISCORD_GATEWAY_SIGNATURE_HEADER]: string().optional(),
});

/** A success receipt is sent only after durable admission or intentional ignore. */
export const discordGatewayReceiptSchema = discriminatedUnion("outcome", [
  object({
    ok: literal(true),
    outcome: zEnum(["accepted", "duplicate"]),
  }),
  object({
    ok: literal(true),
    outcome: literal("ignored"),
    reason: string().min(1),
  }),
]);

/** Sign these UTF-8 bytes with HMAC-SHA256 and encode the digest as lowercase hex. */
export function discordGatewaySigningPayload(
  timestamp: string,
  rawBody: string,
): string {
  return `${timestamp}.${rawBody}`;
}

/** Public, synthetic vectors shared by the API verifier and Gateway signer. */
export const DISCORD_GATEWAY_AUTH_TEST_VECTORS = [
  {
    secret: "discord-gateway-test-secret-32-bytes",
    timestamp: "1790240400",
    rawBody:
      '{"version":1,"applicationId":"123456789012345678","eventType":"MESSAGE_CREATE","eventId":"MESSAGE_CREATE:987654321098765432","payload":{"id":"987654321098765432","content":"<@123456789012345678> hello"}}',
    signature:
      "ae2bacbf1245b1ecafb3eace48aa3b3efec7d2678deb86100eec6eda66676a69",
  },
  {
    secret: "discord-gateway-test-secret-32-bytes",
    timestamp: "1790240400",
    rawBody:
      '{\n  "version": 1, "applicationId": "123456789012345678",\n  "eventType": "GUILD_DELETE", "eventId": "GUILD_DELETE:session:42",\n  "payload": {"id": "234567890123456789", "unavailable": true, "name": "测试 👋"}\n}\n',
    signature:
      "a1b23228ae197d42d55e0ce484bcdc8cefa1923407d4d5a5b68f8f6e79e091da",
  },
] as const;

export const discordGatewayContract = c.router({
  post: {
    method: "POST",
    path: "/api/internal/discord/gateway",
    headers: discordGatewayHeadersSchema,
    body: discordGatewayEnvelopeSchema,
    responses: {
      200: discordGatewayReceiptSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      413: apiErrorSchema,
      500: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Durably accept an authenticated Discord Gateway event",
  },
});

export type DiscordGatewayEnvelope = zInfer<
  typeof discordGatewayEnvelopeSchema
>;
export type DiscordGatewayReceipt = zInfer<typeof discordGatewayReceiptSchema>;
export type DiscordGatewayContract = typeof discordGatewayContract;
