import { command } from "ccstate";
import { discordAccountMessage } from "../../lib/discord-interaction-messages";
import type { DiscordComponentInteraction } from "@okouai/api-contracts/contracts/discord-interactions";
import type { DiscordInteractionActor } from "../../lib/discord-interaction-protocol";
import type { DiscordActionRow } from "../external/discord-client";
import { integrationModelRecoveryIdentity$ } from "./integration-model-recovery-access.service";
import {
  loadIntegrationModelChoices$,
  MODEL_RECOVERY_STALE,
  saveIntegrationModelChoice$,
} from "./integration-model-recovery.service";
import { requireDiscordConversationAccess$ } from "./discord-access.service";

export const handleDiscordModelRecovery$ = command(
  async (
    { set },
    interaction: DiscordComponentInteraction,
    actor: DiscordInteractionActor,
    signal: AbortSignal,
  ) => {
    const [action, eventId, pageText] = interaction.data.custom_id.split(":");
    const identity = eventId
      ? await set(
          integrationModelRecoveryIdentity$,
          {
            channel: "discord",
            eventId,
            platformUserId: actor.discordUserId,
            conversationId: actor.channelId,
          },
          signal,
        )
      : null;
    if (!identity) {
      return discordAccountMessage(MODEL_RECOVERY_STALE);
    }
    const access = await set(
      requireDiscordConversationAccess$,
      {
        ...identity,
        channelId: actor.channelId,
        mode: "view",
        ...(actor.guildId ? { guildId: actor.guildId } : {}),
      },
      signal,
    );
    if (access.kind === "denied") {
      return discordAccountMessage(MODEL_RECOVERY_STALE);
    }
    const recovery = await set(loadIntegrationModelChoices$, identity, signal);
    if (!recovery) {
      return discordAccountMessage(MODEL_RECOVERY_STALE);
    }
    if (action === "ms" && interaction.data.component_type === 3) {
      return discordAccountMessage(
        await set(
          saveIntegrationModelChoice$,
          {
            ...identity,
            model: interaction.data.values[0],
            expectedModelState: recovery,
          },
          signal,
        ),
      );
    }
    const requestedPage = Number(pageText ?? "0");
    const page =
      Number.isSafeInteger(requestedPage) && requestedPage >= 0
        ? requestedPage
        : 0;
    const choices = recovery.choices.slice(page * 25, (page + 1) * 25);
    if (choices.length === 0) {
      return discordAccountMessage(MODEL_RECOVERY_STALE);
    }
    const components: DiscordActionRow[] = [
      {
        type: 1,
        components: [
          {
            type: 3,
            custom_id: `ms:${identity.eventId}`,
            placeholder: "Select a model",
            min_values: 1,
            max_values: 1,
            options: choices.map((choice) => {
              return {
                label: choice.label.slice(0, 100),
                value: choice.value,
                description: choice.description,
                ...(choice.value === recovery.selectedModel
                  ? { default: true }
                  : {}),
              };
            }),
          },
        ],
      },
    ];
    components.push({
      type: 1,
      components: [
        ...(page > 0
          ? [
              {
                type: 2 as const,
                style: 2 as const,
                label: "Previous",
                custom_id: `mr:${identity.eventId}:${page - 1}`,
              },
            ]
          : []),
        ...((page + 1) * 25 < recovery.choices.length
          ? [
              {
                type: 2 as const,
                style: 2 as const,
                label: "Next",
                custom_id: `mr:${identity.eventId}:${page + 1}`,
              },
            ]
          : []),
        { type: 2, style: 5, label: "Open conversation", url: recovery.url },
      ],
    });
    return {
      ...discordAccountMessage(
        `Current model: ${recovery.currentModelLabel}. Select a model for this conversation, then send your previous request again.`,
      ),
      components,
    };
  },
);
