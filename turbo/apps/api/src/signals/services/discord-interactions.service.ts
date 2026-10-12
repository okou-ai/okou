import {
  discordInteractionSchema,
  type DiscordCommandInteraction,
  type DiscordComponentInteraction,
} from "@okouai/api-contracts/contracts/discord-interactions";
import { discordOrgConnections } from "@okouai/db/schema/discord-org-connection";
import { discordChatThreadRoutes } from "@okouai/db/schema/discord-chat-thread-route";
import { command } from "ccstate";
import { and, eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import { delay } from "signal-timers";

import type { DiscordCommandName } from "../../lib/discord-command-definition";
import { INTEGRATION_DM_SESSION_KEY } from "../../lib/integration-dm-session";
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
import { writeDb$ } from "../external/db";
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
import {
  discordIntegrationEnabledForOwner$,
  getDiscordAppConfig,
} from "./discord-config";
import {
  disconnectDiscordBinding$,
  discordDmBinding,
  discordEffectiveAgent,
  discordGuildUserBinding,
  discordSenderBindings,
  selectDiscordDmBinding$,
  type DiscordVerifiedBinding,
} from "./discord-data.service";
import {
  integrationModelOptionValue,
  readIntegrationChatThreadModel$,
  updateIntegrationChatThreadModel$,
} from "./integration-chat-thread-model.service";
import { listAvailableRunModels$ } from "./run-models.service";

function discordSetupGuidance(): string {
  const worksUrl = new URL("/works", env("APP_URL")).toString();
  return `Please connect your account to use Okou in this workspace.\n\nOpen [Works](${worksUrl}), sign in to Okou, and follow the steps to connect your Discord account. If Okou hasn't been set up for this workspace, ask a workspace admin to install it in your Discord server.`;
}
const UNCONFIRMED_REQUEST =
  "Discord could not confirm this request in time, so no changes were made. Run the command again.";
// Discord's 3 s initial-response deadline plus a margin for in-flight delivery.
const DISCORD_RESPONSE_WINDOW_MS = 3500;
const STALE_CONTROL =
  "This control has expired or your access has changed. Run the command again.";
const NO_MODEL_CONVERSATION =
  "Start or enter an existing Okou conversation before using `/model`.";
function discordHelp(): string {
  return [
    "**Discord Bot Help**",
    "",
    "**Commands**",
    "• `/connect` - Connect to Okou",
    "• `/model` - Choose your model",
    "• `/disconnect` - Disconnect from Okou",
    "• `/switch` - View your workspace agent",
    "",
    "**Usage**",
    "• Send a DM to this bot or mention it in a channel to message your agent",
    "• Use `/connect` in a DM to choose your workspace",
    "• Use `/model` in an existing conversation to change its model",
  ].join("\n");
}

type AccountInteraction =
  DiscordCommandInteraction | DiscordComponentInteraction;

const currentDiscordBinding$ = command(
  async ({ get }, actor: DiscordInteractionActor, signal: AbortSignal) => {
    if (actor.guildId) {
      const binding = await get(
        discordGuildUserBinding({
          guildId: actor.guildId,
          discordUserId: actor.discordUserId,
        }),
      );
      signal.throwIfAborted();
      return binding
        ? { kind: "connected" as const, binding }
        : { kind: "not-connected" as const };
    }
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
    { get },
    binding: DiscordVerifiedBinding,
    signal: AbortSignal,
  ): Promise<DiscordAccountMessage> => {
    const agent = await get(discordEffectiveAgent(binding));
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
    if (args.actor.guildId) {
      return discordAccountMessage(
        "In a server, Okou uses that server's workspace. Use `/connect` in a direct message to the bot to choose your DM workspace.",
      );
    }
    const bindings = await get(discordSenderBindings(args.actor.discordUserId));
    signal.throwIfAborted();
    if (bindings.length === 0) {
      return discordAccountMessage(discordSetupGuidance());
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
          ? "✅ Workspace selected for bot DMs. Use `/model` in an existing conversation to change its model."
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
          label: binding.guildName ?? `Server ${binding.guildId}`,
          description: `Workspace ${binding.orgId}`,
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
      content: "Choose your workspace for bot DMs.",
      placeholder: "Select a workspace",
    });
  },
);

