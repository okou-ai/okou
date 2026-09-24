import type { editDiscordOriginalInteractionResponse } from "../signals/external/discord-client";
import {
  createDiscordPickerCustomId,
  type DiscordInteractionActor,
  type DiscordPickerAction,
} from "./discord-interaction-protocol";

export type DiscordAccountMessage = Pick<
  Parameters<typeof editDiscordOriginalInteractionResponse>[0],
  "content" | "components"
>;

export function discordAccountMessage(content: string): DiscordAccountMessage {
  return { content, components: [] };
}

export interface DiscordPickerOption {
  readonly label: string;
  readonly value: string;
  readonly description?: string;
}

function label(value: string): string {
  return [...value].slice(0, 100).join("");
}

export function discordAccountPicker(args: {
  readonly content: string;
  readonly action: DiscordPickerAction;
  readonly actor: DiscordInteractionActor;
  readonly connectionId: string;
  readonly botToken: string;
  readonly page: number;
  readonly options: readonly DiscordPickerOption[];
}): DiscordAccountMessage {
  const pageCount = Math.ceil(args.options.length / 25);
  if (args.options.length === 0) {
    return discordAccountMessage(
      "No available choices. Ask your workspace admin to check your access.",
    );
  }
  if (args.page >= pageCount) {
    return discordAccountMessage(
      "This list has changed. Run the command again to see the available choices.",
    );
  }
  const customId = (page: number) => {
    return createDiscordPickerCustomId({ ...args, page });
  };
  const buttons = [
    ...(args.page > 0
      ? [
          {
            type: 2 as const,
            style: 2 as const,
            label: "Previous",
            custom_id: customId(args.page - 1),
          },
        ]
      : []),
    ...(args.page + 1 < pageCount
      ? [
          {
            type: 2 as const,
            style: 2 as const,
            label: "Next",
            custom_id: customId(args.page + 1),
          },
        ]
      : []),
  ];
  return {
    content: `${args.content}\nPage ${args.page + 1} of ${pageCount}.`,
    components: [
      {
        type: 1,
        components: [
          {
            type: 3,
            custom_id: customId(args.page),
            placeholder: "Choose an option",
            min_values: 1,
            max_values: 1,
            options: args.options
              .slice(args.page * 25, (args.page + 1) * 25)
              .map((option) => {
                return {
                  label: label(option.label),
                  value: option.value,
                  ...(option.description
                    ? { description: label(option.description) }
                    : {}),
                };
              }),
          },
        ],
      },
      ...(buttons.length > 0
        ? [{ type: 1 as const, components: buttons }]
        : []),
    ],
  };
}
