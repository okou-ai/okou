import {
  discriminatedUnion,
  literal,
  object,
  string,
  tuple,
  enum as zEnum,
  never as zNever,
  type infer as zInfer,
} from "zod";

import { initContract } from "./base";

const c = initContract();

const discordSnowflakeSchema = string()
  .regex(/^[1-9][0-9]{0,19}$/)
  .refine(
    (value) => {
      return value.length < 20 || value <= "18446744073709551615";
    },
    { message: "Invalid Discord snowflake" },
  );

const discordUserSchema = object({
  id: discordSnowflakeSchema,
});

const interactionBaseSchema = object({
  id: discordSnowflakeSchema,
  application_id: discordSnowflakeSchema,
  token: string().min(1).max(2048),
  version: literal(1),
});

const invocationBaseSchema = interactionBaseSchema.extend({
  channel_id: discordSnowflakeSchema,
  guild_id: discordSnowflakeSchema.optional(),
  member: object({ user: discordUserSchema }).optional(),
  user: discordUserSchema.optional(),
});

const commandInteractionSchema = invocationBaseSchema.extend({
  type: literal(2),
  data: object({
    id: discordSnowflakeSchema,
    type: literal(1),
    name: zEnum(["help", "connect", "disconnect"]),
    options: tuple([]).optional(),
  }),
});

const componentInteractionSchema = invocationBaseSchema.extend({
  type: literal(3),
  data: discriminatedUnion("component_type", [
    object({
      component_type: literal(2),
      custom_id: string().min(1).max(100),
      values: zNever().optional(),
    }),
    object({
      component_type: literal(3),
      custom_id: string().min(1).max(100),
      values: tuple([string().min(1).max(100)]),
    }),
  ]),
});

// No modal is issued by these commands. Unknown interaction/component types
// are rejected instead of interpreting them as a preference update.
export const discordInteractionSchema = discriminatedUnion("type", [
  interactionBaseSchema.extend({ type: literal(1) }),
  commandInteractionSchema,
  componentInteractionSchema,
]).superRefine((interaction, context) => {
  if (interaction.type === 1) {
    return;
  }

  const validActor =
    interaction.guild_id === undefined
      ? interaction.user !== undefined && interaction.member === undefined
      : interaction.member !== undefined && interaction.user === undefined;

  if (!validActor) {
    context.addIssue({
      code: "custom",
      message: "Expected a guild member or a direct-message user",
    });
  }
});

export type DiscordInteraction = zInfer<typeof discordInteractionSchema>;
export type DiscordCommandInteraction = Extract<
  DiscordInteraction,
  { type: 2 }
>;
export type DiscordComponentInteraction = Extract<
  DiscordInteraction,
  { type: 3 }
>;

export const discordInteractionsContract = c.router({
  post: {
    method: "POST",
    path: "/api/discord/interactions",
    headers: object({
      "content-type": string().optional(),
      "x-signature-ed25519": string().optional(),
      "x-signature-timestamp": string().optional(),
    }),
    body: c.type<string>(),
    responses: {
      200: object({ type: literal(1) }),
      202: c.noBody(),
      400: object({ error: string() }),
      401: object({ error: string() }),
      503: object({ error: string() }),
    },
    summary: "Handle signed Discord commands and preference interactions",
  },
});

export type DiscordInteractionsContract = typeof discordInteractionsContract;
