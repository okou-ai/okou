import { z } from "zod";

import { initContract } from "./base";

const c = initContract();

const fixtureKindSchema = z.enum([
  "active-run",
  "failed-message",
  "old-orphan",
  "orphan",
  "orphaned-automation",
  "paginated-orphan",
  "queued-integration",
  "queued-message",
  "revoked-message",
]);

export const testCronMonitorChatEventQueueStateActionBodySchema =
  z.discriminatedUnion("action", [
    z.object({
      action: z.literal("seed-fixture"),
      fixture_kind: fixtureKindSchema,
    }),
    z.object({
      action: z.literal("delete-fixture"),
      compose_id: z.string().uuid(),
    }),
  ]);

export const testCronMonitorChatEventQueueStateActionResponseSchema = z
  .object({
    ok: z.literal(true),
    compose_id: z.string().uuid().optional(),
    event_id: z.string().uuid().optional(),
  })
  .passthrough();

export const testCronMonitorChatEventQueueStateMonitorBodySchema = z.object({
  event_ids: z.array(z.string().uuid()).min(1),
});

export const testCronMonitorChatEventQueueStateMonitorResponseSchema = z.object(
  {
    success: z.literal(true),
    orphanedMessages: z.number().int().nonnegative(),
  },
);

export const testCronMonitorChatEventQueueStateContract = c.router({
  action: {
    method: "POST",
    path: "/api/test/cron-monitor-chat-event-queue-state/action",
    body: testCronMonitorChatEventQueueStateActionBodySchema,
    responses: {
      200: testCronMonitorChatEventQueueStateActionResponseSchema,
      404: z.string(),
    },
    summary: "Mutate orphaned queued chat message monitor test state",
  },
  monitor: {
    method: "POST",
    path: "/api/test/cron-monitor-chat-event-queue-state/monitor",
    body: testCronMonitorChatEventQueueStateMonitorBodySchema,
    responses: {
      200: testCronMonitorChatEventQueueStateMonitorResponseSchema,
      404: z.string(),
      500: z.object({ error: z.string() }),
    },
    summary: "Monitor selected queued chat events in API tests",
  },
});

export type TestCronMonitorChatEventQueueStateActionBody = z.infer<
  typeof testCronMonitorChatEventQueueStateActionBodySchema
>;
export type TestCronMonitorChatEventQueueStateActionResponse = z.infer<
  typeof testCronMonitorChatEventQueueStateActionResponseSchema
>;
export type TestCronMonitorChatEventQueueStateMonitorBody = z.infer<
  typeof testCronMonitorChatEventQueueStateMonitorBodySchema
>;
export type TestCronMonitorChatEventQueueStateContract =
  typeof testCronMonitorChatEventQueueStateContract;