const discordAgentStatus$ = command(
  async (
    { get },
    binding: DiscordVerifiedBinding,
    signal: AbortSignal,
  ): Promise<DiscordAccountMessage> => {
    const effective = await get(discordEffectiveAgent(binding));
    signal.throwIfAborted();
    return discordAccountMessage(
      effective
        ? `**Workspace Agent**\n${discordAccountLabel(effective.displayName || effective.name)}\n\nDiscord uses your workspace's default agent. Change it in Okou.`
        : "No workspace agent available. Ask a workspace admin to set one in Okou.",
    );
  },
);

const discordModelSelectionAllowed$ = command(
  async (
    { set },
    binding: DiscordVerifiedBinding,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const enabled = await set(
      discordIntegrationEnabledForOwner$,
      binding.orgId,
      binding.userId,
      signal,
    );
    if (!enabled) {
      return false;
    }
    const [connection] = await set(writeDb$)
      .select({ id: discordOrgConnections.id })
      .from(discordOrgConnections)
      .where(
        and(
          eq(discordOrgConnections.id, binding.connectionId),
          eq(discordOrgConnections.discordUserId, binding.discordUserId),
          eq(discordOrgConnections.userId, binding.userId),
          eq(discordOrgConnections.guildId, binding.guildId),
        ),
      );
    signal.throwIfAborted();
    return connection !== undefined;
  },
);

function discordModelThreadTag(chatThreadId: string): string {
  return createHash("sha256")
    .update(chatThreadId)
    .digest("base64url")
    .slice(0, 11);
}

interface DiscordModelPickerArgs {
  readonly actor: DiscordInteractionActor;
  readonly botToken: string;
  readonly binding: DiscordVerifiedBinding;
  readonly page?: number;
  readonly selection?: string;
  readonly modelThreadTag?: string;
}

interface DiscordConversationModelOption {
  readonly label: string;
  readonly value: string;
  readonly model: string | null;
}

const selectDiscordConversationModel$ = command(
  async (
    { set },
    args: DiscordModelPickerArgs,
    options: readonly DiscordConversationModelOption[],
    chatThreadId: string,
    signal: AbortSignal,
  ): Promise<DiscordAccountMessage> => {
    const option = options.find((candidate) => {
      return candidate.value === args.selection;
    });
    if (!option) {
      return discordAccountMessage(
        "You no longer have access to that model. Run `/model` again.",
      );
    }
    // Revalidate after the run model lookup before writing to the original route.
    const db = set(writeDb$);
    const routeArgs = {
      connectionId: args.binding.connectionId,
      userId: args.binding.userId,
      channelId: args.actor.channelId,
      isDm: args.actor.guildId === null,
    };
    const currentThreadId = (
      await db
        .select({ chatThreadId: discordChatThreadRoutes.chatThreadId })
        .from(discordChatThreadRoutes)
        .where(
          and(
            eq(discordChatThreadRoutes.connectionId, routeArgs.connectionId),
            eq(discordChatThreadRoutes.userId, routeArgs.userId),
            eq(
              discordChatThreadRoutes.sessionKey,
              routeArgs.isDm ? INTEGRATION_DM_SESSION_KEY : routeArgs.channelId,
            ),
            eq(
              discordChatThreadRoutes.destinationChannelId,
              routeArgs.channelId,
            ),
          ),
        )
        .limit(1)
    )[0]?.chatThreadId;
    signal.throwIfAborted();
    if (currentThreadId !== chatThreadId) {
      return discordAccountMessage(STALE_CONTROL);
    }
    const allowed = await set(
      discordModelSelectionAllowed$,
      args.binding,
      signal,
    );
    signal.throwIfAborted();
    if (!allowed) {
      return discordAccountMessage(STALE_CONTROL);
    }
    const threadModel = await set(
      updateIntegrationChatThreadModel$,
      {
        orgId: args.binding.orgId,
        userId: args.binding.userId,
        chatThreadId,
        model: option.model,
      },
      signal,
    );
    return discordAccountMessage(
      threadModel.kind === "updated"
        ? `✅ Model selected for this conversation: ${option.label}.`
        : threadModel.kind === "no_thread"
          ? STALE_CONTROL
          : "You no longer have access to that model. Run `/model` again.",
    );
  },
);

