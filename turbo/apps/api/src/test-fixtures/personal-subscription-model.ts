import { createStore } from "ccstate";
import { modelProviders } from "@okouai/db/schema/model-provider";
import { modelProviderAccounts } from "@okouai/db/schema/model-provider-account";
import { writeDb$ } from "../signals/external/db";

/** Metadata-only fixture; runtime capture still requires real account secrets. */
export async function seedConnectedPersonalSubscriptionFixture(args: {
  orgId: string;
  userId: string;
  type: "claude-code-oauth-token" | "codex-oauth-token";
}): Promise<void> {
  const db = createStore().set(writeDb$);
  const [provider] = await db
    .insert(modelProviders)
    .values({
      orgId: args.orgId,
      userId: args.userId,
      type: args.type,
    })
    .onConflictDoUpdate({
      target: [
        modelProviders.orgId,
        modelProviders.userId,
        modelProviders.type,
      ],
      set: { updatedAt: new Date() },
    })
    .returning({ id: modelProviders.id });
  if (!provider)
    throw new Error("Expected a logical personal subscription provider");
  await db.insert(modelProviderAccounts).values({
    modelProviderId: provider.id,
    orgId: args.orgId,
    userId: args.userId,
    type: args.type,
    isActive: true,
  });
}
