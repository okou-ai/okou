import { GetObjectCommand } from "@aws-sdk/client-s3";
import { createHash, randomUUID } from "node:crypto";
import { http, HttpResponse } from "msw";
import { describe, expect, it, test } from "vitest";
import { connectorPermissionsContract } from "@okouai/api-contracts/contracts/connector-permissions";
import type { ApplyUserPermissionGrant } from "@okouai/api-contracts/contracts/user-permission-grants";
import { cronConnectorCatalogContract } from "@okouai/api-contracts/contracts/cron";
import {
  CONNECTOR_CATALOG_ACTIVE_KEY,
  connectorCatalogArtifactSchema,
} from "@okouai/connectors/connector-catalog/artifacts/artifacts";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockNow, now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { API_TEST_CONNECTOR_CATALOG_ARTIFACT } from "../../../test-fixtures/connector-catalog-artifact";
import baselineSkillBundle from "../../../test-fixtures/connector-skill-bundle.json";
import { connectorPermissionsRoutes } from "../connector-permissions";
import { cronConnectorCatalogRoutes } from "../cron-connector-catalog";
import { chatEventsRoutes } from "../chat-events";
import type { ApiTestUser } from "./helpers/api-bdd";
import {
  mockGitHubConnectorOAuth,
  mockSlackConnectorOAuth,
} from "./helpers/api-bdd-connectors";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";
import { createRouteMocks } from "./helpers/route-test";
import { useSecretKmsProbe } from "./helpers/secret-kms-probe";

const context = testContext();
const mocks = createRouteMocks(context);
const {
  connectors,
  entitledNativeChatActor,
  sendChatRun,
  queueChatRun,
  claimChatRun,
  cancelChatRun,
} = createChatEventsFixture(context);

async function sharedGrants(
  actor: ApiTestUser,
  connectorSlug: string,
  grants: readonly ApplyUserPermissionGrant[],
  mode: "patch" | "replace" = "patch",
) {
  mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
  return await accept(
    setupApp({ context, routes: connectorPermissionsRoutes })(
      connectorPermissionsContract,
    ).apply({
      headers: { authorization: "Bearer clerk-session" },
      body: {
        target: { kind: "builtin", connectorSlug },
        mode,
        grants: [...grants],
      },
    }),
    [200],
  );
}

async function claimAndCancel(
  actor: ApiTestUser,
  agentId: string,
  runnerGroup: string,
) {
  const run = await sendChatRun(actor, {
    agentId,
    prompt: "use the current connector permission definitions",
  });
  const { claim, sandboxHeaders } = await claimChatRun(runnerGroup, run.runId);
  await cancelChatRun(actor, run.runId, sandboxHeaders);
  return claim;
}

test("uses current permission definitions after publication with a warm claim cache", async () => {
  const publisher = (
    await setupApp({
      context,
      routes: cronConnectorCatalogRoutes,
      isolatePg: true,
    })
  )(cronConnectorCatalogContract);
  const { actor, agentId, runnerGroup } = await entitledNativeChatActor();
  await connectors.connectManualGrant(
    actor,
    "figma",
    "api-token",
    { accessToken: "claim-catalog-figma-token" },
    agentId,
  );
  await connectors.updateFeatureSwitches(actor, {
    connectorChatAccountAccess: false,
  });
  const original = connectorCatalogArtifactSchema.parse(
    structuredClone(API_TEST_CONNECTOR_CATALOG_ARTIFACT),
  );
  original.catalogVersion = `2099-11-06.${randomUUID()}`;
  async function publish(artifact: typeof original) {
    const raw = Buffer.from(JSON.stringify(artifact));
    const catalogDigest = `sha256:${createHash("sha256").update(raw).digest("hex")}`;
    const key = `connectors/v4/releases/${artifact.catalogVersion}/catalog.json`;
    const bundledConnector = artifact.connectors.find((connector) => {
      return connector.slug === "nintendo-store";
    });
    if (bundledConnector?.skill.kind !== "bundled") {
      throw new Error("Expected the baseline Nintendo Skill bundle");
    }
    const receiptKey = `connectors/skill-bundles/v1/${catalogDigest.slice(7)}.json`;
    const receipt = Buffer.from(
      JSON.stringify({
        version: 1,
        catalogDigest,
        skills: [
          {
            slug: bundledConnector.slug,
            sourceVersionId: bundledConnector.skill.versionId,
            bundle: {
              sha256: baselineSkillBundle.sha256,
              archiveBytes: baselineSkillBundle.archiveBytes,
            },
          },
        ],
      }),
    );
    const pointer = Buffer.from(
      JSON.stringify({
        catalogVersion: artifact.catalogVersion,
        catalogKey: key,
        catalogDigest,
      }),
    );
    const send = context.mocks.s3.send.getMockImplementation();
    if (!send) {
      throw new Error("Expected the actor object-storage fixture");
    }
    context.mocks.s3.send.mockImplementation((command: unknown) => {
      if (command instanceof GetObjectCommand) {
        const bytes =
          command.input.Key === CONNECTOR_CATALOG_ACTIVE_KEY
            ? pointer
            : command.input.Key === key
              ? raw
              : command.input.Key === receiptKey
                ? receipt
                : undefined;
        if (bytes) {
          return Promise.resolve({
            ContentLength: bytes.length,
            Body: {
              async *[Symbol.asyncIterator]() {
                yield bytes;
              },
            },
          });
        }
      }
      return send(command);
    });
    const published = await accept(
      publisher.sync({
        headers: { authorization: "Bearer test-cron-secret" },
      }),
      [200],
    );
    expect(published.body).toStrictEqual({
      outcome: "accepted",
      failureCode: null,
    });
  }

  await publish(original);
  const first = await claimAndCancel(actor, agentId, runnerGroup);
  expect(first.networkPolicies?.figma).toStrictEqual({
    allow: ["file_content:read"],
    deny: [],
    ask: [],
    unknownPolicy: "allow",
  });
  const queued = await queueChatRun(actor, {
    agentId,
    prompt: "use definitions published after this Run was queued",
  });
  const artifact = connectorCatalogArtifactSchema.parse(
    structuredClone(original),
  );
  // The content digest changes even when the published version is reused.
  const figma = artifact.connectors.find((connector) => {
    return connector.slug === "figma";
  });
  if (figma?.firewall.kind !== "generated") {
    throw new Error("Expected the generated Figma firewall");
  }
  const api = figma.firewall.config.apis[0];
  if (!api) {
    throw new Error("Expected the Figma API");
  }
  api.permissions = [
    ...(api.permissions ?? []),
    {
      name: "file_comments:read",
      rules: ["GET /v1/files/{file_key}/comments"],
    },
  ];
  figma.firewall.defaultAllowed = [];
  figma.firewall.defaultUnknownPolicy = "ask";
  await publish(artifact);
  const run = await queued.launch();
  const { claim, sandboxHeaders } = await claimChatRun(runnerGroup, run.runId);
  expect(claim.networkPolicies?.figma).toStrictEqual({
    allow: [],
    deny: ["file_comments:read", "file_content:read"],
    ask: [],
    unknownPolicy: "ask",
  });
  expect(claim.networkPolicyRefreshes?.figma).toBeUndefined();
  await cancelChatRun(actor, run.runId, sandboxHeaders);
});

