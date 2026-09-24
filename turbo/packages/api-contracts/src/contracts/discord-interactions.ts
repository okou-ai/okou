import { z } from "zod";

import { initContract } from "./base";

const c = initContract();

const discordSnowflakeSchema = z
  .string()
  .regex(/^[1-9][0-9]{0,19}$/)
  .refine(
    (value) => {
      return value.length < 20 || value <= "18446744073709551615";
    },
    { message: "Invalid Discord snowflake" },
  );

const discordUserSchema = z.object({
  id: discordSnowflakeSchema,
});

const interactionBaseSchema = z.object({
  id: discordSnowflakeSchema,
  application_id: discordSnowflakeSchema,
  token: z.string().min(1).max(2048),
  version: z.literal(1),
});

const invocationBaseSchema = interactionBaseSchema.extend({
  channel_id: discordSnowflakeSchema,
  guild_id: discordSnowflakeSchema.optional(),
  member: z.object({ user: discordUserSchema }).optional(),
  user: discordUserSchema.optional(),
});

const commandInteractionSchema = invocationBaseSchema.extend({
  type: z.literal(2),
  data: z.object({
    id: discordSnowflakeSchema,
    type: z.literal(1),
    name: z.literal("okou"),
    options: z.tuple([
      z.object({
        type: z.literal(1),
        name: z.enum([
          "help",
          "connect",
          "disconnect",
          "switch",
          "model",
          "org",
        ]),
        options: z.tuple([]).optional(),
      }),
    ]),
  }),
});

const componentInteractionSchema = invocationBaseSchema.extend({
  type: z.literal(3),
  data: z.discriminatedUnion("component_type", [
    z.object({
      component_type: z.literal(2),
      custom_id: z.string().min(1).max(100),
      values: z.never().optional(),
    }),
    z.object({
      component_type: z.literal(3),
      custom_id: z.string().min(1).max(100),
      values: z.tuple([z.string().min(1).max(100)]),
    }),
  ]),
});

// No modal is issued by these commands. Unknown interaction/component types
// are rejected instead of interpreting them as a preference update.
export const discordInteractionSchema = z
  .discriminatedUnion("type", [
    interactionBaseSchema.extend({ type: z.literal(1) }),
    commandInteractionSchema,
    componentInteractionSchema,
  ])
  .superRefine((interaction, context) => {
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

export type DiscordInteraction = z.infer<typeof discordInteractionSchema>;
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
    body: c.type<string>(),
    responses: {
      200: z.object({ type: z.literal(1) }),
      202: z.null(),
      400: z.object({ error: z.string() }),
      401: z.object({ error: z.string() }),
      503: z.object({ error: z.string() }),
    },
    summary: "Handle signed Discord commands and preference interactions",
  },
});

export type DiscordInteractionsContract = typeof discordInteractionsContract;
