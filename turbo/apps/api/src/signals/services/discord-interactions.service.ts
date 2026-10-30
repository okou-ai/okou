import {
  discordInteractionSchema,
  type DiscordCommandInteraction,
  type DiscordComponentInteraction,
} from "@okouai/api-contracts/contracts/discord-interactions";
import { command } from "ccstate";
import { delay } from "signal-timers";

import type { DiscordCommandName } from "../../lib/discord-command-definition";
import { discordConnectMessage } from "../../lib/discord-connect-message";
import {
  discordAccountLabel,
  discordAccountMessage,
  discordAccountPicker,
  type DiscordAccountMessage,
} from "../../lib/discord-interaction-messages";
import {
  parseDiscordPickerCustomId,
  resolveDiscordInteractionActor,
  verifyDiscordInteractionSignature,
  type DiscordInteractionActor,
  type DiscordPickerState,
} from "../../lib/discord-interaction-protocol";
import { env } from "../../lib/env";
import { monotonicNow } from "../../lib/time";
import { request$ } from "../context/hono";
import { waitUntil } from "../context/wait-until";
import {
  discordClient,
  type DiscordApiResult,
} from "../external/discord-client";
import {
  safeJsonParse,
  safeSync,
  settle,
  settleIncludingAbort,
} from "../utils";
import { requireDiscordConversationAccess$ } from "./discord-access.service";
import { getDiscordAppConfig } from "./discord-config";
import {
  disconnectDiscordBinding$,
  discordDmBinding,
  readDiscordEffectiveAgent$,
  discordSenderBindings,
  selectDiscordDmBinding$,
  type DiscordVerifiedBinding,
} from "./discord-data.service";

const UNCONFIRMED_REQUEST =
  "Discord could not confirm this request in time, so no changes were made. Run the command again.";
// Discord's 3 s initial-response deadline plus a margin for in-flight delivery.
const DISCORD_RESPONSE_WINDOW_MS = 3500;
const STALE_CONTROL =
  "This control has expired or your access has changed. Run the command again.";
function discordHelp(): string {
  return [
    "**Discord Bot Help**",
    "",
    "**Commands**",
    "• `/help` - Show commands and usage",
    "• `/connect` - Connect to Okou",
    "• `/disconnect` - Disconnect from Okou",
    "",
    "**Usage**",
    "• Send a DM to this bot or mention it in a channel to message your workspace's default agent",
    "• Use `/connect` to choose your workspace",
  ].join("\n");
}

type AccountInteraction =
  DiscordCommandInteraction | DiscordComponentInteraction;

const currentDiscordBinding$ = command(
  async ({ get }, actor: DiscordInteractionActor, signal: AbortSignal) => {
    const binding = await get(discordDmBinding(actor.discordUserId));
    signal.throwIfAborted();
    return binding;
  },
);

const discordChannelFailure$ = command(
  async (
    { set },
    binding: DiscordVerifiedBinding,
    actor: DiscordInteractionActor,
    signal: AbortSignal,
  ): Promise<DiscordAccountMessage | null> => {
    const access = await set(
      requireDiscordConversationAccess$,
      {
        orgId: binding.orgId,
        userId: binding.userId,
        channelId: actor.channelId,
        ...(actor.guildId ? { guildId: actor.guildId } : {}),
        mode: "view",
      },
      signal,
    );
    if (access.kind === "denied") {
      return discordAccountMessage(access.response.body.error.message);
    }
    return access.binding.connectionId === binding.connectionId
      ? null
      : discordAccountMessage(STALE_CONTROL);
  },
);