describe.each([false, true])(
  "Runner claim current connector permissions (Chat accounts: %s)",
  (chatAccounts) => {
    it.each(["add", "revoke"] as const)(
      "applies a %s grant change made after the Run was queued",
      async (change) => {
        const { actor, agentId, runnerGroup } = await entitledNativeChatActor();
        mockGitHubConnectorOAuth();
        server.use(
          http.delete(
            "https://api.github.com/applications/github-client-id/grant",
            () => {
              return new HttpResponse(null, { status: 204 });
            },
          ),
        );
        const started = await connectors.startOauth(
          actor,
          "github",
          "oauth",
          agentId,
        );
        const state = new URL(started.authorizationUrl).searchParams.get(
          "state",
        );
        if (!state) {
          throw new Error(
            "Expected OAuth state from the public start response",
          );
        }
        const completed = await connectors.completeOauthCallbackResult(
          "github",
          {
            state,
            code: randomUUID(),
          },
        );
        expect(completed.body.status).toBe("success");
        const runs = createRunsApi(context);
        const grant = {
          agentId,
          connectorSlug: "github" as const,
          permission: "user:read",
          action: "deny" as const,
        };
        if (change === "revoke") {
          await runs.applyUserPermissionGrant(actor, grant);
          await connectors.updateFeatureSwitches(actor, {
            connectorChatAccountAccess: true,
          });
          await sharedGrants(actor, "github", [
            { permission: grant.permission, action: grant.action },
          ]);
        }
        await connectors.updateFeatureSwitches(actor, {
          connectorChatAccountAccess: chatAccounts,
        });
        await claimAndCancel(actor, agentId, runnerGroup);
        const queued = await queueChatRun(actor, {
          agentId,
          prompt: "use the current GitHub permissions at claim",
        });
        if (change === "add") {
          if (chatAccounts) {
            await sharedGrants(actor, "github", [
              { permission: grant.permission, action: grant.action },
            ]);
          } else {
            await runs.applyUserPermissionGrant(actor, grant);
          }
        } else if (chatAccounts) {
          await sharedGrants(actor, "github", [], "replace");
        } else {
          await expect(
            runs.replaceUserPermissionGrants(actor, {
              agentId,
              connectorSlug: "github",
              grants: [],
            }),
          ).resolves.toStrictEqual([]);
        }
        const run = await queued.launch();
        const { claim, sandboxHeaders } = await claimChatRun(
          runnerGroup,
          run.runId,
        );
        expect(claim.connectorRuntimeTargets).toContainEqual(
          expect.objectContaining({ kind: "builtin", connectorSlug: "github" }),
        );
        expect(claim.networkPolicies?.github).toMatchObject(
          change === "add"
            ? {
                deny: expect.arrayContaining(["user:read"]),
                allow: expect.not.arrayContaining(["user:read"]),
              }
            : {
                allow: expect.arrayContaining(["user:read"]),
                deny: expect.not.arrayContaining(["user:read"]),
              },
        );
        expect(claim.networkPolicies?.github?.allow).toContain(
          "notifications:read",
        );
        await cancelChatRun(actor, run.runId, sandboxHeaders);
        const accounts = await connectors.listBuiltinConnectorAccounts(
          actor,
          "github",
        );
        for (const account of accounts) {
          await connectors.deleteBuiltinConnectorAccount(
            actor,
            "github",
            account.id,
          );
        }
      },
    );

    it.each([
      "active",
      "expired-before-claim",
      "expired-during-claim",
    ] as const)(
      "evaluates the captured permission source and temporary deadline: %s",
      async (expiry) => {
        // Heartbeats advanced across grant expiry prune the global fleet.
        await setupApp({ context, routes: chatEventsRoutes, isolatePg: true });
        const expired = expiry !== "active";
        const startedAt = now();
        mockNow(startedAt);
        const { actor, agentId, runnerGroup } = await entitledNativeChatActor();
        mockSlackConnectorOAuth();
        const started = await connectors.startOauth(
          actor,
          "slack",
          "oauth",
          agentId,
        );
        const state = new URL(started.authorizationUrl).searchParams.get(
          "state",
        );
        if (!state) {
          throw new Error(
            "Expected OAuth state from the public start response",
          );
        }
        const completed = await connectors.completeOauthCallbackResult(
          "slack",
          { state, code: randomUUID() },
        );
        expect(completed.body.status).toBe("success");
        const runs = createRunsApi(context);
        const grant = {
          permission: "chat:write",
          action: "allow" as const,
          expiresIn: "1h" as const,
        };
        await runs.applyUserPermissionGrant(actor, {
          agentId,
          connectorSlug: "slack",
          ...(chatAccounts && !expired
            ? { permission: grant.permission, action: "deny" as const }
            : { ...grant, expiresIn: chatAccounts ? "always" : "1h" }),
        });
        await connectors.updateFeatureSwitches(actor, {
          connectorChatAccountAccess: true,
        });
        await sharedGrants(actor, "slack", [
          { ...grant, expiresIn: chatAccounts ? "1h" : "always" },
        ]);
        await connectors.updateFeatureSwitches(actor, {
          connectorChatAccountAccess: chatAccounts,
        });
        await claimAndCancel(actor, agentId, runnerGroup);
        const queued = await queueChatRun(actor, {
          agentId,
          prompt: "use the current Slack write grant and its original expiry",
        });
        const expiresAt = startedAt + 60 * 60 * 1000;
        mockNow(
          expiry === "expired-before-claim"
            ? expiresAt
            : expiry === "expired-during-claim"
              ? expiresAt - 1
              : startedAt + 30 * 60 * 1000,
        );
        await runs.registerDirectRunner(runnerGroup);
        if (expiry === "expired-during-claim") {
          // Claim encrypts its reconstructed secrets after hydration. Let the
          // external KMS response cross the exact temporary-allow boundary.
          useSecretKmsProbe(() => {
            mockNow(expiresAt);
            return undefined;
          });
        }
        const run = await queued.launch();
        // Delivered input keeps its permission source after a mode change.
        await connectors.updateFeatureSwitches(actor, {
          connectorChatAccountAccess: !chatAccounts,
        });
        const { claim, sandboxHeaders } = await claimChatRun(
          runnerGroup,
          run.runId,
        );
        expect(claim.networkPolicies?.slack?.allow).toStrictEqual(
          expired
            ? expect.not.arrayContaining(["chat:write"])
            : expect.arrayContaining(["chat:write"]),
        );
        if (expired) {
          expect(claim.networkPolicies?.slack?.deny).toContain("chat:write");
          expect(claim.networkPolicyRefreshes?.slack).toBeUndefined();
        } else {
          expect(claim.networkPolicyRefreshes?.slack).toStrictEqual({
            nextRefreshAt: new Date(expiresAt).toISOString(),
          });
          // Active-Run sync follows current settings, independently of the
          // captured Claim decision. Restore the mode before testing expiry.
          await connectors.updateFeatureSwitches(actor, {
            connectorChatAccountAccess: chatAccounts,
          });
          mockNow(expiresAt);
          const synced = await runs.syncConnectorRuntime(run.runId, {
            targets: claim.connectorRuntimeTargets.filter((target) => {
              return (
                target.kind === "builtin" && target.connectorSlug === "slack"
              );
            }),
          });
          expect(synced).toContainEqual(
            expect.objectContaining({
              target: { kind: "builtin", connectorSlug: "slack" },
              state: "available",
              networkPolicy: expect.objectContaining({
                deny: expect.arrayContaining(["chat:write"]),
                allow: expect.not.arrayContaining(["chat:write"]),
              }),
            }),
          );
        }
        await cancelChatRun(actor, run.runId, sandboxHeaders);
      },
    );
  },
);
