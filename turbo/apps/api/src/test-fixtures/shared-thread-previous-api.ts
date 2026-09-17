import { sharedThreadsContract } from "@okouai/api-contracts/contracts/shared-threads";
import { publicBrandSchema } from "@okouai/api-contracts/contracts/public-brand";
import { sharedThreads } from "@okouai/db/schema/shared-thread";
import { command } from "ccstate";
import { eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { notFound } from "../lib/error";
import { pathParamsOf } from "../signals/context/request";
import { db$, writeDb$ } from "../signals/external/db";
import type { RouteEntry } from "../signals/route-entry";

/**
 * Previous API read contract from db6c1bd8bed0dbc7dac39ad2ff8ad6565d0d2aa1.
 * A current production endpoint cannot select the previous server version.
 * Retain its real column selection and strict response shape here to exercise
 * rolling deployment against shares created through the current public API.
 */
const previousReadContract = Object.freeze({
  ...sharedThreadsContract.get,
  responses: {
    ...sharedThreadsContract.get.responses,
    200: z.object({
      id: z.string().uuid(),
      title: z.string(),
      publicBrand: publicBrandSchema,
      messages: z.array(
        z
          .object({
            messageIndex: z.number().int().nonnegative(),
            role: z.enum(["user", "assistant"]),
            content: z.string(),
            runIndex: z.number().int().nonnegative().optional(),
            runGroupIndex: z.number().int().nonnegative().optional(),
          })
          .strict(),
      ),
    }),
  },
});

const previousRead$ = command(async ({ get }, signal: AbortSignal) => {
  const { id } = get(pathParamsOf(sharedThreadsContract.get));
  const [row] = await get(db$)
    .select({
      id: sharedThreads.id,
      title: sharedThreads.title,
      messages: sharedThreads.messages,
      publicBrand: sharedThreads.publicBrand,
    })
    .from(sharedThreads)
    .where(eq(sharedThreads.id, id))
    .limit(1);
  signal.throwIfAborted();
  return row
    ? { status: 200 as const, body: row }
    : notFound("Shared conversation not found");
});

export const previousSharedThreadReadRoutes: readonly RouteEntry[] = [
  { route: previousReadContract, handler: previousRead$ },
];

/**
 * Freeze the previous writer's INSERT columns. The current create endpoint
 * cannot issue an old-version write, and the current Drizzle schema would
 * include new defaulted columns even if values omitted them.
 */
export const createPreviousSharedThread$ = command(
  async (
    { set },
    input: {
      readonly userId: string;
      readonly threadId: string;
      readonly content: string;
    },
    signal: AbortSignal,
  ) => {
    const id = randomUUID();
    const messages = JSON.stringify([
      { messageIndex: 0, role: "user", content: input.content },
    ]);
    await set(writeDb$).execute(sql`
      INSERT INTO shared_threads
        (id, user_id, source_chat_thread_id, title, messages, public_brand)
      VALUES
        (${id}, ${input.userId}, ${input.threadId}, 'Previous API share',
         ${messages}::jsonb, 'vm0')
    `);
    signal.throwIfAborted();
    return id;
  },
);
