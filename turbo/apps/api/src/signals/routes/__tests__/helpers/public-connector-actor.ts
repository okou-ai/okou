import { onTestFinished, type Mock } from "vitest";
import type { TestContext } from "../../../../__tests__/test-context";
import {
  env,
  mockEnv,
  optionalEnv,
  mockOptionalEnv,
} from "../../../../lib/env";
import {
  getSecretKmsClient,
  setSecretKmsClientForTests,
} from "../../../../lib/secret-kms-client";
import { mockStripeClient } from "../../../external/stripe-client";
import { server } from "../../../../mocks/server";
import { settleIncludingAbort } from "../../../utils";
import { flushWaitUntilForTest } from "../../../context/wait-until";
import { createBddApi } from "./api-bdd";
import { createFixtureOperationOwner } from "./fixture-operation-owner";
import { deleteFeatureSwitchesForUser } from "./feature-switches";
import { captureSessionStorageMocks } from "./prepared-session-history";
import { deletePublicWorkspace } from "./public-workspace-cleanup";

function captureExternalMock<T extends (...args: never[]) => unknown>(
  mock: Mock<T>,
) {
  const implementation = mock.getMockImplementation();
  return () => {
    mock.mockReset();
    if (implementation) {
      mock.mockImplementation(implementation);
    }
  };
}

export function captureConnectorExternalState(
  context: TestContext,
  optionalEnvironmentNames: readonly string[] = [],
) {
  const names = [
    "APP_URL",
    "OKOU_API_BACKEND_URL",
    "OKOU_WEB_URL",
    "R2_USER_STORAGES_BUCKET_NAME",
    "SECRETS_KMS_KEY_ID",
    "ATOM_GRANT_PRICE",
  ] as const;
  const values = names.map((name) => {
    return [name, env(name)] as const;
  });
  const optionalValues = [
    "STRIPE_WEBHOOK_SECRET",
    "CLERK_WEBHOOK_SIGNING_SECRET",
    "OPENROUTER_API_KEY",
    "RUNNER_DEFAULT_GROUP",
    "VAPID_PUBLIC_KEY",
    "VAPID_PRIVATE_KEY",
    ...optionalEnvironmentNames,
  ].map((name) => {
    return [name, optionalEnv(name)] as const;
  });
  const priceValues = (
    ["OKOU_PRICE_PRO", "OKOU_PRICE_TEAM", "OKOU_PRICE_CONCURRENCY"] as const
  ).map((name) => {
    return [name, env(name)] as const;
  });
  const campaign = env("OKOU_ONE_TIME_CAMPAIGN");
  const dns = new Map(context.mocks.dns.lookupOverrides);
  const kms = getSecretKmsClient();
  const storage = captureSessionStorageMocks(context);
  const handlers = server.listHandlers();
  const restoreProviders = [
    captureExternalMock(context.mocks.stripe.customers.retrieve),
    captureExternalMock(context.mocks.stripe.subscriptions.retrieve),
    captureExternalMock(context.mocks.stripe.subscriptions.list),
    captureExternalMock(context.mocks.stripe.webhooks.constructEvent),
    captureExternalMock(context.mocks.axiom.ingest),
    captureExternalMock(context.mocks.axiom.query),
  ];
  const restoreIdentity = [
    context.mocks.clerk.authenticateRequest,
    context.mocks.clerk.users.getUser,
    context.mocks.clerk.users.getUserList,
    context.mocks.clerk.users.getOrganizationMembershipList,
    context.mocks.clerk.organizations.getOrganizationMembershipList,
    context.mocks.clerk.organizations.getOrganization,
    context.mocks.ably.publish,
  ].map((mock) => {
    const implementation = mock.getMockImplementation();
    return () => {
      if (implementation) {
        mock.mockImplementation(implementation);
      } else {
        mock.mockReset();
      }
    };
  });
  return () => {
    for (const [name, value] of values) {
      mockEnv(name, value);
    }
    for (const [name, value] of optionalValues) {
      mockOptionalEnv(name, value);
    }
    for (const [name, value] of priceValues) {
      mockEnv(name, value?.join(","));
    }
    mockEnv("OKOU_ONE_TIME_CAMPAIGN", JSON.stringify(campaign));
    context.mocks.dns.lookupOverrides.clear();
    for (const [name, value] of dns) {
      context.mocks.dns.lookupOverrides.set(name, value);
    }
    setSecretKmsClientForTests(kms);
    mockStripeClient(context.mocks.stripe);
    for (const restore of restoreProviders) {
      restore();
    }
    storage();
    server.resetHandlers(...handlers);
    for (const restore of restoreIdentity) {
      restore();
    }
  };
}

/** Own normal connector requests before the first definition or OAuth write. */
export function createPublicConnectorActor(
  context: TestContext,
  options: {
    readonly optionalEnvironmentNames?: readonly string[];
    readonly beforeWorkspaceCleanup?: () => Promise<void>;
  } = {},
) {
  const actor = createBddApi(context).user({ orgRole: "org:admin" });
  if (!actor.orgId) {
    throw new Error("Expected a connector workspace owner");
  }
  const orgId = actor.orgId;
  let accepted = captureConnectorExternalState(
    context,
    options.optionalEnvironmentNames,
  );
  let previous: (() => void) | undefined;
  let ownsFeatures = false;
  onTestFinished(() => {
    previous?.();
  });
  const owner = createFixtureOperationOwner(
    async () => {
      const drained = await settleIncludingAbort(flushWaitUntilForTest);
      const features = await settleIncludingAbort(() => {
        return ownsFeatures
          ? deleteFeatureSwitchesForUser(context, { ...actor, orgId })
          : Promise.resolve();
      });
      const resources = await settleIncludingAbort(() => {
        return options.beforeWorkspaceCleanup?.() ?? Promise.resolve();
      });
      const workspace = await settleIncludingAbort(() => {
        return deletePublicWorkspace(context, actor);
      });
      const errors = [drained, features, resources, workspace].flatMap(
        (result) => {
          return result.ok ? [] : [result.error];
        },
      );
      if (errors.length === 1) {
        throw errors[0];
      }
      if (errors.length > 1) {
        throw new AggregateError(errors, "Connector cleanup failed");
      }
    },
    {
      beforeDrain: () => {
        previous ??= captureConnectorExternalState(
          context,
          options.optionalEnvironmentNames,
        );
        accepted();
      },
    },
  );
  return {
    actor,
    run<T>(operation: () => Promise<T>) {
      accepted = captureConnectorExternalState(
        context,
        options.optionalEnvironmentNames,
      );
      return owner.run(operation);
    },
    ownsFeatureSwitches() {
      ownsFeatures = true;
    },
  };
}
