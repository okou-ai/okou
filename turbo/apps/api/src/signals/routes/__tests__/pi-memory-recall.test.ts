import { describe, expect, it } from "vitest";
import { proactiveLearningContract } from "@okouai/api-contracts/contracts/proactive-nightly";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { proactiveLearningRoutes } from "../proactive-preferences";
import { createRouteMocks } from "./helpers/route-test";
import {
  createPublicRunnerMemory,
  memoryFilesArchive,
} from "./helpers/public-runner-memory";
import { storageTextFile } from "./helpers/api-bdd-storage-files";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { readClaimedPiMemory } from "./helpers/pi-memory-session";

const context = testContext();

describe("ordinary Pi published personal Memory", () => {
  it("reads the selected published version across Runs, independently of Learning and ProactiveAgent", async () => {
    const fixture = createPublicRunnerMemory(context);
    await fixture.run(async () => {
      const agentId = await fixture.initializeNative();
      const chat = createChatEventsFixture(context);
      await chat.configureSubscriptionPiModel(fixture.actor);
      if (!fixture.actor.orgId) {
        throw new Error("Expected member organization");
      }
      const actor = { ...fixture.actor, orgId: fixture.actor.orgId };
      await updateFeatureSwitchesForUser(context, actor, {
        proactiveAgent: true,
      });
      createRouteMocks(context).clerk.session(
        actor.userId,
        actor.orgId,
        actor.orgRole,
      );
      const learning = setupApp({ context, routes: proactiveLearningRoutes })(
        proactiveLearningContract,
      );
      const preference = await accept(
        learning.update({
          headers: { authorization: "Bearer clerk-session" },
          body: { enabled: false },
        }),
        [200],
      );
      expect(preference.body.enabled).toBeFalsy();
      await updateFeatureSwitchesForUser(context, actor, {
        proactiveAgent: false,
      });
      fixture.installObjects();

      async function publish(
        claimed: Awaited<ReturnType<typeof fixture.claim>>,
        suffix: string,
      ) {
        const files = [
          {
            path: "memory_summary.md",
            content: `v1\n## User Profile\nHarbor overview ${suffix}`,
          },
          { path: "MEMORY.md", content: "Harbor project: details/harbor.md" },
          {
            path: "details/harbor.md",
            content: `Verified harbor fact ${suffix}`,
          },
        ];
        const entries = files.map((file) => {
          return storageTextFile(file.path, file.content);
        });
        const prepared = await fixture.webhooks.requestAgentStoragePrepare(
          {
            runId: claimed.run.runId,
            storageId: claimed.memory.storageId,
            parentVersionId: claimed.memory.versionId,
            files: entries,
          },
          claimed.headers,
          [200],
        );
        if (prepared.status !== 200 || !prepared.body.uploads) {
          throw new Error("Expected authorized storage uploads");
        }
        fixture.objects.set(
          prepared.body.uploads.archive.key,
          memoryFilesArchive(files),
        );
        fixture.objects.set(
          prepared.body.uploads.manifest.key,
          Buffer.from(
            JSON.stringify({
              version: 1,
              files: entries,
              createdAt: new Date(0).toISOString(),
            }),
          ),
        );
        await fixture.webhooks.requestAgentStorageCommit(
          {
            runId: claimed.run.runId,
            storageId: claimed.memory.storageId,
            parentVersionId: claimed.memory.versionId,
            versionId: prepared.body.versionId,
            files: entries,
          },
          claimed.headers,
          [200],
        );
        await fixture.webhooks.requestAgentComplete(
          {
            runId: claimed.run.runId,
            exitCode: 0,
            completion: {
              cliAgentType: "claude-code",
              cliAgentSessionId: `memory-writer-${claimed.run.runId}`,
              cliAgentSessionHistoryDisposition: "native_only",
              storageOutputs: [
                {
                  name: claimed.memory.name,
                  mountPath: claimed.memory.mountPath,
                  version: prepared.body.versionId,
                  ...(claimed.memory.missingRootPolicy === undefined
                    ? {}
                    : { missingRootPolicy: claimed.memory.missingRootPolicy }),
                },
              ],
            },
          },
          claimed.headers,
          [200],
        );
        expect(
          (await fixture.api.readRun(actor, claimed.run.runId)).status,
        ).toBe("completed");
        return prepared.body.versionId;
      }
      const writer = await fixture.claim(
        agentId,
        "Publish a verified personal fact",
      );
      const published = await publish(writer, "selected-version");
      const selected = await fixture.claim(
        agentId,
        "Recall published personal Memory",
        "gpt-6-luna",
      );
      expect(selected.memory).toMatchObject({
        versionId: published,
        mountPath: "/home/user/.pi/agent/memory",
      });
      expect(selected.execution.featureFlags?.proactiveAgent).toBeFalsy();
      const laterWriter = await fixture.claim(
        agentId,
        "Publish a newer version after reader startup",
      );
      let newerVersion = "";
      const read = await readClaimedPiMemory(
        selected.execution,
        selected.memory,
        context.signal,
        async () => {
          newerVersion = await publish(laterWriter, "later-unselected-version");
        },
      );
      expect(newerVersion).not.toBe(published);
      const firstRequest = JSON.stringify(read.requests[0]);
      expect(firstRequest).toContain("Harbor overview selected-version");
      expect(firstRequest).toContain("Personal Memory recall");
      expect(firstRequest).not.toContain("Verified harbor fact");
      const wire = JSON.stringify(read.requests);
      expect(wire).toContain("Harbor project: details/harbor.md");
      expect(wire).toContain("Verified harbor fact selected-version");
      expect(wire).not.toContain("later-unselected-version");
      expect(
        read.records.filter((record) => {
          return record.type === "tool_execution_end";
        }),
      ).toHaveLength(4);
      const next = await fixture.claim(
        agentId,
        "A new Run selects the newly published version",
        "gpt-6-luna",
      );
      expect(next.memory.versionId).toBe(newerVersion);

      // A different member of the same organization gets their own empty root.
      const foreign = createPublicRunnerMemory(context, {
        orgId: actor.orgId,
        orgRole: "org:member",
      });
      await foreign.run(async () => {
        const foreignAgent = await foreign.initializeNative();
        await chat.configureSubscriptionPiModel(foreign.actor);
        foreign.installObjects();
        const claimed = await foreign.claim(
          foreignAgent,
          "Read my own personal Memory",
          "gpt-6-luna",
        );
        await fixture.api.requestRunContext(
          foreign.actor,
          selected.run.runId,
          [404],
        );
        expect(claimed.memory.storageId).not.toBe(selected.memory.storageId);
        expect(claimed.memory.empty).toBeTruthy();
        const otherRead = await readClaimedPiMemory(
          claimed.execution,
          claimed.memory,
          context.signal,
        );
        expect(JSON.stringify(otherRead.requests)).not.toContain(
          "Verified harbor fact",
        );
        expect(JSON.stringify(otherRead.requests)).not.toContain(
          "Harbor overview selected-version",
        );
        expect(JSON.stringify(otherRead.records)).toContain('"isError":true');
      });
    });
  }, 90_000);
});
