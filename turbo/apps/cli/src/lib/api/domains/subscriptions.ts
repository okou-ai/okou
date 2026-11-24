import { initClient } from "@okouai/api-contracts/contracts/trpc-contract";
import { antigravityPersonalSubscriptionContract } from "@okouai/api-contracts/contracts/antigravity-personal-subscription";
import {
  personalModelProvidersMainContract,
  personalModelProviderAccountsByIdContract,
  personalSubscriptionsContract,
} from "@okouai/api-contracts/contracts/personal-model-providers";
import { getClientConfig, handleError } from "../core/client-factory";

export async function antigravitySubscription(
  action: "connect" | "status" | { disconnect: string },
) {
  const client = initClient(
    antigravityPersonalSubscriptionContract,
    await getClientConfig(),
  );
  const result =
    action === "connect"
      ? await client.start({ headers: {}, body: {} })
      : action === "status"
        ? await client.get({ headers: {} })
        : await client.disconnect({
            params: { bindingId: action.disconnect },
            headers: {},
          });
  if (result.status === 200) return result.body;
  handleError(result, "Could not access your Antigravity subscription");
}

export async function listSubscriptions() {
  const client = initClient(
    personalModelProvidersMainContract,
    await getClientConfig(),
  );
  const result = await client.list({ headers: {} });
  if (result.status === 200) {
    return result.body.modelProviders;
  }
  handleError(result, "Failed to list personal subscriptions");
}

export async function getSubscription(id: string) {
  const client = initClient(
    personalSubscriptionsContract,
    await getClientConfig(),
  );
  const result = await client.get({ params: { id }, headers: {} });
  if (result.status === 200) {
    return result.body;
  }
  handleError(result, "Failed to read personal subscription");
}

export async function switchSubscription(id: string) {
  const client = initClient(
    personalModelProviderAccountsByIdContract,
    await getClientConfig(),
  );
  const result = await client.activate({
    params: { id },
    body: {},
    headers: {},
  });
  if (result.status === 200) {
    return result.body;
  }
  handleError(result, "Failed to switch personal subscription");
}
