import { randomUUID } from "node:crypto";
import { piStableContextPublications } from "@okouai/db/schema/pi-stable-context";
import { createStore } from "ccstate";
import { eq } from "drizzle-orm";
import { writeDb$ } from "../signals/external/db";

const store = createStore();

export async function seedAgentStableContextPublicationFixture(args: {
  readonly orgId: string;
  readonly agentId: string;
}): Promise<void> {
  await store
    .set(writeDb$)
    .insert(piStableContextPublications)
    .values({
      orgId: args.orgId,
      agentId: args.agentId,
      subject: "@agent",
      publicationKey: `workflow:${randomUUID()}`,
      generation: 2,
      token: randomUUID(),
    });
}

export async function countAgentStableContextPublicationsFixture(
  agentId: string,
): Promise<number> {
  const rows = await store
    .set(writeDb$)
    .select({ token: piStableContextPublications.token })
    .from(piStableContextPublications)
    .where(eq(piStableContextPublications.agentId, agentId));
  return rows.length;
}
