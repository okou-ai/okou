import { randomUUID } from "node:crypto";

import { storagePublicationTokens } from "@okouai/db/schema/storage-publication-fence";
import { createStore } from "ccstate";
import { eq } from "drizzle-orm";

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