const discordConnectionStatus$ = command(
  async (
    { set },
    binding: DiscordVerifiedBinding,
    signal: AbortSignal,
  ): Promise<DiscordAccountMessage> => {
    const agent = await set(readDiscordEffectiveAgent$, binding);
    signal.throwIfAborted();
    const agentStatus = agent
      ? `Workspace agent: ${discordAccountLabel(agent.displayName || agent.name)}.`
      : "No workspace agent available. Ask a workspace admin to set one in Okou.";
    return discordAccountMessage(
      `✅ You are already connected to Okou.\nMention <@${binding.botUserId}> in a channel or send a DM to start chatting with your agent.\n\n${agentStatus}`,
    );
  },
);

const discordOrgPicker$ = command(
  async (
    { get, set },
    args: {
      readonly actor: DiscordInteractionActor;
      readonly botToken: string;
      readonly page?: number;
      readonly selection?: string;
    },
    signal: AbortSignal,
  ): Promise<DiscordAccountMessage> => {
    const bindings = await get(discordSenderBindings(args.actor.discordUserId));
    signal.throwIfAborted();
    if (bindings.length === 0) {
      return discordConnectMessage(args.actor.guildId);
    }
    if (
      bindings.length === 1 &&
      args.page === undefined &&
      args.selection === undefined
    ) {
      const binding = bindings[0]!;
      const channelFailure = await set(
        discordChannelFailure$,
        binding,
        args.actor,
        signal,
      );
      return channelFailure ?? set(discordConnectionStatus$, binding, signal);
    }
    if (args.selection !== undefined) {
      const selected = bindings.find((binding) => {
        return binding.connectionId === args.selection;
      });
      if (!selected) {
        return discordAccountMessage(STALE_CONTROL);
      }
      const channelFailure = await set(
        discordChannelFailure$,
        selected,
        args.actor,
        signal,
      );
      if (channelFailure) {
        return channelFailure;
      }
      const saved = await set(
        selectDiscordDmBinding$,
        {
          discordUserId: args.actor.discordUserId,
          connectionId: selected.connectionId,
        },
        signal,
      );
      return discordAccountMessage(
        saved
          ? "✅ Workspace selected for Discord. Message the bot to start chatting."
          : STALE_CONTROL,
      );
    }
    const current = await get(discordDmBinding(args.actor.discordUserId));
    signal.throwIfAborted();
    const options = [...bindings]
      .sort((left, right) => {
        return left.connectionId.localeCompare(right.connectionId);
      })
      .map((binding) => {
        return {
          label: binding.orgName,

          value: binding.connectionId,
        };
      });
    return discordAccountPicker({
      ...args,
      action: "org",
      connectionId: "-",
      options,
      ...(current.kind === "connected"
        ? { selected: current.binding.connectionId }
        : {}),
      content: "Choose your workspace for Discord.",
      placeholder: "Select a workspace",
    });
  },
);

const discordBoundAccountAction$ = command(
  async (
    { set },
    args: {
      readonly action:
        DiscordCommandName | DiscordPickerState["action"] | undefined;
      readonly binding: DiscordVerifiedBinding;
      readonly actor: DiscordInteractionActor;
    },
    signal: AbortSignal,
  ): Promise<DiscordAccountMessage> => {
    if (args.action === "connect") {
      return set(discordConnectionStatus$, args.binding, signal);
    }
    if (args.action === "disconnect") {
      const disconnected = await set(
        disconnectDiscordBinding$,
        {
          connectionId: args.binding.connectionId,
          discordUserId: args.actor.discordUserId,
        },
        signal,
      );
      return discordAccountMessage(
        disconnected
          ? "✅ You have been disconnected from this workspace and your agent access has been revoked. Other workspace connections are unchanged."
          : STALE_CONTROL,
      );
    }
    return discordAccountMessage(STALE_CONTROL);
  },
);

