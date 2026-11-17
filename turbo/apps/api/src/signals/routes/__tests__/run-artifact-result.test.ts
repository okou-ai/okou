import { randomUUID } from "node:crypto";
import { uploadsContract } from "@okouai/api-contracts/contracts/uploads";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { uploadsCompleteRoutes } from "../uploads-complete";
import { uploadsPrepareRoutes } from "../uploads-prepare";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { createHostBddApi } from "./helpers/api-bdd-host";
import {
  hostedTextFile,
  installHostedUploadTransport,
  uploadHostedTextFiles,
} from "./helpers/api-bdd-host-files";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { okouTokenFromExecution } from "./helpers/chat-events-fixture";
import { publicChatActor } from "./helpers/public-chat-actor";
import { completePublicClaudeRun } from "./helpers/public-native-run";

const context = testContext();

async function artifactRun() {
  const owned = await publicChatActor(context);
  const runs = createRunsApi(context);
  const run = await owned.run(() => {
    return runs.createThreadRun(owned.actor, {
      agentId: owned.agentId,
      prompt: "Create a deliverable artifact",
      model: owned.model,
    });
  });
  const execution = await owned.executionInput(run.runId);
  const bearerToken = okouTokenFromExecution(execution);
  return {
    owned,
    runs,
    run,
    bearerToken,
    complete(content = "Task finished") {
      return owned.run(() => {
        return completePublicClaudeRun(
          context,
          run,
          {
            authorization: `Bearer ${execution.sandboxToken}`,
          },
          content,
        );
      });
    },
    read() {
      return owned.run(() => {
        return runs.readRun(owned.actor, run.runId);
      });
    },
  };
}

type ArtifactRun = Awaited<ReturnType<typeof artifactRun>>;

function uploadFile(
  fixture: ArtifactRun,
  purpose: "artifact" | undefined,
  complete: boolean,
) {
  return fixture.owned.run(async () => {
    const storage = createChatCallbacksApi(context).acceptChatObjectStorage();
    installHostedUploadTransport(context, storage);
    const uploads = setupApp({
      context,
      routes: [...uploadsPrepareRoutes, ...uploadsCompleteRoutes],
    })(uploadsContract);
    const headers = { authorization: `Bearer ${fixture.bearerToken}` };
    const body = "An uploaded report.";
    const prepared = await accept(
      uploads.prepare({
        headers,
        body: {
          filename: "report.txt",
          contentType: "text/plain",
          size: Buffer.byteLength(body),
          ...(purpose ? { purpose } : {}),
        },
      }),
      [200],
    );
    if (!("uploadUrl" in prepared.body)) {
      throw new Error("Expected a single-part upload");
    }
    if (complete) {
      const uploaded = await fetch(prepared.body.uploadUrl, {
        method: "PUT",
        headers: prepared.body.uploadHeaders,
        body,
      });
      expect(uploaded.status).toBe(200);
      await accept(
        uploads.complete({ headers, body: { id: prepared.body.id } }),
        [200],
      );
    }
    return { id: prepared.body.id, url: prepared.body.url };
  });
}

function publishSite(fixture: ArtifactRun, visibility: "public" | "private") {
  return fixture.owned.run(async () => {
    const storage = createChatCallbacksApi(context).acceptChatObjectStorage();
    installHostedUploadTransport(context, storage);
    const host = createHostBddApi(context);
    const publisher = { bearerToken: fixture.bearerToken };
    const content = "<main>A published report</main>";
    const prepared = await host.prepareHostedSite(publisher, {
      site: `artifact-result-${randomUUID().slice(0, 8)}`,
      title: "Artifact result report",
      artifactKind: "hosted-site",
      spaFallback: false,
      visibility,
      files: [hostedTextFile("/index.html", content)],
    });
    await uploadHostedTextFiles(prepared, { "/index.html": content });
    return host.completeHostedSite(publisher, prepared.deploymentId);
  });
}

