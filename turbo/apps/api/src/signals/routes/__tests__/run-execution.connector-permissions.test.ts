import { GetObjectCommand } from "@aws-sdk/client-s3";
import { createHash, randomUUID } from "node:crypto";
import { http, HttpResponse } from "msw";
import { describe, expect, it, test } from "vitest";
import { connectorPermissionsContract } from "@okouai/api-contracts/contracts/connector-permissions";
import type { ApplyUserPermissionGrant } from "@okouai/api-contracts/validators/user-permission-grants";
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
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import {
  mockGitHubConnectorOAuth,
  mockSlackConnectorOAuth,
} from "./helpers/api-bdd-connectors";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";
import { createPublicRunnerMemory } from "./helpers/public-runner-memory";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const mocks = createRouteMocks(context);
const {
  connectors,
  entitledNativeChatActor,
  sendChatRun,
  queueChatRun,
  runExecution,
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

async function executeAndCancel(actor: ApiTestUser, agentId: string) {
  const run = await sendChatRun(actor, {
    agentId,
    prompt: "use the current connector permission definitions",
  });
  const { execution, sandboxHeaders } = await runExecution(run.runId);
  await cancelChatRun(actor, run.runId, sandboxHeaders);
  return execution;
}

test("uses current permission definitions after publication with a warm execution cache", async () => {
  const publisher = (
    await setupApp({
      context,
      routes: cronConnectorCatalogRoutes,
      isolatePg: true,
    })
  )(cronConnectorCatalogContract);
  const { actor, agentId } = await entitledNativeChatActor();
  await connectors.connectManualGrant(actor, "figma", "api-token", {
    accessToken: "execution-catalog-figma-token",
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
  const first = await executeAndCancel(actor, agentId);
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
  const { execution, sandboxHeaders } = await runExecution(run.runId);
  expect(execution.networkPolicies?.figma).toStrictEqual({
    allow: [],
    deny: ["file_comments:read", "file_content:read"],
    ask: [],
    unknownPolicy: "ask",
  });
  expect(execution.networkPolicyRefreshes?.figma).toBeUndefined();
  await cancelChatRun(actor, run.runId, sandboxHeaders);
});

describe("Execution connector permissions", () => {
  it.each(["add", "revoke"] as const)(
    "applies a %s grant change made after the Run was queued",
    async (change) => {
      const { actor, agentId } = await entitledNativeChatActor();
      mockGitHubConnectorOAuth();
      server.use(
        http.delete(
          "https://api.github.com/applications/github-client-id/grant",
          () => {
            return new HttpResponse(null, { status: 204 });
          },
        ),
      );
      const started = await connectors.startOauth(actor, "github", "oauth");
      const state = new URL(started.authorizationUrl).searchParams.get("state");
      if (!state) {
        throw new Error("Expected OAuth state from the public start response");
      }
      const completed = await connectors.completeOauthCallbackResult("github", {
        state,
        code: randomUUID(),
      });
      expect(completed.body.status).toBe("success");
      const grant = {
        agentId,
        connectorSlug: "github" as const,
        permission: "user:read",
        action: "deny" as const,
      };
      if (change === "revoke") {
        await sharedGrants(actor, "github", [
          { permission: grant.permission, action: grant.action },
        ]);
      }

      await executeAndCancel(actor, agentId);
      const queued = await queueChatRun(actor, {
        agentId,
        prompt: "use the current GitHub permissions for execution",
      });
      if (change === "add") {
        await sharedGrants(actor, "github", [
          { permission: grant.permission, action: grant.action },
        ]);
      } else {
        await sharedGrants(actor, "github", [], "replace");
      }
      const run = await queued.launch();
      const { execution, sandboxHeaders } = await runExecution(run.runId);
      expect(execution.connectorRuntimeTargets).toContainEqual(
        expect.objectContaining({ kind: "builtin", connectorSlug: "github" }),
      );
      expect(execution.networkPolicies?.github).toMatchObject(
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
      expect(execution.networkPolicies?.github?.allow).toContain(
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
    "expired-before-preparation",
    "expired-during-memory-signing",
    "expired-during-bundle-signing",
  ] as const)(
    "evaluates the captured permission source and temporary deadline: %s",
    async (expiry) => {
      const expired = expiry !== "active";
      const startedAt = now();
      mockNow(startedAt);
      const { actor, agentId, runnerGroup } = await entitledNativeChatActor();
      mockSlackConnectorOAuth();
      const started = await connectors.startOauth(actor, "slack", "oauth");
      const state = new URL(started.authorizationUrl).searchParams.get("state");
      if (!state) {
        throw new Error("Expected OAuth state from the public start response");
      }
      const completed = await connectors.completeOauthCallbackResult("slack", {
        state,
        code: randomUUID(),
      });
      expect(completed.body.status).toBe("success");
      const runs = createRunsApi(context);
      const grant = {
        permission: "chat:write",
        action: "allow" as const,
        expiresIn: "1h" as const,
      };

      await sharedGrants(actor, "slack", [{ ...grant, expiresIn: "1h" }]);

      const expiresAt = startedAt + 60 * 60 * 1000;
      const prompt =
        "use the current Slack write grant and its original expiry";
      let run: Awaited<ReturnType<typeof sendChatRun>>;
      if (expiry === "expired-during-memory-signing") {
        const memory = createPublicRunnerMemory(context, actor);
        run = await memory.run(async () => {
          memory.installObjects();
          const writer = await memory.startExecution(
            agentId,
            "Publish Memory for the next Run",
          );
          expect(writer.execution.networkPolicies?.slack?.allow).toContain(
            "chat:write",
          );
          const versionId = await memory.publish(writer, [
            { path: "MEMORY.md", content: "A fact the next Run can recall" },
          ]);
          mockNow(expiresAt - 1);
          await runs.registerDirectRunner(runnerGroup);
          const presigner = context.mocks.s3.getSignedUrl;
          const sign = presigner.getMockImplementation();
          if (!sign) {
            throw new Error("Expected the Memory presigner fixture");
          }
          presigner.mockImplementation((...args) => {
            const command = args[1];
            if (
              command instanceof GetObjectCommand &&
              command.input.Key?.endsWith(`/${versionId}/archive.tar.gz`)
            ) {
              // The grant is active at admission and expires while the
              // accepted Memory mount is being prepared.
              mockNow(expiresAt);
              presigner.mockImplementation(sign);
            }
            return sign(...args);
          });
          const hydrated = await memory.startExecution(agentId, prompt);
          expect(hydrated.memory).toMatchObject({
            versionId,
            archiveUrl: expect.any(String),
          });
          expect(now()).toBe(expiresAt);
          return hydrated.run;
        });
      } else if (expiry === "expired-during-bundle-signing") {
        await createBddApi(context).updateAgentInstructions(
          actor,
          agentId,
          `Instructions for a fresh bundle: ${randomUUID()}`,
        );
        mockNow(expiresAt - 1);
        await runs.registerDirectRunner(runnerGroup);
        const presigner = context.mocks.s3.getSignedUrl;
        const sign = presigner.getMockImplementation();
        if (!sign) {
          throw new Error("Expected the bundle presigner fixture");
        }
        presigner.mockImplementation((...args) => {
          const command = args[1];
          if (
            command instanceof GetObjectCommand &&
            command.input.Key?.startsWith("bundles/v1/")
          ) {
            mockNow(expiresAt);
            presigner.mockImplementation(sign);
          }
          return sign(...args);
        });
        run = await sendChatRun(actor, { agentId, prompt });
        expect(now()).toBe(expiresAt);
      } else {
        await executeAndCancel(actor, agentId);
        const queued = await queueChatRun(actor, { agentId, prompt });
        mockNow(
          expiry === "expired-before-preparation"
            ? expiresAt
            : startedAt + 30 * 60 * 1000,
        );
        await runs.registerDirectRunner(runnerGroup);
        run = await queued.launch();
      }
      // Delivered input keeps its permission source after a mode change.

      const { execution, sandboxHeaders } = await runExecution(run.runId);
      expect(execution.networkPolicies?.slack?.allow).toStrictEqual(
        expired
          ? expect.not.arrayContaining(["chat:write"])
          : expect.arrayContaining(["chat:write"]),
      );
      if (expired) {
        expect(execution.networkPolicies?.slack?.deny).toContain("chat:write");
        expect(execution.networkPolicyRefreshes?.slack).toBeUndefined();
      } else {
        expect(execution.networkPolicyRefreshes?.slack).toStrictEqual({
          nextRefreshAt: new Date(expiresAt).toISOString(),
        });
        // Active-Run sync follows current settings, independently of the
        // published execution decision. Restore the mode before testing expiry.

        mockNow(expiresAt);
        const synced = await runs.syncConnectorRuntime(run.runId, {
          targets: execution.connectorRuntimeTargets.filter((target) => {
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
});
