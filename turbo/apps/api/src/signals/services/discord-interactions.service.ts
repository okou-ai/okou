import { command } from "ccstate";
import { assertErasureSubjectWritable } from "@okouai/db/operations/account-erasure";
import { discordOrgConnections } from "@okouai/db/schema/discord-org-connection";
import { and, eq } from "drizzle-orm";
import {
  discordInteractionSchema,
  type DiscordCommandInteraction,
  type DiscordComponentInteraction,
} from "@okouai/api-contracts/contracts/discord-interactions";
import {
  getBuiltInVisibleModels,
  isSupportedRunModel,
  type SupportedRunModel,
} from "@okouai/api-contracts/contracts/model-providers";
import { delay } from "signal-timers";

import { env } from "../../lib/env";
import { now } from "../../lib/time";
import {
  parseDiscordPickerCustomId,
  resolveDiscordInteractionActor,
  verifyDiscordInteractionSignature,
  type DiscordInteractionActor,
  type DiscordPickerState,
} from "../../lib/discord-interaction-protocol";
import {
  discordAccountLabel,
  discordAccountMessage,
  discordAccountPicker,
  type DiscordAccountMessage,
} from "../../lib/discord-interaction-messages";
import { request$ } from "../context/hono";
import { waitUntil } from "../context/wait-until";
import {
  discordClient,
  type DiscordApiResult,
} from "../external/discord-client";
import {
  discordGuildUserBinding,
  discordEffectiveAgent,
  discordDmBinding,
  discordSenderBindings,
  disconnectDiscordBinding$,
  selectDiscordDmBinding$,
  setDiscordAgentPreference$,
  type DiscordVerifiedBinding,
} from "./discord-data.service";
import {
  discordIntegrationEnabledForOwnerInDb,
  getDiscordAppConfig,
} from "./discord-config";
import type { DiscordCommandName } from "../../lib/discord-command-definition";
import { requireDiscordConversationAccess$ } from "./discord-access.service";
import { agentList } from "./agent-data.service";
import { resolveIntegrationModelRouteForUser$ } from "./integration-model-route.service";
import { listOrgModelPolicies$ } from "./model-policy.service";
import { updateUserModelPreferenceInDb } from "./user-data.service";
import { writeDb$ } from "../external/db";
import {
  safeJsonParse,
  safeSync,
  settle,
  settleIncludingAbort,
} from "../utils";

const SETUP_GUIDANCE =
  "Discord account onboarding is not available yet. An administrator must configure a verified connection before you can use Okou. This command does not connect or verify an account.";
const UNCONFIRMED_REQUEST =
  "Discord could not confirm this request in time, so no changes were made. Run the command again.";
const DISCORD_EPOCH_MS = 1_420_070_400_000;
// Discord's 3 s initial-response deadline plus a margin for clock skew.
const DISCORD_RESPONSE_WINDOW_MS = 3500;
const STALE_CONTROL =
  "This control has expired or your access has changed. Run the command again.";
const HELP = [
  "**Okou in Discord**",
  "Mention Okou in a server channel to start a conversation, or message the bot directly.",
  "`/okou connect` — connection status and setup guidance",
  "`/okou disconnect` — disconnect your account from this workspace",
  "`/okou switch` — choose your agent for new conversations",
  "`/okou model` — choose an allowed model for new conversations",
  "`/okou org` — choose the workspace for bot DMs",
  "Existing server threads keep their agent and model. Long task replies arrive from the bot.",
].join("\n");

type AccountInteraction =
  | DiscordCommandInteraction
  | DiscordComponentInteraction;

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

const discordOrgPicker$ = command(
  async (
    { get, set },
    args: {
      readonly actor: DiscordInteractionActor;
      readonly botToken: string;
      readonly page: number;
      readonly selection?: string;
    },
    signal: AbortSignal,
  ): Promise<DiscordAccountMessage> => {
    if (args.actor.guildId) {
      return discordAccountMessage(
        "In a server, Okou uses that server's workspace. Use `/okou org` in a direct message to the bot to choose your DM workspace.",
      );
    }
    const bindings = await get(discordSenderBindings(args.actor.discordUserId));
    signal.throwIfAborted();
    if (bindings.length === 0) {
      return discordAccountMessage(SETUP_GUIDANCE);
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
          ? "Workspace selected for bot DMs. Use `/okou switch` or `/okou model` to change your preferences."
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
      content:
        "Choose your workspace for bot DMs. Only your verified connections are listed.",
    });
  },
);