describe("recorded Run artifact result", () => {
  it("leaves ordinary text-only completion unknown", async () => {
    const fixture = await artifactRun();
    await fixture.complete(
      "Daily check finished without publishing an artifact.",
    );
    await expect(fixture.read()).resolves.toMatchObject({
      status: "completed",
      artifactResult: null,
    });
  });

  it.each([
    {
      label: "ready output",
      purpose: "artifact" as const,
      ready: true,
      result: "success",
    },
    { label: "ready input", purpose: undefined, ready: true, result: null },
    {
      label: "prepared output",
      purpose: "artifact" as const,
      ready: false,
      result: null,
    },
  ])("records only a successful $label", async ({ purpose, ready, result }) => {
    const fixture = await artifactRun();
    const file = await uploadFile(fixture, purpose, ready);
    await expect(fixture.read()).resolves.toMatchObject({
      status: "running",
      artifactResult: result,
    });
    await fixture.complete(file.url);
    await expect(fixture.read()).resolves.toMatchObject({
      status: "completed",
      artifactResult: result,
    });
  });

  it.each(["public", "private"] as const)(
    "records %s publication without attributing an old link to a later Run",
    async (visibility) => {
      const fixture = await artifactRun();
      const published = await publishSite(fixture, visibility);
      await fixture.complete(published.url);
      await expect(fixture.read()).resolves.toMatchObject({
        status: "completed",
        artifactResult: "success",
      });
      const next = await fixture.owned.run(() => {
        return fixture.runs.createThreadRun(fixture.owned.actor, {
          agentId: fixture.owned.agentId,
          threadId: fixture.run.threadId,
          prompt: `Summarize the existing report at ${published.url}`,
          model: fixture.owned.model,
        });
      });
      const execution = await fixture.owned.executionInput(next.runId);
      await fixture.owned.run(() => {
        return completePublicClaudeRun(
          context,
          next,
          { authorization: `Bearer ${execution.sandboxToken}` },
          published.url,
        );
      });
      await expect(
        fixture.owned.run(() => {
          return fixture.runs.readRun(fixture.owned.actor, next.runId);
        }),
      ).resolves.toMatchObject({ status: "completed", artifactResult: null });
    },
  );

  it("does not credit a later Run for completing an earlier Run's file", async () => {
    const fixture = await artifactRun();
    const file = await uploadFile(fixture, "artifact", true);
    await fixture.complete(file.url);
    const next = await fixture.owned.run(() => {
      return fixture.runs.createThreadRun(fixture.owned.actor, {
        agentId: fixture.owned.agentId,
        threadId: fixture.run.threadId,
        prompt: "Reuse the previous upload",
        model: fixture.owned.model,
      });
    });
    const execution = await fixture.owned.executionInput(next.runId);
    await fixture.owned.run(async () => {
      const uploads = setupApp({
        context,
        routes: [...uploadsPrepareRoutes, ...uploadsCompleteRoutes],
      })(uploadsContract);
      await accept(
        uploads.complete({
          headers: {
            authorization: `Bearer ${okouTokenFromExecution(execution)}`,
          },
          body: { id: file.id },
        }),
        [200],
      );
      await completePublicClaudeRun(
        context,
        next,
        { authorization: `Bearer ${execution.sandboxToken}` },
        file.url,
      );
    });
    await expect(
      fixture.owned.run(() => {
        return fixture.runs.readRun(fixture.owned.actor, next.runId);
      }),
    ).resolves.toMatchObject({ status: "completed", artifactResult: null });
  });

  it.each(["file", "site"] as const)(
    "does not change a completed Run after a late %s succeeds",
    async (kind) => {
      const fixture = await artifactRun();
      await fixture.complete();
      if (kind === "file") {
        await uploadFile(fixture, "artifact", true);
      } else {
        await publishSite(fixture, "public");
      }
      await expect(fixture.read()).resolves.toMatchObject({
        status: "completed",
        artifactResult: null,
      });
    },
  );
});
