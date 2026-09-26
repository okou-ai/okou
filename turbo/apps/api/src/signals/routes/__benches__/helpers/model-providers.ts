import { randomUUID } from "node:crypto";

import { command } from "ccstate";
import { modelProviders } from "@okouai/db/schema/model-provider";
import {
  modelProviderAccounts,
  modelProviderAccountSecrets,
} from "@okouai/db/schema/model-provider-account";
import { secrets } from "@okouai/db/schema/secret";

import { type Db, writeDb$ } from "../../../external/db";
import { encryptSecretForTests } from "../../__tests__/helpers/encrypt-secret";

interface SeedUserModelProviderValues {
  readonly orgId: string;
  readonly userId: string;
  readonly type: string;
  readonly isDefault?: boolean;
  readonly selectedModel?: string | null;
  readonly secretName?: string | null;
  readonly authMethod?: string | null;
}

export const seedUserModelProvider$ = command(
  async (
    { set },
    values: SeedUserModelProviderValues,
    signal: AbortSignal,
  ): Promise<{ readonly id: string }> => {
    const writeDb = set(writeDb$);

    // Personal subscriptions store credentials only on their concrete account.
    if (
      values.userId !== "__org__" &&
      (values.type === "claude-code-oauth-token" ||
        values.type === "codex-oauth-token")
    ) {
      return await seedPersonalSubscription(writeDb, values, signal);
    }

    let secretId: string | null = null;
    if (values.secretName) {
      const [secret] = await writeDb
        .insert(secrets)
        .values({
          name: values.secretName,
          encryptedValue: encryptSecretForTests("test-secret-value"),
          type: "model-provider",
          userId: values.userId,
          orgId: values.orgId,
        })
        .returning({ id: secrets.id });
      signal.throwIfAborted();
      secretId = secret?.id ?? null;
    }

    const [row] = await writeDb
      .insert(modelProviders)
      .values({
        type: values.type,
        secretId,
        authMethod: values.authMethod ?? null,
        isDefault: values.isDefault ?? false,
        selectedModel: values.selectedModel ?? null,
        userId: values.userId,
        orgId: values.orgId,
      })
      .returning({ id: modelProviders.id });
    signal.throwIfAborted();

    return { id: row?.id ?? randomUUID() };
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
      authMethod: values.authMethod ?? null,
      isDefault: values.isDefault ?? false,
      selectedModel: values.selectedModel ?? null,
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
