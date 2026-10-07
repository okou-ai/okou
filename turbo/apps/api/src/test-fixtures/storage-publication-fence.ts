import { randomUUID } from "node:crypto";

import {
  storagePublicationGenerations,
  storagePublicationTokens,
} from "@okouai/db/schema/storage-publication-fence";
import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";

import { writeDb$ } from "../signals/external/db";

const store = createStore();

export async function seedAgentPublicationFenceFixture(args: {
  readonly orgId: string;
  readonly agentId: string;
}): Promise<void> {
  await store
    .set(writeDb$)
    .insert(storagePublicationTokens)
    .values({
      orgId: args.orgId,
      agentId: args.agentId,
      subject: "@agent",
      publicationKey: `workflow:${randomUUID()}`,
      generation: 2,
      token: randomUUID(),
    });
}

export async function countAgentPublicationFencesFixture(
  agentId: string,
): Promise<number> {
  const rows = await store
    .set(writeDb$)
    .select({ token: storagePublicationTokens.token })
    .from(storagePublicationTokens)
    .where(eq(storagePublicationTokens.agentId, agentId));
  return rows.length;
}

/** Seed one user-scoped generation and token, as a private Workflow reservation would. */
export async function seedUserPublicationFenceFixture(args: {
  readonly orgId: string;
  readonly agentId: string;
  readonly userId: string;
}): Promise<void> {
  const db = store.set(writeDb$);
  await db.insert(storagePublicationGenerations).values({
    orgId: args.orgId,
    agentId: args.agentId,
    subject: args.userId,
    generation: 2,
  });
  await db.insert(storagePublicationTokens).values({
    orgId: args.orgId,
    agentId: args.agentId,
    subject: args.userId,
    publicationKey: `workflow:${randomUUID()}`,
    generation: 2,
    token: randomUUID(),
  });
}

export async function countUserPublicationFenceRowsFixture(args: {
  readonly orgId: string;
  readonly userId: string;
}): Promise<{ readonly generations: number; readonly tokens: number }> {
  const db = store.set(writeDb$);
  const generations = await db
    .select({ agentId: storagePublicationGenerations.agentId })
    .from(storagePublicationGenerations)
    .where(
      and(
        eq(storagePublicationGenerations.orgId, args.orgId),
        eq(storagePublicationGenerations.subject, args.userId),
      ),
    );
  const tokens = await db
    .select({ token: storagePublicationTokens.token })
    .from(storagePublicationTokens)
    .where(
      and(
        eq(storagePublicationTokens.orgId, args.orgId),
        eq(storagePublicationTokens.subject, args.userId),
      ),
    );
  return { generations: generations.length, tokens: tokens.length };
}
