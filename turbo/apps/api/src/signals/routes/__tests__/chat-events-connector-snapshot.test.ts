import { randomUUID } from "node:crypto";
import { HeadObjectCommand } from "@aws-sdk/client-s3";
import { chatConnectorAccessContract } from "@okouai/api-contracts/contracts/chat-connector-access";
import { connectorPermissionsContract } from "@okouai/api-contracts/contracts/connector-permissions";
import { chatThreadConnectorSelectionContract } from "@okouai/api-contracts/contracts/chat-threads";
import { getCustomConnectorSkillName } from "@okouai/core/storage-names";
import { describe, expect, it, onTestFinished } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { buildArtifactKeyV2 } from "../../../lib/file-url";
import { mockNow, now } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createDeferredPromise, settleIncludingAbort } from "../../utils";
import { chatConnectorAccessRoutes } from "../chat-connector-access";
import { chatThreadRoutes } from "../chat-threads";
import { connectorPermissionsRoutes } from "../connector-permissions";
import { createConnectorBddApi } from "./helpers/api-bdd-connectors";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { readExecutionContentBundle } from "./helpers/execution-content-bundle";
import { publicChatActor } from "./helpers/public-chat-actor";
import { installWorkflowVolumeS3Fixture } from "./helpers/workflow-volume-s3";

const context = testContext();
const connectors = createConnectorBddApi(context);
const fixture = createChatEventsFixture(context);
const headers = { authorization: "Bearer clerk-session" } as const;

/** Suspend the normal input's external attachment lookup after request preload starts. */
function holdAttachment(userId: string) {
  const fileId = randomUUID();
  const filename = "accepted-connectors.txt";
  const key = buildArtifactKeyV2(fileId, filename);
  const entered = createDeferredPromise<void>(context.signal);
  const release = createDeferredPromise<void>(context.signal);
  const send = context.mocks.s3.send.getMockImplementation();
  if (!send) {
    throw new Error("Expected public chat S3 transport");
  }
  context.mocks.s3.send.mockImplementation(async (request: unknown) => {
    if (request instanceof HeadObjectCommand && request.input.Key === key) {
      if (!entered.settled()) {
        entered.resolve();
      }
      await release.promise;
      return {
        ContentLength: 42,
        ContentType: "text/plain",
        LastModified: new Date("2026-11-18T00:00:00Z"),
        Metadata: {
          "artifact-id": fileId,
          filename: encodeURIComponent(filename),
          "user-id": encodeURIComponent(userId),
        },
      };
    }
    return await send(request);
  });
  return {
    entered: entered.promise,
    release() {
      if (!release.settled()) {
        release.resolve();
      }
    },
    userMessage: {
      version: 1 as const,
      parts: [
        {
          type: "file" as const,
          fileId,
          filenameSnapshot: filename,
          contentType: "text/plain",
        },
        { type: "text" as const, text: "use the accepted Connectors" },
      ],
    },
  };
}

