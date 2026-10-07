import { command } from "ccstate";
import { modelProviders } from "@okouai/db/schema/model-provider";
import {
  modelProviderAccounts,
  modelProviderAccountSecrets,
} from "@okouai/db/schema/model-provider-account";

import { type Db, writeDb$ } from "../../../external/db";
import { encryptSecretForTests } from "../../__tests__/helpers/encrypt-secret";

interface SeedUserModelProviderValues {
  readonly orgId: string;
  readonly userId: string;
  readonly type: "claude-code-oauth-token" | "codex-oauth-token";
  readonly secretName?: string | null;
  readonly authMethod?: string | null;
}

export const seedUserModelProvider$ = command(
  async (
    { set },
    values: SeedUserModelProviderValues,
    signal: AbortSignal,
  ): Promise<{ readonly id: string }> => {
    // Personal subscriptions store credentials only on their concrete account.
    return await seedPersonalSubscription(set(writeDb$), values, signal);
  },
);

async function seedPersonalSubscription(
  writeDb: Db,
  values: SeedUserModelProviderValues,
  signal: AbortSignal,
): Promise<{ readonly id: string }> {
  const [provider] = await writeDb
    .insert(modelProviders)
    .values({
      type: values.type,
      userId: values.userId,
      orgId: values.orgId,
    })
    .returning({ id: modelProviders.id });
  signal.throwIfAborted();
  if (!provider) {
    throw new Error("Expected seeded model provider");
  }
  const [account] = await writeDb
    .insert(modelProviderAccounts)
    .values({
      modelProviderId: provider.id,
      orgId: values.orgId,
      userId: values.userId,
      type: values.type,
      authMethod: values.authMethod ?? null,
      isActive: true,
    })
    .returning({ id: modelProviderAccounts.id });
  signal.throwIfAborted();
  if (!account) {
    throw new Error("Expected seeded model provider account");
  }
  if (values.secretName) {
    await writeDb.insert(modelProviderAccountSecrets).values({
      modelProviderAccountId: account.id,
      name: values.secretName,
      encryptedValue: encryptSecretForTests("test-secret-value"),
    });
    signal.throwIfAborted();
  }
  return { id: provider.id };
}