const discordAgentPicker$ = command(
  async (
    { get, set },
    args: {
      readonly actor: DiscordInteractionActor;
      readonly botToken: string;
      readonly binding: DiscordVerifiedBinding;
      readonly page: number;
      readonly selection?: string;
    },
    signal: AbortSignal,
  ): Promise<DiscordAccountMessage> => {
    const available = await get(
      agentList(args.binding.orgId, args.binding.userId),
    );
    signal.throwIfAborted();
    const defaultAgent = available.find((agent) => {
      return agent.isDefaultAgent;
    });
    const options = [
      ...(defaultAgent
        ? [
            {
              label: "Workspace default",
              value: "default",
            },
          ]
        : []),
      ...available
        .filter((agent) => {
          return !agent.isDefaultAgent;
        })
        .sort((left, right) => {
          return left.agentId.localeCompare(right.agentId);
        })
        .map((agent) => {
          return {
            label: discordAccountLabel(
              agent.displayName || `Agent ${agent.agentId}`,
            ),
            value: agent.agentId,
          };
        }),
    ];
    if (args.selection !== undefined) {
      const option = options.find((candidate) => {
        return candidate.value === args.selection;
      });
      if (!option) {
        return discordAccountMessage(
          "You no longer have access to that agent. Run `/okou switch` again.",
        );
      }
      const saved = await set(
        setDiscordAgentPreference$,
        {
          connectionId: args.binding.connectionId,
          discordUserId: args.actor.discordUserId,
          agentId: option.value === "default" ? null : option.value,
        },
        signal,
      );
      return discordAccountMessage(
        saved
          ? `Agent selected for new Discord conversations: ${option.label}. Existing server threads keep their agent.`
          : STALE_CONTROL,
      );
    }
    const effective = await get(discordEffectiveAgent(args.binding));
    signal.throwIfAborted();
    return discordAccountPicker({
      ...args,
      connectionId: args.binding.connectionId,
      action: "agent",
      options,
      ...(effective
        ? {
            selected:
              effective.id === defaultAgent?.agentId ? "default" : effective.id,
          }
        : {}),
      content:
        "Choose an agent for new Discord conversations. Existing server threads keep their agent.",
    });
  },
);

const saveDiscordModelPreference$ = command(
  async (
    { set },
    args: {
      readonly binding: DiscordVerifiedBinding;
      readonly model: SupportedRunModel;
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    const saved = await set(writeDb$).transaction(async (tx) => {
      await assertErasureSubjectWritable(tx, [
        { subjectKind: "user", subjectId: args.binding.userId },
        { subjectKind: "organization", subjectId: args.binding.orgId },
      ]);
      const [connection] = await tx
        .select({ id: discordOrgConnections.id })
        .from(discordOrgConnections)
        .where(
          and(
            eq(discordOrgConnections.id, args.binding.connectionId),
            eq(discordOrgConnections.discordUserId, args.binding.discordUserId),
            eq(discordOrgConnections.userId, args.binding.userId),
            eq(discordOrgConnections.guildId, args.binding.guildId),
          ),
        )
        .for("share");
      if (
        !connection ||
        !(await discordIntegrationEnabledForOwnerInDb(
          tx,
          args.binding.orgId,
          args.binding.userId,
        ))
      ) {
        return false;
      }
      await updateUserModelPreferenceInDb(
        tx,
        {
          orgId: args.binding.orgId,
          userId: args.binding.userId,
          preference: { selectedModel: args.model, serviceTier: null },
        },
        signal,
      );
      return true;
    });
    signal.throwIfAborted();
    return saved;
  },
);

const discordModelPicker$ = command(
  async (
    { set },
    args: {
      readonly actor: DiscordInteractionActor;
      readonly botToken: string;
      readonly binding: DiscordVerifiedBinding;
      readonly page: number;
      readonly selection?: string;
    },
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
      // afterward, before reading current policy and persisting a preference.
      const current = await set(currentDiscordBinding$, args.actor, signal);
      if (
        current.kind !== "connected" ||
        current.binding.connectionId !== args.binding.connectionId
      ) {
        return discordAccountMessage(STALE_CONTROL);
      }
    }
    const policies = await set(listOrgModelPolicies$, args.binding, signal);
    const visible = new Set(getBuiltInVisibleModels());
    const options = policies.policies.flatMap((policy) => {
      if (
        !isSupportedRunModel(policy.model) ||
        !visible.has(policy.model) ||
        policy.routeStatus !== "valid"
      ) {
        return [];
      }
      return [{ label: policy.modelLabel, value: policy.model }];
    });
    if (args.selection !== undefined) {
      const option = options.find((candidate) => {
        return candidate.value === args.selection;
      });
      if (!option) {
        return discordAccountMessage(
          "You no longer have access to that model. Run `/okou model` again.",
        );
      }
      const saved = await set(
        saveDiscordModelPreference$,
        { binding: args.binding, model: option.value },
        signal,
      );
      return discordAccountMessage(
        saved
          ? `Model selected for new conversations: ${option.label}. Existing server threads keep their model.`
          : STALE_CONTROL,
      );
    }
    // Preselect the model a new Discord conversation would actually run.
    const route = await set(
      resolveIntegrationModelRouteForUser$,
      args.binding,
      signal,
    );
    return discordAccountPicker({
      ...args,
      connectionId: args.binding.connectionId,
      action: "model",
      options,
      ...(route ? { selected: route.selectedModel } : {}),
      content:
        "Choose an allowed model for new conversations. This is your shared workspace model preference.",
    });
  },
);

