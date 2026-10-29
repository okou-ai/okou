import { randomUUID } from "node:crypto";
import {
  AbortMultipartUploadCommand,
  CreateMultipartUploadCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { artifactDownloadsContract } from "@okouai/api-contracts/contracts/artifact-downloads";
import { artifactReferencesContract } from "@okouai/api-contracts/contracts/artifact-references";
import { uploadsContract } from "@okouai/api-contracts/contracts/uploads";
import { webFilesContract } from "@okouai/api-contracts/contracts/web-files";
import { expect, test } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { artifactDownloadRoutes } from "../artifact-downloads";
import { artifactReferenceRoutes } from "../artifact-references";
import { uploadsPrepareRoutes } from "../uploads-prepare";
import { webFileUrlRoutes } from "../web-file-url";
import { createBddApi } from "./helpers/api-bdd";
import { createHostBddApi } from "./helpers/api-bdd-host";
import { hostedTextFile } from "./helpers/api-bdd-host-files";
import { installArtifactReferenceStorage } from "./helpers/artifact-reference-storage";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const mocks = createRouteMocks(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const upload = Object.freeze({
  filename: "confidential-report.txt",
  contentType: "text/plain",
  size: 13,
});

function api() {
  return setupApp({
    context,
    routes: [
      ...uploadsPrepareRoutes,
      ...webFileUrlRoutes,
      ...artifactReferenceRoutes,
      ...artifactDownloadRoutes,
    ],
  });
}

function providerError(responseOnly = false) {
  const error = Object.assign(new Error("UnknownError"), {
    name: "Unknown",
    $metadata: {
      ...(responseOnly ? {} : { httpStatusCode: 500 }),
      attempts: 3,
      totalRetryDelay: 122,
      requestId: "provider-request-id",
    },
  });
  Object.defineProperty(error, "$response", {
    value: {
      statusCode: 500,
      headers: { "x-private": "private-response-header" },
      body: "private-response-body",
    },
  });
  return Object.freeze(error);
}

function expectRedactedFailure(
  error: Error,
  expected: Readonly<Record<string, unknown>>,
  privateValues: readonly string[],
) {
  const s3 = {
    ...expected,
    httpStatus: 500,
    attempts: 3,
    retryDelayMs: 122,
    providerRequestId: "provider-request-id",
  };
  expect(context.mocks.sentry.captureException).toHaveBeenLastCalledWith(
    error,
    {
      extra: { s3 },
    },
  );
  const reported = JSON.stringify(
    context.mocks.sentry.captureException.mock.lastCall?.[1],
  );
  for (const value of [
    ...privateValues,
    "private-response-header",
    "private-response-body",
  ]) {
    expect(reported).not.toContain(value);
  }
}

// Exercise the real callers and the external exception reporter's redacted
// context. Logger internals and request-log wiring are not observed here.
test("retains redacted S3 failure context across file reads, upload preparation and publication", async () => {
  mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
  mocks.s3.listObjects([]);
  installArtifactReferenceStorage(context);
  const prepared = await accept(
    api()(uploadsContract).preparePrivate({ headers, body: upload }),
    [200],
  );
  const reference = new URL(prepared.body.url).pathname.split("/").at(-1)!;
  const storage = context.mocks.s3.send.getMockImplementation()!;
  const reads = [
    {
      phase: "resolve_web_file",
      request: async () => {
        await expect(
          api()(webFilesContract).fileUrl({
            headers,
            query: { file_id: prepared.body.id },
          }),
        ).rejects.toThrow(
          "Unknown response status 500 for GET /api/web/file-url",
        );
      },
    },
    {
      phase: "resolve_artifact_reference",
      request: async () => {
        const failed = await accept(
          api()(artifactReferencesContract).resolve({
            headers,
            params: { reference },
          }),
          [500],
        );
        expect(failed.body).toStrictEqual({ error: "Internal server error" });
      },
    },
    {
      phase: "download_artifact",
      request: async () => {
        const failed = await accept(
          api()(artifactDownloadsContract).download({
            headers,
            params: { reference },
          }),
          [500],
        );
        expect(failed.body).toStrictEqual({ error: "Internal server error" });
      },
    },
  ];
  for (const [index, read] of reads.entries()) {
    const responseOnly = index === 1;
    const error = providerError(responseOnly);
    context.mocks.s3.send.mockImplementation((command) => {
      if (command instanceof HeadObjectCommand) {
        return Promise.reject(error);
      }
      return storage(command);
    });
    await read.request();
    expectRedactedFailure(
      error,
      {
        command: "HeadObject",
        execution: "request",
        operationOutcome: "read_failed",
        apiPhase: read.phase,
        httpStatusSource: responseOnly ? "sdk_response" : "sdk_metadata",
      },
      [upload.filename, prepared.body.id, "test-private-artifacts"],
    );
  }

  const allocationError = providerError();
  context.mocks.s3.send.mockRejectedValue(allocationError);
  await accept(
    api()(uploadsContract).preparePrivate({ headers, body: upload }),
    [500],
  );
  expectRedactedFailure(
    allocationError,
    {
      command: "PutObject",
      execution: "request",
      operationOutcome: "mutation_outcome_unknown",
      apiPhase: "allocate_upload",
      completedSteps: [],
      httpStatusSource: "sdk_metadata",
    },
    [upload.filename, "test-private-artifacts", "artifact-references/"],
  );

  const multipartError = providerError();
  context.mocks.s3.send.mockImplementation((command) => {
    return command instanceof CreateMultipartUploadCommand
      ? Promise.reject(multipartError)
      : storage(command);
  });
  await accept(
    api()(uploadsContract).preparePrivate({
      headers,
      body: { ...upload, size: 5 * 1024 * 1024, multipart: true },
    }),
    [500],
  );
  expectRedactedFailure(
    multipartError,
    {
      command: "CreateMultipartUpload",
      execution: "request",
      operationOutcome: "mutation_outcome_unknown",
      apiPhase: "create_multipart_upload",
      completedSteps: ["artifact_allocation"],
      httpStatusSource: "sdk_metadata",
    },
    [upload.filename, "test-private-artifacts"],
  );

  const host = createHostBddApi(context);
  const actor = createBddApi(context).user();
  host.captureHostedSitesS3();
  const site = `failure-context-${randomUUID().slice(0, 8)}`;
  const deployment = await host.prepareHostedSite(actor, {
    site,
    artifactKind: "hosted-site",
    spaFallback: false,
    files: [hostedTextFile("/index.html", "<main>Private content</main>")],
  });
  const hostedStorage = context.mocks.s3.send.getMockImplementation()!;
  const publicationError = providerError();
  context.mocks.s3.send.mockImplementation(async (command) => {
    const stored = await hostedStorage(command);
    if (
      command instanceof PutObjectCommand &&
      command.input.Key?.endsWith("/active.json")
    ) {
      throw publicationError;
    }
    return stored;
  });
  await host.requestCompleteHostedSite(actor, deployment.deploymentId, [500]);
  expectRedactedFailure(
    publicationError,
    {
      command: "PutObject",
      execution: "request",
      operationOutcome: "mutation_outcome_unknown",
      apiPhase: "promote_deployment",
      publicationThisAttempt: "unknown",
      deploymentStatusBeforeAttempt: "uploading",
      completedSteps: ["manifest_write"],
      httpStatusSource: "sdk_metadata",
    },
    [deployment.deploymentId, deployment.siteId, "test-hosted-sites"],
  );
  const pending = await host.readHostedSiteDeployments(actor, site);
  expect(pending.activeDeploymentId).toBeNull();
  expect(pending.deployments[0]?.status).toBe("uploading");
  context.mocks.s3.send.mockImplementation(hostedStorage);
  await host.completeHostedSite(actor, deployment.deploymentId);
  const completed = await host.readHostedSiteDeployments(actor, site);
  expect(completed.activeDeploymentId).toBe(deployment.deploymentId);
  expect(completed.deployments[0]?.status).toBe("ready");
});

test("cleans up an acknowledged multipart session when part signing fails", async () => {
  mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
  const sessions = new Set<string>();
  const lifecycle: string[] = [];
  context.mocks.s3.send.mockImplementation((command) => {
    if (command instanceof PutObjectCommand) {
      return Promise.resolve({});
    }
    if (command instanceof CreateMultipartUploadCommand) {
      sessions.add("created-upload");
      lifecycle.push("created");
      return Promise.resolve({ UploadId: "created-upload" });
    }
    if (command instanceof AbortMultipartUploadCommand) {
      sessions.delete(command.input.UploadId!);
      lifecycle.push("aborted");
      return Promise.resolve({});
    }
    throw new Error("Unexpected storage operation");
  });
  context.mocks.s3.getSignedUrl.mockRejectedValue(providerError());
  const failed = await accept(
    api()(uploadsContract).preparePrivate({
      headers,
      body: { ...upload, size: 5 * 1024 * 1024, multipart: true },
    }),
    [500],
  );
  expect(failed.body).toStrictEqual({ error: "Internal server error" });
  expect(lifecycle).toStrictEqual(["created", "aborted"]);
  expect(sessions.size).toBe(0);
});

test("preserves an active deployment when a repeated completion cannot read storage", async () => {
  const host = createHostBddApi(context);
  const actor = createBddApi(context).user();
  host.captureHostedSitesS3();
  const site = `read-failure-${randomUUID().slice(0, 8)}`;
  const deployment = await host.prepareHostedSite(actor, {
    site,
    artifactKind: "hosted-site",
    spaFallback: false,
    files: [hostedTextFile("/index.html", "<main>Published</main>")],
  });
  await host.completeHostedSite(actor, deployment.deploymentId);
  const storage = context.mocks.s3.send.getMockImplementation()!;
  context.mocks.s3.send.mockImplementation((command) => {
    return command instanceof HeadObjectCommand
      ? Promise.reject(providerError())
      : storage(command);
  });
  await host.requestCompleteHostedSite(actor, deployment.deploymentId, [500]);
  const listed = await host.readHostedSiteDeployments(actor, site);
  expect(listed.activeDeploymentId).toBe(deployment.deploymentId);
  expect(listed.deployments[0]?.status).toBe("ready");
});
