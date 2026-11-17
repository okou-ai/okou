import { randomUUID } from "node:crypto";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { uploadsContract } from "@okouai/api-contracts/contracts/uploads";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockNow, now } from "../../../lib/time";
import { createDeferredPromise, settleIncludingAbort } from "../../utils";
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
    async complete(content = "Task finished") {
      await owned.run(() => {
        return completePublicClaudeRun(
          context,
          run,
          { authorization: `Bearer ${execution.sandboxToken}` },
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

function uploadFile(
  fixture: Awaited<ReturnType<typeof artifactRun>>,
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
    const body = "A ready, owner-scoped report file.";
    const prepared = await accept(
      uploads.prepare({
        headers,
        body: {
          filename: "report.txt",
          contentType: "text/plain",
          size: Buffer.byteLength(body),
          ...(purpose === undefined ? {} : { purpose }),
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
    return prepared.body;
  });
}

describe("Run artifact outcome", () => {
  it("preserves ordinary text-only completion without claiming no-content from absent native evidence", async () => {
    const fixture = await artifactRun();
    await fixture.complete(
      "Daily API check finished. No report was published.",
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
  ])(
    "classifies a $label through the real upload and completion protocols",
    async ({ purpose, ready, result }) => {
      const fixture = await artifactRun();
      const { url } = await uploadFile(fixture, purpose, ready);
      await expect(fixture.read()).resolves.toMatchObject({
        status: "running",
        artifactResult: null,
      });
      await fixture.complete(`Result: ${url}`);
      await expect(fixture.read()).resolves.toMatchObject({
        status: "completed",
        artifactResult: result,
      });
    },
  );

  it("does not credit an output that became ready after Run completion", async () => {
    const fixture = await artifactRun();
    await fixture.complete();
    await uploadFile(fixture, "artifact", true);
    await expect(fixture.read()).resolves.toMatchObject({
      status: "completed",
      artifactResult: null,
    });
  });

  it("does not credit a previous Run's file when its completion is replayed by a new Run", async () => {
    const fixture = await artifactRun();
    const uploaded = await uploadFile(fixture, "artifact", true);
    await fixture.complete(uploaded.url);
    const next = await fixture.owned.run(() => {
      return fixture.runs.createThreadRun(fixture.owned.actor, {
        agentId: fixture.owned.agentId,
        threadId: fixture.run.threadId,
        prompt: `Summarize the existing file at ${uploaded.url}`,
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
          body: { id: uploaded.id },
        }),
        [200],
      );
      await completePublicClaudeRun(
        context,
        next,
        {
          authorization: `Bearer ${execution.sandboxToken}`,
        },
        uploaded.url,
      );
    });
    await expect(
      fixture.owned.run(() => {
        return fixture.runs.readRun(fixture.owned.actor, next.runId);
      }),
    ).resolves.toMatchObject({ status: "completed", artifactResult: null });
    await expect(fixture.read()).resolves.toMatchObject({
      artifactResult: "success",
    });
  });

  it("keeps publication crossing Run completion unknown even when its ready clock was captured earlier", async () => {
    const fixture = await artifactRun();
    const host = createHostBddApi(context);
    await fixture.owned.run(async () => {
      const storage = createChatCallbacksApi(context).acceptChatObjectStorage();
      installHostedUploadTransport(context, storage);
      const publisher = { bearerToken: fixture.bearerToken };
      const content = "<main>An asynchronously published report</main>";
      const prepared = await host.prepareHostedSite(publisher, {
        site: `late-artifact-${randomUUID().slice(0, 8)}`,
        title: "Late publication report",
        artifactKind: "hosted-site",
        spaFallback: false,
        visibility: "public",
        files: [hostedTextFile("/index.html", content)],
      });
      await uploadHostedTextFiles(prepared, { "/index.html": content });
      const priorSend = context.mocks.s3.send.getMockImplementation();
      if (!priorSend) {
        throw new Error("Missing object-storage transport");
      }
      const entered = createDeferredPromise<void>(context.signal);
      const released = createDeferredPromise<void>(context.signal);
      context.mocks.s3.send.mockImplementation(async (request) => {
        if (
          request instanceof PutObjectCommand &&
          request.input.Key?.endsWith(
            `/deployments/${prepared.deploymentId}.json`,
          )
        ) {
          entered.resolve();
          await released.promise;
        }
        return priorSend(request);
      });
      const publishing = settleIncludingAbort(
        host.completeHostedSite(publisher, prepared.deploymentId),
      );
      const beforePublication = await settleIncludingAbort(
        (async () => {
          const paused = await Promise.race([
            entered.promise.then(() => {
              return true;
            }),
            publishing.then(() => {
              return false;
            }),
          ]);
          expect(paused).toBeTruthy();
          await fixture.complete();
          await expect(fixture.read()).resolves.toMatchObject({
            status: "completed",
            artifactResult: null,
          });
        })(),
      );
      released.resolve();
      const result = await publishing;
      if (!beforePublication.ok) {
        throw beforePublication.error;
      }
      if (!result.ok) {
        throw result.error;
      }
      await expect(fixture.read()).resolves.toMatchObject({
        status: "completed",
        artifactResult: null,
      });
    });
  });

  it.each(["public", "private"] as const)(
    "recognizes %s ready deployments and revisions without crediting a same-thread old link",
    async (visibility) => {
      const fixture = await artifactRun();
      const host = createHostBddApi(context);
      const site = `artifact-result-${randomUUID().slice(0, 8)}`;
      const content = "<main>A published report</main>";
      const first = await fixture.owned.run(async () => {
        const storage =
          createChatCallbacksApi(context).acceptChatObjectStorage();
        installHostedUploadTransport(context, storage);
        const publication = await host.prepareHostedSite(
          { bearerToken: fixture.bearerToken },
          {
            site,
            title: "Artifact outcome report",
            artifactKind: "hosted-site",
            spaFallback: false,
            visibility,
            files: [hostedTextFile("/index.html", content)],
          },
        );
        await uploadHostedTextFiles(publication, { "/index.html": content });
        return host.completeHostedSite(
          { bearerToken: fixture.bearerToken },
          publication.deploymentId,
        );
      });
      await fixture.complete(first.url);
      await expect(fixture.read()).resolves.toMatchObject({
        artifactResult: "success",
      });

      const oldLinkRun = await fixture.owned.run(() => {
        return fixture.runs.createThreadRun(fixture.owned.actor, {
          agentId: fixture.owned.agentId,
          threadId: fixture.run.threadId,
          prompt: `Summarize the existing report at ${first.url}`,
          model: fixture.owned.model,
        });
      });
      const oldExecution = await fixture.owned.executionInput(oldLinkRun.runId);
      await fixture.owned.run(() => {
        return completePublicClaudeRun(
          context,
          oldLinkRun,
          { authorization: `Bearer ${oldExecution.sandboxToken}` },
          `The existing report remains at ${first.url}`,
        );
      });
      await expect(
        fixture.owned.run(() => {
          return fixture.runs.readRun(fixture.owned.actor, oldLinkRun.runId);
        }),
      ).resolves.toMatchObject({ status: "completed", artifactResult: null });

      const revision = await fixture.owned.run(() => {
        return fixture.runs.createThreadRun(fixture.owned.actor, {
          agentId: fixture.owned.agentId,
          threadId: fixture.run.threadId,
          prompt: "Publish a new revision of the report",
          model: fixture.owned.model,
        });
      });
      const execution = await fixture.owned.executionInput(revision.runId);
      const bearerToken = okouTokenFromExecution(execution);
      const updated = "<main>A revised report</main>";
      await fixture.owned.run(async () => {
        const publication = await host.prepareHostedSite(
          { bearerToken },
          {
            site,
            title: "Revised artifact outcome report",
            artifactKind: "hosted-site",
            spaFallback: false,
            visibility,
            files: [hostedTextFile("/index.html", updated)],
          },
        );
        await uploadHostedTextFiles(publication, { "/index.html": updated });
        await host.completeHostedSite(
          { bearerToken },
          publication.deploymentId,
        );
      });
      await fixture.owned.run(() => {
        return completePublicClaudeRun(
          context,
          revision,
          { authorization: `Bearer ${execution.sandboxToken}` },
          "The revised report is ready",
        );
      });
      await expect(
        fixture.owned.run(() => {
          return fixture.runs.readRun(fixture.owned.actor, revision.runId);
        }),
      ).resolves.toMatchObject({
        status: "completed",
        artifactResult: "success",
      });
      mockNow(new Date(now() + 60_000));
      await fixture.owned.run(() => {
        return host.completeHostedSite(
          { bearerToken: fixture.bearerToken },
          first.deploymentId,
        );
      });
      await expect(fixture.read()).resolves.toMatchObject({
        artifactResult: "success",
      });
    },
  );
});
