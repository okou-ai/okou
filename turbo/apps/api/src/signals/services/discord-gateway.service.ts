import { command } from "ccstate";
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
import { writeDb$, type Db } from "../external/db";
import { safeJsonParse, tapError } from "../utils";
import { processCanonicalDiscordIngress$ } from "./canonical-discord-ingress-processor.service";
import {
  admitCanonicalDiscordChatEvent,
  findCanonicalDiscordIngressByMessage,
  hasCanonicalDiscordMessageReceipt,
} from "./discord-chat-ingress.service";
import { getDiscordAppConfig } from "./discord-config";
import {
  discordDmBinding,
  discordGuildBotUserId,
  discordGuildUserBinding,
  type DiscordVerifiedBinding,
} from "./discord-data.service";
import { uninstallDiscordGuild$ } from "./discord-gateway-lifecycle.service";

const L = logger("DiscordGateway");
const MAX_BODY_BYTES = 1024 * 1024;

function gatewayError(key: ApiErrorKey, message: string): Response {
  const response = createErrorResponse(key, message);
  return Response.json(response.body, { status: response.status });
}

function ignored(reason: string): Response {
  return Response.json({ ok: true, outcome: "ignored", reason });
}

async function existingMessageResponse(
  db: Db,
  applicationId: string,
  message: DiscordMessageCreate,
  signal: AbortSignal,
): Promise<Response | undefined> {
  const previous = await findCanonicalDiscordIngressByMessage(db, message.id);
  signal.throwIfAborted();
  if (previous) {
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
  if (await hasCanonicalDiscordMessageReceipt(db, applicationId, message.id)) {
    signal.throwIfAborted();
    return Response.json({ ok: true, outcome: "duplicate" });
  }
  return undefined;
}

const handleDiscordMessage$ = command(
  async (
    { get, set },
    envelope: DiscordGatewayEnvelope,
    body: string,
    signal: AbortSignal,
  ): Promise<Response> => {
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
    const previousResponse = await existingMessageResponse(
      set(writeDb$),
      envelope.applicationId,
      message,
      signal,
    );
    if (previousResponse) {
      return previousResponse;
    }
    if (message.guild_id) {
      // Ordinary guild chatter must not reach the identity provider: a
      // failure there would stall the relay's ordered delivery for everyone.
      const botUserId = await get(discordGuildBotUserId(message.guild_id));
      signal.throwIfAborted();
      if (!botUserId) {
        return ignored("unbound-disabled-or-dm-selection-required");
      }
      if (!hasDiscordBotMention(message, botUserId)) {
        return ignored("no-explicit-mention");
      }
    }
    let selection: DiscordVerifiedBinding | null;
    if (message.guild_id) {
      selection = await get(
        discordGuildUserBinding({
          guildId: message.guild_id,
          discordUserId: message.author.id,
        }),
      );
    } else {
      const result = await get(discordDmBinding(message.author.id));
      signal.throwIfAborted();
      selection = result.kind === "connected" ? result.binding : null;
    }
    signal.throwIfAborted();
    if (!selection) {
      return ignored("unbound-disabled-or-dm-selection-required");
    }
    if (message.author.id === selection.botUserId) {
      return ignored("self-message");
    }
    const ingress = await admitCanonicalDiscordChatEvent(set(writeDb$), {
      applicationId: envelope.applicationId,
      connectionId: selection.connectionId,
      messageId: message.id,
      eventId: envelope.eventId,
      payload: body,
      currentTime: nowDate(),
    });
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
            { ingressId: ingress.id },
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
      const outcome = await set(
        uninstallDiscordGuild$,
        {
          applicationId: config.applicationId,
          botToken: config.botToken,
          guildId: guild.data.id,
          eventId: envelope.eventId,
        },
        signal,
      );
      signal.throwIfAborted();
      if (outcome === "provider-unavailable") {
        return gatewayError(
          "PROVIDER_UNAVAILABLE",
          "Discord guild membership could not be verified",
        );
      }
      if (outcome === "still-member") {
        // A late removal must not delete a newer installation of this guild.
        return ignored("guild-membership-current");
      }
      return Response.json({ ok: true, outcome });
    }

    return await set(handleDiscordMessage$, envelope, body, signal);
  },
);
