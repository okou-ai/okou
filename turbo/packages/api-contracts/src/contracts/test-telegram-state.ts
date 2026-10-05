import { z } from "zod";

import { initContract } from "./base";

const c = initContract();

export const testTelegramStateErrorSchema = z.object({
  error: z.string(),
});

export const testTelegramStateActionBodySchema = z
  .object({
    action: z.enum([
      "seed-org-default-agent",
      "seed-official-user-link",
      "seed-agent-run-callback",
      "seed-post-fixture",
      "delete-post-fixture",
      "get-post-run-state",
      "seed-model-policies",
      "delete-fixture",
    ]),
  })
  .passthrough();

export const testTelegramStateActionResponseSchema = z
  .object({
    ok: z.literal(true),
  })
  .passthrough();

export const testTelegramStateContract = c.router({
  action: {
    method: "POST",
    path: "/api/test/telegram-state/action",
    body: testTelegramStateActionBodySchema,
    responses: {
      200: testTelegramStateActionResponseSchema,
      400: testTelegramStateErrorSchema,
      404: z.string(),
    },
    summary: "Mutate Telegram API test state",
  },
});

export type TestTelegramStateContract = typeof testTelegramStateContract;
export type TestTelegramStateActionBody = z.infer<
  typeof testTelegramStateActionBodySchema
>;
export type TestTelegramStateActionResponse = z.infer<
  typeof testTelegramStateActionResponseSchema
>;
