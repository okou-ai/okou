import { captureConnectorExternalState } from "./public-connector-actor";
import { settleIncludingAbort } from "../../../utils";
import { createHash, createHmac } from "node:crypto";
import { onTestFinished } from "vitest";
import {
  integrationsTelegramContract,
  OFFICIAL_TELEGRAM_BOT_ID,
} from "@okouai/api-contracts/contracts/integrations-telegram";
import { accept, type TestContext } from "../../../../__tests__/test-context";
import { setupApp } from "../../../../__tests__/test-helpers";
import { env, mockEnv } from "../../../../lib/env";
import { now } from "../../../../lib/time";
import { server } from "../../../../mocks/server";
import { integrationsTelegramRoutes } from "../../integrations-telegram";
import { createBddApi, type ApiTestUserOptions } from "./api-bdd";
import { publicRunOwner } from "./public-run-owner";
import { deletePublicWorkspace } from "./public-workspace-cleanup";
import { deleteFeatureSwitchesForUser } from "./feature-switches";
import { createRouteMocks } from "./route-test";

/** Own normal onboarding, Telegram linking and cleanup while the user exists. */
export function createPublicTelegramActor(
  context: TestContext,
  options: ApiTestUserOptions = {},
  lifecycle: { readonly restoreEnvironment?: () => void } = {},
) {
  const bdd = createBddApi(context);
  const actor = bdd.user(options);
  if (!actor.orgId) {
    throw new Error("Telegram tests require an owned workspace");
  }
  const orgId = actor.orgId;
  const names = [
    "TELEGRAM_OFFICIAL_BOT_TOKEN",
    "TELEGRAM_OFFICIAL_BOT_USERNAME",
    "TELEGRAM_OFFICIAL_WEBHOOK_SECRET",
    "OKOU_WEB_URL",
    "R2_USER_STORAGES_BUCKET_NAME",
    "SECRETS_KMS_KEY_ID",
  ] as const;
  function captureExternalState() {
    const restoreCommon = captureConnectorExternalState(context);
    const values = names.map((name) => {
      return [name, env(name)] as const;
    });
    const handlers = server.listHandlers();
    const restoreIdentity = [
      context.mocks.clerk.authenticateRequest,
      context.mocks.clerk.users.getOrganizationMembershipList,
      context.mocks.clerk.organizations.getOrganizationMembershipList,
      context.mocks.clerk.organizations.getOrganization,
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
    const send = context.mocks.s3.send.getMockImplementation();
    const sign = context.mocks.s3.getSignedUrl.getMockImplementation();
    return () => {
      restoreCommon();
      for (const [name, value] of values) {
        mockEnv(name, value);
      }
      server.resetHandlers(...handlers);
      for (const restore of restoreIdentity) {
        restore();
      }
      if (send) {
        context.mocks.s3.send.mockImplementation(send);
      }
      if (sign) {
        context.mocks.s3.getSignedUrl.mockImplementation(sign);
      }
    };
  }
  let cleanupFeatures = false;
  let acceptedState = captureExternalState();
  let previousState: (() => void) | undefined;
  onTestFinished(() => {
    previousState?.();
  });
  const owner = publicRunOwner(context, actor, {
    restoreEnvironment: () => {
      previousState ??= captureExternalState();
      acceptedState();
      lifecycle.restoreEnvironment?.();
    },
    afterRuns: async () => {
      const link = await settleIncludingAbort(async () => {
        session();
        const client = setupApp({
          context,
          routes: integrationsTelegramRoutes,
        })(integrationsTelegramContract);
        const status = await accept(
          client.getLinkStatus({
            headers: { authorization: "Bearer clerk-session" },
            query: { botId: OFFICIAL_TELEGRAM_BOT_ID },
          }),
          [200],
        );
        if (status.body.linked) {
          await accept(
            client.unlink({
              headers: { authorization: "Bearer clerk-session" },
              query: { botId: OFFICIAL_TELEGRAM_BOT_ID },
            }),
            [204],
          );
        }
      });
      const features = await settleIncludingAbort(async () => {
        if (cleanupFeatures) {
          await deleteFeatureSwitchesForUser(context, {
            userId: actor.userId,
            orgId,
          });
        }
      });
      const workspace = await settleIncludingAbort(() => {
        return deletePublicWorkspace(context, actor);
      });
      const errors = [link, features, workspace].flatMap((result) => {
        return result.ok ? [] : [result.error];
      });
      if (errors.length === 1) {
        throw errors[0];
      }
      if (errors.length > 1) {
        throw new AggregateError(errors, "Telegram cleanup failed");
      }
    },
  });
  function session() {
    createRouteMocks(context).clerk.session(
      actor.userId,
      actor.orgId,
      actor.orgRole,
    );
  }
  function run<T>(operation: () => Promise<T>): Promise<T> {
    return owner.run(() => {
      const pending = settleIncludingAbort(operation);
      acceptedState = captureExternalState();
      return pending.then((result) => {
        if (!result.ok) {
          throw result.error;
        }
        return result.value;
      });
    });
  }
  session();
  return {
    actor,
    orgId: actor.orgId,
    userId: actor.userId,
    token: "clerk-session",
    run,
    session,
    rememberClaim: owner.rememberClaim,
    ownsFeatureSwitches() {
      cleanupFeatures = true;
    },
    onboard: () => {
      bdd.acceptAgentStorageWrites();
      return run(async () => {
        await bdd.readOnboardingStatus(actor);
        const completed = await bdd.completeOnboarding(actor);
        if (completed.status !== 200) {
          throw new Error("Expected normal onboarding to complete");
        }
      });
    },
    link: (telegramUserId: string) => {
      return run(async () => {
        session();
        const fields = {
          id: Number(telegramUserId),
          first_name: "Test",
          auth_date: Math.floor(now() / 1000),
        };
        const checked = Object.entries(fields)
          .sort(([a], [b]) => {
            return a.localeCompare(b);
          })
          .map(([key, value]) => {
            return `${key}=${value}`;
          })
          .join("\n");
        const botToken = env("TELEGRAM_OFFICIAL_BOT_TOKEN");
        if (!botToken) {
          throw new Error("Expected the external Telegram bot credential");
        }
        const key = createHash("sha256").update(botToken).digest();
        const hash = createHmac("sha256", key).update(checked).digest("hex");
        await accept(
          setupApp({ context, routes: integrationsTelegramRoutes })(
            integrationsTelegramContract,
          ).link({
            headers: { authorization: "Bearer clerk-session" },
            body: {
              telegramBotId: OFFICIAL_TELEGRAM_BOT_ID,
              telegramAuth: { ...fields, hash },
            },
          }),
          [200],
        );
      });
    },
  };
}
