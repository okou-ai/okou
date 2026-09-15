import { z } from "zod";

import { initContract } from "./base";
import { triggerSourceSchema } from "./logs";
import { runnerHeartbeatGenerationSchema } from "./runner-primitives";

const c = initContract();

export const testSshConnectionStateActionBodySchema = z.discriminatedUnion(
  "action",
  [
    z
      .object({
        action: z.enum([
          "hold-connection-lock",
          "read-connection-lock",
          "release-connection-lock",
        ]),
        orgId: z.string().min(1),
        userId: z.string().min(1),
        connectionId: z.uuid(),
      })
      .strict(),
    z
      .object({
        action: z.literal("create-runtime"),
        agentId: z.uuid().optional(),
        runnerGroup: z.string().min(1).optional(),
        orgId: z.string().min(1),
        userId: z.string().min(1),
        runnerId: z.uuid().nullable(),
        heartbeatGeneration: runnerHeartbeatGenerationSchema.nullable(),
        triggerSource: triggerSourceSchema.nullable(),
        status: z.enum([
          "running",
          "pending",
          "completed",
          "cancelled",
          "failed",
        ]),
        chat: z.boolean(),
        access: z.boolean(),
      })
      .strict(),
    z
      .object({
        action: z.literal("set-agent-access"),
        orgId: z.string().min(1),
        userId: z.string().min(1),
        agentId: z.uuid(),
        enabled: z.boolean(),
      })
      .strict(),
    z
      .object({
        action: z.literal("set-learned-host-key"),
        orgId: z.string().min(1),
        userId: z.string().min(1),
        connectionId: z.uuid(),
        algorithm: z.string().min(1).max(64),
        fingerprint: z.string().min(1).max(64),
      })
      .strict(),
    z
      .object({
        action: z.literal("match-credentials"),
        orgId: z.string().min(1),
        userId: z.string().min(1),
        connectionId: z.uuid(),
        privateKey: z.string(),
        passphrase: z.string().nullable(),
      })
      .strict(),
  ],
);

export const testSshConnectionStateActionResponseSchema = z
  .object({
    ok: z.literal(true),
    generation: z.int().positive().optional(),
    privateKeyMatches: z.boolean().optional(),
    passphraseMatches: z.boolean().optional(),
    runId: z.uuid().optional(),
    agentId: z.uuid().optional(),
    sandboxToken: z.string().optional(),
    held: z.boolean().optional(),
    waiting: z.boolean().optional(),
  })
  .strict();

export const testSshConnectionStateContract = c.router({
  action: {
    method: "POST",
    path: "/api/test/ssh-connection-state/action",
    body: testSshConnectionStateActionBodySchema,
    responses: {
      200: testSshConnectionStateActionResponseSchema,
      400: z.object({ error: z.string() }),
      404: z.string(),
    },
    summary: "Mutate and inspect SSH connection state for API tests",
  },
});

export type TestSshConnectionStateActionBody = z.infer<
  typeof testSshConnectionStateActionBodySchema
>;
