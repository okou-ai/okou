import { claudeCodeDeviceAuthContract } from "../contracts/claude-code-device-auth";
import { codexDeviceAuthContract } from "../contracts/codex-device-auth";
import { personalModelProviderAccountsByIdContract } from "../contracts/personal-model-providers";
import { runModelsMainContract } from "../contracts/run-models";
import { thirdPartySubscriptionsMainContract } from "../contracts/third-party-subscriptions";
import type { ClientResponseTransform } from "./types";

// Published Android builds decode provider types strictly and offer no
// Antigravity sign-in, so they never see the staff pilot's accounts or models.
// Retire these once the enforced Android floor reads the new provider type.
const common = {
  client: "android",
  maxVersion: null,
  since: "#50802",
} as const;

function readable(type: string | null): boolean {
  return type !== "antigravity";
}

/**
 * Android lists no Antigravity account and cannot start its sign-in, so an
 * account response for it is unreachable there; fail loudly if that changes.
 */
function readableAccount<T extends { readonly type: string }>(account: T): T {
  if (!readable(account.type)) {
    throw new Error("Android cannot decode an Antigravity subscription");
  }
  return account;
}

export const androidAntigravitySubscriptionTransforms = {
  subscriptions: {
    ...common,
    method: thirdPartySubscriptionsMainContract.list.method,
    path: thirdPartySubscriptionsMainContract.list.path,
    status: 200,
    transform(body) {
      const response =
        thirdPartySubscriptionsMainContract.list.responses[200].parse(body);
      return {
        ...response,
        subscriptions: response.subscriptions.filter((subscription) => {
          return readable(subscription.type);
        }),
      };
    },
  },
  runModels: {
    ...common,
    method: runModelsMainContract.list.method,
    path: runModelsMainContract.list.path,
    status: 200,
    transform(body) {
      const response = runModelsMainContract.list.responses[200].parse(body);
      return {
        ...response,
        models: response.models.filter((model) => {
          return (
            readable(model.memberEffective.providerType) &&
            readable(model.memberEffective.runtimeProviderType)
          );
        }),
      };
    },
  },
  activate: {
    ...common,
    method: personalModelProviderAccountsByIdContract.activate.method,
    path: personalModelProviderAccountsByIdContract.activate.path,
    status: 200,
    transform(body) {
      return readableAccount(
        personalModelProviderAccountsByIdContract.activate.responses[200].parse(
          body,
        ),
      );
    },
  },
  claudeCodeComplete: {
    ...common,
    method: claudeCodeDeviceAuthContract.complete.method,
    path: claudeCodeDeviceAuthContract.complete.path,
    status: 200,
    transform(body) {
      const response =
        claudeCodeDeviceAuthContract.complete.responses[200].parse(body);
      readableAccount(response.provider);
      return response;
    },
  },
  codexComplete: {
    ...common,
    method: codexDeviceAuthContract.complete.method,
    path: codexDeviceAuthContract.complete.path,
    status: 200,
    transform(body) {
      const response =
        codexDeviceAuthContract.complete.responses[200].parse(body);
      if (response.status === "complete") {
        readableAccount(response.provider);
      }
      return response;
    },
  },
} satisfies Record<string, ClientResponseTransform>;