const discordAccountAction$ = command(
  async (
    { set },
    interaction: AccountInteraction,
    actor: DiscordInteractionActor,
    botToken: string,
    signal: AbortSignal,
  ): Promise<DiscordAccountMessage> => {
    let control: DiscordPickerState | null = null;
    let selection: string | undefined;
    if (interaction.type === 3) {
      control = parseDiscordPickerCustomId({
        customId: interaction.data.custom_id,
        actor,
        botToken,
      });
      if (!control) {
        return discordAccountMessage(STALE_CONTROL);
      }
      if (interaction.data.component_type === 3) {
        selection = interaction.data.values[0];
      }
    }
    const commandName =
      interaction.type === 2 ? interaction.data.name : undefined;
    const action = commandName ?? control?.action;
    if (action === "help") {
      return discordAccountMessage(discordHelp());
    }
    if (action === "org" || action === "connect") {
      return set(
        discordOrgPicker$,
        { actor, botToken, page: control?.page, selection },
        signal,
      );
    }
    const current = await set(currentDiscordBinding$, actor, signal);
    if (current.kind === "selection-required") {
      if (control) {
        return discordAccountMessage(STALE_CONTROL);
      }
      return set(discordOrgPicker$, { actor, botToken }, signal);
    }
    if (current.kind !== "connected") {
      return discordConnectMessage(actor.guildId);
    }
    if (control && control.connectionId !== current.binding.connectionId) {
      return discordAccountMessage(STALE_CONTROL);
    }
    const channelFailure = await set(
      discordChannelFailure$,
      current.binding,
      actor,
      signal,
    );
    if (channelFailure) {
      return channelFailure;
    }
    return set(
      discordBoundAccountAction$,
      {
        action,
        binding: current.binding,
        actor,
      },
      signal,
    );
  },
);

const finishDiscordInteraction$ = command(
  async (
    { set },
    interaction: AccountInteraction,
    actor: DiscordInteractionActor,
    botToken: string,
    signal: AbortSignal,
  ): Promise<void> => {
    const outcome = await settle(
      set(discordAccountAction$, interaction, actor, botToken, signal),
      signal,
    );
    const message = outcome.ok
      ? outcome.value
      : discordAccountMessage(
          "The account request could not be completed. Run the command again to check your current preferences.",
        );
    const response = await discordClient.editDiscordOriginalInteractionResponse(
      {
        applicationId: interaction.application_id,
        interactionToken: interaction.token,
        ...message,
      },
      signal,
    );
    if (response.kind !== "ok") {
      throw new Error("Discord private interaction response failed");
    }
    if (!outcome.ok) {
      throw outcome.error;
    }
  },
);

function discordAcknowledgementOutcome(
  /** Null when the callback request was aborted by its local deadline. */
  result: DiscordApiResult<undefined> | null,
): "acknowledged" | "duplicate" | "uncertain" | "rejected" {
  if (!result) {
    return "uncertain";
  }
  if (result.kind === "ok") {
    return "acknowledged";
  }
  if (result.kind === "unavailable") {
    return "rejected";
  }
  if (result.code === 40_060) {
    return "duplicate";
  }
  // Timeouts, transport failures and server errors do not prove rejection.
  return result.status >= 500 ? "uncertain" : "rejected";
}

/** Components defer an update so the result replaces the picker in place. */
async function acknowledgeDiscordInteraction(
  interaction: AccountInteraction,
  signal: AbortSignal,
): Promise<ReturnType<typeof discordAcknowledgementOutcome>> {
  const acknowledgement = await settleIncludingAbort(
    discordClient.createDiscordInteractionResponse(
      {
        interactionId: interaction.id,
        interactionToken: interaction.token,
        response:
          interaction.type === 3
            ? { type: 6 }
            : { type: 5, data: { flags: 64 } },
      },
      signal,
    ),
  );
  signal.throwIfAborted();
  if (!acknowledgement.ok) {
    throw acknowledgement.error;
  }
  return discordAcknowledgementOutcome(
    acknowledgement.ok ? acknowledgement.value : null,
  );
}

/**
 * A callback that timed out or failed in transit may still reach Discord within
 * its 3-second window. Afterward the token is valid only if it did, so an edit
 * then either replaces the loading state or is harmlessly rejected.
 */