describe("accepted Connector preparation", () => {
  it.each(["active", "expired"] as const)(
    "retains custom permission refresh while the Run is active: %s",
    async (state) => {
      const startedAt = now();
      mockNow(startedAt);
      const owned = await publicChatActor(context);
      owned.ownsFeatureSwitches();
      const { actor, agentId } = owned;
      const connector = await owned.run(async () => {
        await connectors.updateFeatureSwitches(actor, {
          connectorChatAccountAccess: true,
        });
        const connector = await connectors.createCustomConnector(actor, {
          displayName: "Temporary Slack permissions",
          authMode: "none",
          prefixTemplates: ["https://slack.com/api/"],
          fields: [],
          headerInjections: [],
          queryInjections: [],
          permissionBundleRef: "builtin:slack@1",
        });
        await connectors.setCustomConnectorValues(actor, connector.id, []);
        const client = setupApp({
          context,
          routes: connectorPermissionsRoutes,
        })(connectorPermissionsContract);
        await accept(
          client.apply({
            headers,
            body: {
              target: { kind: "custom", customConnectorId: connector.id },
              mode: "patch",
              grants: [
                { permission: "chat:write", action: "allow", expiresIn: "1h" },
              ],
            },
          }),
          [200],
        );
        return connector;
      });
      const run = await owned.sendChatRun(actor, {
        agentId,
        prompt: "use the captured temporary grant",
      });
      const { execution } = await owned.runExecution(run.runId);
      const firewall = execution.firewalls?.find((entry) => {
        return (
          entry.kind === "inline" && entry.customConnectorId === connector.id
        );
      });
      if (!firewall || firewall.kind !== "inline") {
        throw new Error("Expected the accepted custom firewall");
      }
      expect(
        execution.networkPolicies?.[firewall.firewall.name]?.allow,
      ).toContain("chat:write");
      if (state === "expired") {
        mockNow(startedAt + 60 * 60 * 1000);
      }
      const synced = await owned.run(() => {
        return createRunsApi(context).syncConnectorRuntime(run.runId, {
          targets: execution.connectorRuntimeTargets,
        });
      });
      const current = synced.find((result) => {
        return (
          result.target.kind === "custom" &&
          result.target.customConnectorId === connector.id
        );
      });
      expect(current).toMatchObject({ state: "available" });
      if (current?.state !== "available") {
        throw new Error("Expected the active Run's custom Connector policy");
      }
      if (state === "expired") {
        expect(current.networkPolicy?.allow).not.toContain("chat:write");
        expect(current.networkPolicy?.deny).toContain("chat:write");
        expect(current.nextSyncAt).toBeUndefined();
      } else {
        expect(current.networkPolicy?.allow).toContain("chat:write");
        expect(current.nextSyncAt).toBe(
          new Date(startedAt + 60 * 60 * 1000).toISOString(),
        );
      }
    },
  );

  it.each([false, true])(
    "retains the first Thread account choice while input is prepared (Chat accounts: %s)",
    async (chatAccounts) => {
      const owned = await publicChatActor(context);
      owned.ownsFeatureSwitches();
      const { actor, agentId } = owned;
      const { firstAccount, nextAccount, thread } = await owned.run(
        async () => {
          await connectors.updateFeatureSwitches(actor, {
            connectorChatAccountAccess: chatAccounts,
          });
          const firstAccount = await connectors.connectManualGrant(
            actor,
            "runtime",
            "api-token",
            { apiKey: "accepted-runtime-key" },
            agentId,
          );
          const nextAccount = await connectors.connectManualGrant(
            actor,
            "runtime",
            "api-token",
            { apiKey: "next-runtime-key" },
            agentId,
            { intent: "add", displayName: "Later account" },
          );
          const thread = await fixture.chat.createThread(actor, { agentId });
          return { firstAccount, nextAccount, thread };
        },
      );
      const selectAccount = async (connectionId: string) => {
        return await owned.run(async () => {
          const body = {
            connectionId,
            target: {
              kind: "builtin" as const,
              connectorSlug: "runtime" as const,
            },
          };
          if (chatAccounts) {
            const client = setupApp({
              context,
              routes: chatConnectorAccessRoutes,
            })(chatConnectorAccessContract);
            await accept(
              client.setThreadCurrent({
                headers,
                params: { threadId: thread.id },
                body,
              }),
              [200],
            );
          } else {
            const client = setupApp({ context, routes: chatThreadRoutes })(
              chatThreadConnectorSelectionContract,
            );
            await accept(
              client.update({ headers, params: { id: thread.id }, body }),
              [200],
            );
          }
        });
      };
      await selectAccount(firstAccount.id);
      const held = holdAttachment(actor.userId);
      const sending = settleIncludingAbort(
        owned.sendChatRun(actor, {
          agentId,
          threadId: thread.id,
          prompt: "use the first account",
          userMessage: held.userMessage,
        }),
      );
      onTestFinished(async () => {
        held.release();
        await sending;
      });
      await held.entered;
      // Attachment IO proves preload started, not that its database reads finished.
      await flushWaitUntilForTest();
      await selectAccount(nextAccount.id);
      held.release();
      const sent = await sending;
      if (!sent.ok) {
        throw sent.error;
      }
      const first = await owned.runExecution(sent.value.runId);
      expect(
        first.execution.secretConnectorMetadataMap?.RUNTIME_API_KEY,
      ).toMatchObject({ sourceId: firstAccount.id });
      expect(JSON.stringify(first.execution)).not.toContain(
        "accepted-runtime-key",
      );
      await owned.run(() => {
        return fixture.cancelChatRun(
          actor,
          sent.value.runId,
          first.sandboxHeaders,
        );
      });
      const next = await owned.sendChatRun(actor, {
        agentId,
        threadId: thread.id,
        prompt: "use the later account",
      });
      const execution = await owned.runExecution(next.runId);
      expect(
        execution.execution.secretConnectorMetadataMap?.RUNTIME_API_KEY,
      ).toMatchObject({ sourceId: nextAccount.id });
    },
  );

  it.each([
    { chatAccounts: false, change: "reconnect" },
    { chatAccounts: true, change: "reconnect" },
    { chatAccounts: false, change: "deletion" },
    { chatAccounts: true, change: "deletion" },
  ] as const)(
    "retains coherent custom configuration and Skill bytes through $change (Chat accounts: $chatAccounts)",
    async ({ chatAccounts, change }) => {
      const owned = await publicChatActor(context);
      owned.ownsFeatureSwitches();
      const { actor, agentId } = owned;
      const body = {
        displayName: "Accepted custom source",
        authMode: "none" as const,
        prefixTemplates: ["https://accepted-custom.example.test/api/"],
        fields: [],
        headerInjections: [],
        queryInjections: [],
        skillMarkdown: "Accepted Connector instructions.",
      };
      const { connector, connectionId, s3 } = await owned.run(async () => {
        await connectors.updateFeatureSwitches(actor, {
          connectorChatAccountAccess: chatAccounts,
        });
        const s3 = installWorkflowVolumeS3Fixture(context);
        const connector = await connectors.createCustomConnector(actor, body);
        const account = await connectors.setCustomConnectorValues(
          actor,
          connector.id,
          [],
        );
        await connectors.updateAgentCustomConnectors(actor, agentId, [
          connector.id,
        ]);
        return { connector, connectionId: account.connectionId, s3 };
      });
      const held = holdAttachment(actor.userId);
      const sending = settleIncludingAbort(
        owned.sendChatRun(actor, {
          agentId,
          prompt: "use the accepted custom source",
          userMessage: held.userMessage,
        }),
      );
      onTestFinished(async () => {
        held.release();
        await sending;
      });
      await held.entered;
      await flushWaitUntilForTest();
      await owned.run(async () => {
        if (change === "deletion") {
          await connectors.deleteCustomConnector(actor, connector.id);
          return;
        }
        await connectors.updateCustomConnector(actor, connector.id, {
          ...body,
          prefixTemplates: ["https://later-custom.example.test/api/"],
          skillMarkdown: "Later Connector instructions.",
        });
        await connectors.setCustomConnectorValues(actor, connector.id, [], {
          intent: "reconnect",
          connectionId,
        });
      });
      held.release();
      const sent = await sending;
      if (!sent.ok) {
        throw sent.error;
      }
      const first = await owned.runExecution(sent.value.runId);
      const mountPath = `/home/user/.claude/skills/${getCustomConnectorSkillName(connector.slug, connector.id)}`;
      const firewall = first.execution.firewalls?.find((entry) => {
        return (
          entry.kind === "inline" && entry.customConnectorId === connector.id
        );
      });
      expect(firewall).toMatchObject({
        firewall: {
          apis: [expect.objectContaining({ base: body.prefixTemplates[0] })],
        },
      });
      expect(first.execution.connectorRuntimeTargets).toContainEqual({
        kind: "custom",
        customConnectorId: connector.id,
        sourceId: connectionId,
        baseUrlVars: {},
      });
      const skill = first.execution.contentBundles.skills.find((bundle) => {
        return bundle.mountPath === mountPath;
      });
      if (!skill) {
        throw new Error("Expected the accepted Connector Skill");
      }
      expect(
        readExecutionContentBundle(s3.objects, skill)
          .get("SKILL.md")
          ?.toString(),
      ).toContain(body.skillMarkdown);
      await owned.run(() => {
        return fixture.cancelChatRun(
          actor,
          sent.value.runId,
          first.sandboxHeaders,
        );
      });
      const next = await owned.sendChatRun(actor, {
        agentId,
        prompt: "use the later custom source",
      });
      const execution = await owned.runExecution(next.runId);
      if (change === "deletion") {
        expect(execution.execution.connectorRuntimeTargets).not.toContainEqual(
          expect.objectContaining({
            kind: "custom",
            customConnectorId: connector.id,
          }),
        );
        expect(execution.execution.contentBundles.skills).not.toContainEqual(
          expect.objectContaining({ mountPath }),
        );
        return;
      }
      expect(
        execution.execution.firewalls?.find((entry) => {
          return (
            entry.kind === "inline" && entry.customConnectorId === connector.id
          );
        }),
      ).toMatchObject({
        firewall: {
          apis: [
            expect.objectContaining({
              base: "https://later-custom.example.test/api/",
            }),
          ],
        },
      });
      const nextSkill = execution.execution.contentBundles.skills.find(
        (bundle) => {
          return bundle.mountPath === mountPath;
        },
      );
      if (!nextSkill) {
        throw new Error("Expected the later Connector Skill");
      }
      expect(nextSkill.sha256).not.toBe(skill.sha256);
      expect(
        readExecutionContentBundle(s3.objects, nextSkill)
          .get("SKILL.md")
          ?.toString(),
      ).toContain("Later Connector instructions.");
    },
  );
});