const discordModelPicker$ = command(
  async (
    { set },
    args: DiscordModelPickerArgs,
    signal: AbortSignal,
  ): Promise<DiscordAccountMessage> => {
    if (args.selection !== undefined) {
      const channelFailure = await set(
        discordChannelFailure$,
        args.binding,
        args.actor,
        signal,
      );
      if (channelFailure) {
        return channelFailure;
      }
      // Provider permission checks can wait on HTTP. Re-read local authority
      // afterward, before reading current run models and persisting a preference.
      const current = await set(currentDiscordBinding$, args.actor, signal);
      if (
        current.kind !== "connected" ||
        current.binding.connectionId !== args.binding.connectionId
      ) {
        return discordAccountMessage(STALE_CONTROL);
      }
    }
    const db = set(writeDb$);
    const routeArgs = {
      connectionId: args.binding.connectionId,
      userId: args.binding.userId,
      channelId: args.actor.channelId,
      isDm: args.actor.guildId === null,
    };
    const chatThreadId = (
      await db
        .select({ chatThreadId: discordChatThreadRoutes.chatThreadId })
        .from(discordChatThreadRoutes)
        .where(
          and(
            eq(discordChatThreadRoutes.connectionId, routeArgs.connectionId),
            eq(discordChatThreadRoutes.userId, routeArgs.userId),
            eq(
              discordChatThreadRoutes.sessionKey,
              routeArgs.isDm ? INTEGRATION_DM_SESSION_KEY : routeArgs.channelId,
            ),
            eq(
              discordChatThreadRoutes.destinationChannelId,
              routeArgs.channelId,
            ),
          ),
        )
        .limit(1)
    )[0]?.chatThreadId;
    signal.throwIfAborted();
    const currentModel = await set(
      readIntegrationChatThreadModel$,
      {
        orgId: args.binding.orgId,
        userId: args.binding.userId,
        chatThreadId,
      },
      signal,
    );
    signal.throwIfAborted();
    if (!chatThreadId || currentModel.kind === "no_thread") {
      return discordAccountMessage(NO_MODEL_CONVERSATION);
    }
    if (
      args.page !== undefined &&
      args.modelThreadTag !== discordModelThreadTag(chatThreadId)
    ) {
      return discordAccountMessage(STALE_CONTROL);
    }
    const runModels = await set(listAvailableRunModels$, args.binding, signal);
    signal.throwIfAborted();
    const options = runModels.models.map((runModel) => {
      return {
        label: runModel.modelLabel,
        value: integrationModelOptionValue(runModel.model),
        model: runModel.model,
      };
    });
    if (args.selection !== undefined) {
      return set(
        selectDiscordConversationModel$,
        args,
        options,
        chatThreadId,
        signal,
      );
    }
    return discordAccountPicker({
      ...args,
      connectionId: args.binding.connectionId,
      modelThreadTag: discordModelThreadTag(chatThreadId),
      action: "model",
      options,
      selected: integrationModelOptionValue(currentModel.selectedModel),
      content:
        "**Switch Model**\nChoose your model. This only affects this conversation.",
      placeholder: "Select a model",
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
      readonly botToken: string;
      readonly page?: number;
      readonly selection?: string;
      readonly modelThreadTag?: string;
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
    const pickerArgs = {
      actor: args.actor,
      botToken: args.botToken,
      binding: args.binding,
      page: args.page,
      selection: args.selection,
      modelThreadTag: args.modelThreadTag,
    };
    if (args.action === "switch" || args.action === "agent") {
      return set(discordAgentStatus$, args.binding, signal);
    }
    if (args.action === "model") {
      return set(discordModelPicker$, pickerArgs, signal);
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
    const commandName: DiscordCommandName | undefined =
      interaction.type === 2 ? interaction.data.name : undefined;
    const action = commandName ?? control?.action;
    if (action === "help") {
      return discordAccountMessage(discordHelp());
    }
    if (action === "org" || (action === "connect" && !actor.guildId)) {
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
      return discordAccountMessage(discordSetupGuidance());
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
        botToken,
        page: control?.page,
        selection,
        modelThreadTag: control?.modelThreadTag,
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
  const deadline = AbortSignal.timeout(2000);
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
      AbortSignal.any([signal, deadline]),
    ),
  );
  signal.throwIfAborted();
  if (!acknowledgement.ok && !deadline.aborted) {
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
