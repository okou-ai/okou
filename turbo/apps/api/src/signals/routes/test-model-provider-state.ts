import { command } from "ccstate";
import {
  testModelProviderStateContract,
  type TestModelProviderStateActionBody,
} from "@okouai/api-contracts/contracts/test-model-provider-state";
import { modelProviders } from "@okouai/db/schema/model-provider";
import { secrets } from "@okouai/db/schema/secret";
import { and, eq } from "drizzle-orm";

import { nowDate } from "../../lib/time";
import { request$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import { writeDb$, type Db } from "../external/db";
import type { RouteEntry } from "../route-entry";
import { encryptStoredSecretValue } from "../services/crypto.utils";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-endpoint-helpers";

const actionBody$ = bodyResultOf(testModelProviderStateContract.action);

async function overwriteModelProviderSecret(
  db: Db,
  body: Extract<
    TestModelProviderStateActionBody,
    { readonly action: "overwrite-secret" }
  >,
  signal: AbortSignal,
) {
  const [provider] = await db
    .select({ secretId: modelProviders.secretId })
    .from(modelProviders)
    .where(eq(modelProviders.id, body.provider_id))
    .limit(1);
  signal.throwIfAborted();
  if (!provider?.secretId) {
    return {
      status: 400 as const,
      body: { error: "Model provider secret not found" },
    };
  }

  const encryptedValue = await encryptStoredSecretValue(body.secret);
  signal.throwIfAborted();
  const [updated] = await db
    .update(secrets)
    .set({ encryptedValue, updatedAt: nowDate() })
    .where(
      and(
        eq(secrets.id, provider.secretId),
        eq(secrets.name, body.secret_name),
      ),
    )
    .returning({ id: secrets.id });
  signal.throwIfAborted();
  if (!updated) {
    return {
      status: 400 as const,
      body: { error: "Model provider secret not found" },
    };
  }

  return { status: 200 as const, body: { ok: true as const } };
}

async function mutateModelProviderState(
  db: Db,
  body: TestModelProviderStateActionBody,
  signal: AbortSignal,
) {
  switch (body.action) {
    case "overwrite-secret": {
      return await overwriteModelProviderSecret(db, body, signal);
    }
  }
}

const mutateModelProviderState$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!isTestEndpointAllowed(get(request$))) {
      return testEndpointNotFoundResponse();
    }

    const bodyResult = await get(actionBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    return await mutateModelProviderState(
      set(writeDb$),
      bodyResult.data,
      signal,
    );
  },
);

export const testModelProviderStateRoutes: readonly RouteEntry[] = [
  {
    route: testModelProviderStateContract.action,
    handler: mutateModelProviderState$,
  },
];