const settleUncertainDiscordInteraction$ = command(
  async (
    _,
    interaction: AccountInteraction,
    receivedAt: number,
    signal: AbortSignal,
  ): Promise<void> => {
    // Discord's window opened before this request arrived, so a local
    // monotonic deadline from receipt outlasts it regardless of clock skew.
    await delay(
      Math.max(receivedAt + DISCORD_RESPONSE_WINDOW_MS - monotonicNow(), 0),
      { signal },
    );
    await discordClient.editDiscordOriginalInteractionResponse(
      {
        applicationId: interaction.application_id,
        interactionToken: interaction.token,
        ...discordAccountMessage(UNCONFIRMED_REQUEST),
      },
      signal,
    );
  },
);

export const handleDiscordInteractions$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<Response> => {
    const receivedAt = monotonicNow();
    const request = get(request$).raw;
    const publicKey = env("DISCORD_PUBLIC_KEY");
    const applicationId = env("DISCORD_APPLICATION_ID");
    if (!publicKey || !applicationId) {
      return Response.json(
        { error: "Discord interactions are not configured" },
        { status: 503 },
      );
    }
    const signature = request.headers.get("x-signature-ed25519");
    const timestamp = request.headers.get("x-signature-timestamp");
    if (!signature || !timestamp) {
      return Response.json(
        { error: "Missing Discord signature" },
        { status: 401 },
      );
    }
    const body = new Uint8Array(await request.arrayBuffer());
    signal.throwIfAborted();
    if (body.byteLength > 65_536) {
      return Response.json(
        { error: "Interaction payload is too large" },
        { status: 400 },
      );
    }
    if (
      !verifyDiscordInteractionSignature({
        publicKey,
        signature,
        timestamp,
        body,
      })
    ) {
      return Response.json(
        { error: "Invalid or expired Discord signature" },
        { status: 401 },
      );
    }
    const decoded = safeSync(() => {
      return new TextDecoder("utf-8", { fatal: true }).decode(body);
    });
    if ("error" in decoded) {
      return Response.json(
        { error: "Invalid Discord interaction" },
        { status: 400 },
      );
    }
    const parsed = discordInteractionSchema.safeParse(
      safeJsonParse(decoded.ok),
    );
    if (!parsed.success) {
      return Response.json(
        { error: "Invalid Discord interaction" },
        { status: 400 },
      );
    }
    const interaction = parsed.data;
    if (interaction.application_id !== applicationId) {
      return Response.json(
        { error: "Incorrect Discord application" },
        { status: 401 },
      );
    }
    if (interaction.type === 1) {
      return Response.json({ type: 1 });
    }
    const actor = resolveDiscordInteractionActor(interaction);
    if (!actor) {
      return Response.json(
        { error: "Invalid Discord sender" },
        { status: 400 },
      );
    }
    const config = getDiscordAppConfig();
    if (!config) {
      return Response.json(
        { error: "Discord interactions are not configured" },
        { status: 503 },
      );
    }
    const { botToken } = config;
    // Discord accepts one callback per interaction ID. Consume it before work,
    // so concurrent delivery or a captured signed replay cannot apply changes.
    const outcome = await acknowledgeDiscordInteraction(interaction, signal);
    if (outcome === "duplicate") {
      return new Response(null, { status: 202 });
    }
    if (outcome === "uncertain") {
      // Discord may still have accepted the callback. Apply no change, and
      // replace any loading state once its 3 s response window has closed.
      waitUntil(
        set(
          settleUncertainDiscordInteraction$,
          interaction,
          receivedAt,
          signal,
        ),
      );
      return new Response(null, { status: 202 });
    }
    if (outcome === "rejected") {
      return Response.json(
        { error: "Discord could not acknowledge the interaction" },
        { status: 503 },
      );
    }
    waitUntil(
      set(finishDiscordInteraction$, interaction, actor, botToken, signal),
    );
    return new Response(null, { status: 202 });
  },
);