const discordBoundAccountAction$ = command(
  async (
    { get, set },
    args: {
      readonly action:
        | DiscordCommandName
        | DiscordPickerState["action"]
        | undefined;
      readonly binding: DiscordVerifiedBinding;
      readonly actor: DiscordInteractionActor;
      readonly botToken: string;
      readonly page: number;
      readonly selection?: string;
    },
    signal: AbortSignal,
  ): Promise<DiscordAccountMessage> => {
    if (args.action === "connect") {
      const agent = await get(discordEffectiveAgent(args.binding));
      signal.throwIfAborted();
      const agentStatus = agent
        ? `Current agent: ${discordAccountLabel(agent.displayName || agent.name)}.`
        : "No accessible agent is configured. Use `/okou switch` to choose one.";
      return discordAccountMessage(
        `Your account already has a verified connection to this workspace. ${agentStatus} Mention Okou in a server channel or message the bot to start chatting.`,
      );
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
          ? "You have been disconnected from this workspace and your Discord agent access has been revoked. Other workspace connections are unchanged."
          : STALE_CONTROL,
      );
    }
    const pickerArgs = {
      actor: args.actor,
      botToken: args.botToken,
      binding: args.binding,
      page: args.page,
      selection: args.selection,
    };
    if (args.action === "switch" || args.action === "agent") {
      return set(discordAgentPicker$, pickerArgs, signal);
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
    const subcommand: DiscordCommandName | undefined =
      interaction.type === 2 ? interaction.data.options[0].name : undefined;
    const action = subcommand ?? control?.action;
    if (action === "help") {
      return discordAccountMessage(HELP);
    }
    if (action === "org") {
      return set(
        discordOrgPicker$,
        { actor, botToken, page: control?.page ?? 0, selection },
        signal,
      );
    }
    const current = await set(currentDiscordBinding$, actor, signal);
    if (current.kind === "selection-required") {
      if (control) {
        return discordAccountMessage(STALE_CONTROL);
      }
      return set(discordOrgPicker$, { actor, botToken, page: 0 }, signal);
    }
    if (current.kind !== "connected") {
      return discordAccountMessage(SETUP_GUIDANCE);
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
        page: control?.page ?? 0,
        selection,
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
  /** Null when the callback request threw or was aborted by its timeout. */
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

/**
 * A callback that timed out or failed in transit may still reach Discord within
 * its 3-second window. Afterward the token is valid only if it did, so an edit
 * then either replaces the loading state or is harmlessly rejected.
 */
const settleUncertainDiscordInteraction$ = command(
  async (
    _,
    interaction: AccountInteraction,
    signal: AbortSignal,
  ): Promise<void> => {
    const createdAt = Number(BigInt(interaction.id) >> 22n) + DISCORD_EPOCH_MS;
    await delay(
      Math.min(
        Math.max(createdAt + DISCORD_RESPONSE_WINDOW_MS - now(), 0),
        DISCORD_RESPONSE_WINDOW_MS,
      ),
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
    // Components defer an update so the result replaces the picker in place.
    const ackSignal = AbortSignal.any([signal, AbortSignal.timeout(2000)]);
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
        ackSignal,
      ),
    );
    signal.throwIfAborted();
    const outcome = discordAcknowledgementOutcome(
      acknowledgement.ok ? acknowledgement.value : null,
    );
    if (outcome === "duplicate") {
      return new Response(null, { status: 202 });
    }
    if (outcome === "uncertain") {
      // Discord may still have accepted the callback. Apply no change, and
      // replace any loading state once its 3 s response window has closed.
      waitUntil(set(settleUncertainDiscordInteraction$, interaction, signal));
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
