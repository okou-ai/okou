import { command } from "ccstate";
import { discordChatIngress } from "@okouai/db/schema/discord-chat-ingress";
import { discordGatewayReceipts } from "@okouai/db/schema/discord-gateway-receipt";
import { eq } from "drizzle-orm";
import {
  createErrorResponse,
  type ApiErrorKey,
} from "@okouai/api-contracts/contracts/errors";
import {
  DISCORD_GATEWAY_SIGNATURE_HEADER,
  DISCORD_GATEWAY_TIMESTAMP_HEADER,
  discordGatewayEnvelopeSchema,
  type DiscordGatewayEnvelope,
} from "@okouai/api-contracts/contracts/discord-gateway";

import {
  discordGuildDeleteSchema,
  discordMessageCreateSchema,
  hasDiscordBotMention,
  isDiscordUserMessage,
  type DiscordMessageCreate,
} from "../../lib/discord-gateway-event";
import { verifyDiscordGatewaySignature } from "../../lib/discord-gateway-verification";
import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import { request$ } from "../context/hono";
import { waitUntil } from "../context/wait-until";
import { writeDb$ } from "../external/db";
import { safeJsonParse, tapError } from "../utils";
import { processCanonicalDiscordIngress$ } from "./canonical-discord-ingress-processor.service";
import {
  admitCanonicalDiscordChatEvent$,
  discordMessageReceiptDigest,
} from "./discord-chat-ingress.service";
import { getDiscordAppConfig } from "./discord-config";
import {
  readDiscordDmBinding$,
  type DiscordVerifiedBinding,
} from "./discord-data.service";
import { sendDiscordAdmissionNotice$ } from "./discord-admission-notice.service";

const L = logger("DiscordGateway");
const MAX_BODY_BYTES = 1024 * 1024;

function gatewayError(key: ApiErrorKey, message: string): Response {
  const response = createErrorResponse(key, message);
  return Response.json(response.body, { status: response.status });
}

function ignored(reason: string): Response {
  return Response.json({ ok: true, outcome: "ignored", reason });
}

function previousMessageResponse(
  previous: Pick<typeof discordChatIngress.$inferSelect, "payload">,
  message: DiscordMessageCreate,
): Response {
  const acceptedEnvelope = discordGatewayEnvelopeSchema.parse(
    JSON.parse(previous.payload),
  );
  const acceptedMessage = discordMessageCreateSchema.parse(
    acceptedEnvelope.payload,
  );
  if (
    acceptedMessage.author.id !== message.author.id ||
    acceptedMessage.channel_id !== message.channel_id ||
    acceptedMessage.guild_id !== message.guild_id
  ) {
    return gatewayError("BAD_REQUEST", "Message identity changed");
  }
  // The persisted sender/connection remains authoritative across retries,
  // even when the sender changes their selected DM organization meanwhile.
  return Response.json({ ok: true, outcome: "duplicate" });
}

interface DiscordMessageArgs {
  readonly envelope: DiscordGatewayEnvelope;
  readonly body: string;
  readonly botToken: string;
}

const handleDiscordMessage$ = command(
  async (
    { set },
    args: DiscordMessageArgs,
    signal: AbortSignal,
  ): Promise<Response> => {
    const { envelope, body, botToken } = args;
    const parsedMessage = discordMessageCreateSchema.safeParse(
      envelope.payload,
    );
    if (!parsedMessage.success) {
      return gatewayError("BAD_REQUEST", "Invalid message event");
    }
    const message = parsedMessage.data;
    if (!isDiscordUserMessage(message)) {
      return ignored("unsupported-message");
    }
    const db = set(writeDb$);
    const applicationId = envelope.applicationId;
    const previousResponse = await (async (duplicateSignal: AbortSignal) => {
      const messageId = message.id;
      const [previous] = await db
        .select({
          id: discordChatIngress.id,
          payload: discordChatIngress.payload,
        })
        .from(discordChatIngress)
        .where(eq(discordChatIngress.messageId, messageId))
        .limit(1);
      duplicateSignal.throwIfAborted();
      if (previous) {
        return previousMessageResponse(previous, message);
      }
      const receiptMessageId = message.id;
      const [receipt] = await db
        .select({ eventDigest: discordGatewayReceipts.eventDigest })
        .from(discordGatewayReceipts)
        .where(
          eq(
            discordGatewayReceipts.eventDigest,
            discordMessageReceiptDigest(applicationId, receiptMessageId),
          ),
        )
        .limit(1);
      const hasReceipt = Boolean(receipt);
      if (hasReceipt) {
        duplicateSignal.throwIfAborted();
        return Response.json({ ok: true, outcome: "duplicate" });
      }
      return undefined;
    })(signal);
    if (previousResponse) {
      return previousResponse;
    }
    if (message.guild_id) {
      // Ordinary guild chatter must not reach the identity provider: a
      // failure there would stall the relay's ordered delivery for everyone.
      // Discord's bot user ID is its application ID, including before the
      // sender connects their Okou account.
      if (!hasDiscordBotMention(message, envelope.applicationId)) {
        return ignored("no-explicit-mention");
      }
    }
    const result = await set(readDiscordDmBinding$, message.author.id);
    signal.throwIfAborted();
    const selection: DiscordVerifiedBinding | null =
      result.kind === "connected" ? result.binding : null;
    const noticeKind =
      result.kind === "connected" ? "not-connected" : result.kind;
    signal.throwIfAborted();
    if (!selection) {
      waitUntil(
        tapError(
          set(
            sendDiscordAdmissionNotice$,
            {
              applicationId: envelope.applicationId,
              botToken,
              message,
              kind: noticeKind,
            },
            signal,
          ),
          (error) => {
            L.warn("Discord admission notice failed", { error });
          },
        ),
      );
      return ignored("unbound-disabled-or-dm-selection-required");
    }
    if (message.author.id === selection.botUserId) {
      return ignored("self-message");
    }
    const ingress = await set(
      admitCanonicalDiscordChatEvent$,
      {
        applicationId: envelope.applicationId,
        connectionId: selection.connectionId,
        messageId: message.id,
        eventId: envelope.eventId,
        payload: body,
        currentTime: nowDate(),
      },
      signal,
    );
    signal.throwIfAborted();

    if (!ingress) {
      return Response.json({ ok: true, outcome: "duplicate" });
    }

    if (ingress.status !== "processed" && ingress.status !== "terminal") {
      // This bounded owner may outlive the HTTP request. The durable ingress
      // sweep resumes any unfinished attempt after the deadline or a crash.
      const processingSignal = AbortSignal.timeout(60_000);
      waitUntil(
        tapError(
          set(
            processCanonicalDiscordIngress$,
            { ingressId: ingress.id, admittedBinding: selection },
            processingSignal,
          ),
          (error) => {
            L.warn("Discord ingress processing deferred to recovery", {
              ingressId: ingress.id,
              error,
            });
          },
        ),
      );
    }
    return Response.json({
      ok: true,
      outcome: ingress.inserted ? "accepted" : "duplicate",
    });
  },
);

export const handleDiscordGateway$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<Response> => {
    const config = getDiscordAppConfig();
    if (!config) {
      return gatewayError("PROVIDER_UNAVAILABLE", "Discord is not configured");
    }
    const request = get(request$);
    const body = await request.raw.text();
    signal.throwIfAborted();
    if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
      return gatewayError("PAYLOAD_TOO_LARGE", "Gateway body is too large");
    }
    if (
      !verifyDiscordGatewaySignature({
        secret: config.gatewaySecret,
        timestamp: request.raw.headers.get(DISCORD_GATEWAY_TIMESTAMP_HEADER),
        signature: request.raw.headers.get(DISCORD_GATEWAY_SIGNATURE_HEADER),
        body,
      })
    ) {
      return gatewayError("UNAUTHORIZED", "Invalid Gateway signature");
    }
    const parsed = discordGatewayEnvelopeSchema.safeParse(safeJsonParse(body));
    if (!parsed.success) {
      return gatewayError("BAD_REQUEST", "Invalid Gateway envelope");
    }
    const envelope = parsed.data;
    if (envelope.applicationId !== config.applicationId) {
      return gatewayError("FORBIDDEN", "Invalid application");
    }
    if (envelope.eventType === "GUILD_DELETE") {
      const guild = discordGuildDeleteSchema.safeParse(envelope.payload);
      if (!guild.success) {
        return gatewayError("BAD_REQUEST", "Invalid guild event");
      }
      if (guild.data.unavailable) {
        return ignored("guild-unavailable");
      }
      // Account consent survives a server removal. Provider access is checked
      // against the actual destination before every read, run and delivery.
      return ignored("guild-removed");
    }

    return await set(
      handleDiscordMessage$,
      { envelope, body, botToken: config.botToken },
      signal,
    );
  },
);
