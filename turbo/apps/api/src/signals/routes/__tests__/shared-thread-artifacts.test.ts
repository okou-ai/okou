import { mockGoogleText, VERTEX_TEXT_URL } from "./helpers/google-text";
import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import {
  CopyObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { beforeEach, expect, onTestFinished, test } from "vitest";
import { http, HttpResponse } from "msw";
import { z } from "zod";
import sharp from "sharp";
import { server } from "../../../mocks/server";
import { createDeferredPromise } from "../../utils";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { ARTIFACT_OG_BRAND } from "@okouai/core/artifact-og";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { artifactSharesContract } from "@okouai/api-contracts/contracts/artifact-shares";
import { artifactOgContract } from "@okouai/api-contracts/contracts/artifact-og";
import { artifactDownloadsContract } from "@okouai/api-contracts/contracts/artifact-downloads";
import {
  artifactReferencePath,
  artifactReferencesContract,
} from "@okouai/api-contracts/contracts/artifact-references";
import { sharedThreadsContract } from "@okouai/api-contracts/contracts/shared-threads";
import { sharedThreadArtifactPolicySchema } from "@okouai/api-contracts/contracts/shared-thread-artifacts";
import { uploadsContract } from "@okouai/api-contracts/contracts/uploads";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { artifactShareRoutes } from "../artifact-shares";
import { artifactOgRoutes } from "../artifact-og";
import { artifactReferenceRoutes } from "../artifact-references";
import { artifactDownloadRoutes } from "../artifact-downloads";
import { featureSwitchesRoutes } from "../feature-switches";
import { sharedThreadRoutes } from "../shared-threads";
import { uploadsPrepareRoutes } from "../uploads-prepare";
import { uploadsCompleteRoutes } from "../uploads-complete";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { okouTokenFromClaim } from "./helpers/chat-events-fixture";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createRouteMocks } from "./helpers/route-test";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";

const context = testContext();
const bdd = createBddApi(context);
const chat = createChatFilesBddApi(context);
const runs = createRunsApi(context);
const mocks = createRouteMocks(context);

beforeEach(() => {
  mockOptionalEnv("GCP_LLM_PROJECT_ID", undefined);
  mockEnv("OKOU_API_BACKEND_URL", "https://api.okou.ai");
  mockEnv("APP_URL", "https://app.okou.ai");
  mockEnv("R2_HOSTED_SITES_ACCESS_KEY_ID", "snapshot-hosted-key");
  mockEnv("R2_PRIVATE_ARTIFACTS_ACCESS_KEY_ID", "snapshot-private-key");
});

function api(rethrowErrors = false) {
  return setupApp({
    context,
    rethrowErrors,
    routes: [
      ...sharedThreadRoutes,
      ...featureSwitchesRoutes,
      ...artifactShareRoutes,
      ...artifactOgRoutes,
      ...artifactReferenceRoutes,
      ...artifactDownloadRoutes,
      ...uploadsPrepareRoutes,
      ...uploadsCompleteRoutes,
    ],
  });
}

function headers(actor: ApiTestUser) {
  mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
  return { authorization: "Bearer clerk-session" };
}

async function flag(actor: ApiTestUser, enabled: boolean) {
  await accept(
    api()(featureSwitchesContract).update({
      headers: headers(actor),
      body: { switches: { [FeatureSwitchKey.PrivateArtifacts]: enabled } },
    }),
    [200],
  );
}

async function fixture() {
  const actor = bdd.user();
  context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
    {
      data: [
        {
          publicUserData: { userId: actor.userId },
          organization: { id: actor.orgId, name: "Resource snapshots" },
        },
      ],
      totalCount: 1,
    },
  );
  bdd.acceptAgentStorageWrites();
  runs.acceptStorageDownloads();
  runs.acceptTelemetryIngest();
  const runnerGroup = runs.configureRunnerGroup();
  await runs.grantProEntitlement(actor);
  await runs.ensurePersonalSubscriptionModel(actor);
  const agent = await bdd.createAgent(actor, {
    displayName: "Resource snapshot",
  });
  const originalSend = context.mocks.s3.send.getMockImplementation();
  const objects = new Map<string, Buffer>();
  const failedWrites = new Set<string>();
  const etag = (body: Buffer) => {
    return `"${createHash("md5").update(body).digest("hex")}"`;
  };
  const missing = () => {
    return Object.assign(new Error("Object unavailable"), {
      name: "NoSuchKey",
      $metadata: { httpStatusCode: 404 },
    });
  };
  const copies: { source: string; destination: string }[] = [];

  context.mocks.s3.getSignedUrl.mockImplementation(
    (client: unknown, command: unknown) => {
      if (!(
        command instanceof PutObjectCommand ||
        command instanceof GetObjectCommand
      )) {
        throw new Error("Unexpected presign operation");
      }
      const url = new URL(
        `https://test.r2.cloudflarestorage.com/${command.input.Bucket}/${command.input.Key}?X-Amz-Signature=fixture`,
      );
      const configured = z
        .object({
          config: z.object({
            credentials: z.object({ accessKeyId: z.string() }),
          }),
        })
        .parse(client);
      url.searchParams.set(
        "X-Amz-Credential",
        configured.config.credentials.accessKeyId,
      );
      if (
        command instanceof GetObjectCommand &&
        command.input.ResponseContentDisposition
      ) {
        url.searchParams.set(
          "response-content-disposition",
          command.input.ResponseContentDisposition,
        );
      }
      return Promise.resolve(url.href);
    },
  );
  function putSnapshotObject(command: PutObjectCommand) {
    const key = `${command.input.Bucket}/${command.input.Key}`;
    if (failedWrites.has(key)) {
      return Promise.reject(new Error("Storage write unavailable"));
    }
    const previous = objects.get(key);
    if (
      (command.input.IfNoneMatch === "*" && previous) ||
      (command.input.IfMatch &&
        (!previous || etag(previous) !== command.input.IfMatch))
    ) {
      return Promise.reject(
        Object.assign(new Error("Revision conflict"), {
          name: "PreconditionFailed",
        }),
      );
    }
    if (
      !Buffer.isBuffer(command.input.Body) &&
      typeof command.input.Body !== "string"
    ) {
      throw new Error("Unexpected object body");
    }
    objects.set(key, Buffer.from(command.input.Body));
    return Promise.resolve({});
  }

  function readSnapshotObject(command: GetObjectCommand | HeadObjectCommand) {
    const body = objects.get(`${command.input.Bucket}/${command.input.Key}`);
    if (!body) {
      return Promise.reject(missing());
    }
    if (command.input.IfMatch && command.input.IfMatch !== etag(body)) {
      return Promise.reject(
        Object.assign(new Error("Source changed"), {
          name: "PreconditionFailed",
        }),
      );
    }
    return Promise.resolve({
      ...(command instanceof GetObjectCommand
        ? { Body: Readable.from([body]) }
        : {}),
      ETag: etag(body),
      ContentLength: body.length,
      Metadata: {
        "artifact-id": command.input.Key?.split("/")[1],
        sha256: createHash("sha256").update(body).digest("hex"),
      },
    });
  }

  context.mocks.s3.send.mockImplementation((command: unknown) => {
    if (command instanceof CopyObjectCommand) {
      const source = decodeURIComponent(command.input.CopySource!);
      const destination = `${command.input.Bucket}/${command.input.Key}`;
      const body = objects.get(source);
      if (!body) {
        return Promise.reject(missing());
      }
      if (
        command.input.CopySourceIfMatch &&
        command.input.CopySourceIfMatch !== etag(body)
      ) {
        return Promise.reject(
          Object.assign(new Error("Source changed"), {
            name: "PreconditionFailed",
          }),
        );
      }
      copies.push({ source, destination });
      objects.set(destination, Buffer.from(body));
      return Promise.resolve({});
    }
    if (command instanceof DeleteObjectsCommand) {
      for (const object of command.input.Delete?.Objects ?? []) {
        objects.delete(`${command.input.Bucket}/${object.Key}`);
      }
      return Promise.resolve({});
    }
    if (
      command instanceof PutObjectCommand &&
      (command.input.Bucket === "test-hosted-sites" ||
        command.input.Bucket === "test-private-artifacts")
    ) {
      return putSnapshotObject(command);
    }
    if (
      (command instanceof GetObjectCommand ||
        command instanceof HeadObjectCommand) &&
      (command.input.Bucket === "test-hosted-sites" ||
        command.input.Bucket === "test-private-artifacts")
    ) {
      return readSnapshotObject(command);
    }
    if (
      command instanceof ListObjectsV2Command &&
      command.input.Bucket === "test-hosted-sites"
    ) {
      return Promise.resolve({ Contents: [] });
    }
    if (!originalSend) {
      throw new Error("Unexpected storage request");
    }
    return originalSend(command);
  });
  server.use(
    http.get("https://test.r2.cloudflarestorage.com/*", ({ request }) => {
      const url = new URL(request.url);
      const key = decodeURIComponent(url.pathname.slice(1));
      const credential = key.startsWith("test-hosted-sites/")
        ? "snapshot-hosted-key"
        : "snapshot-private-key";
      if (url.searchParams.get("X-Amz-Credential") !== credential) {
        return new HttpResponse("AccessDenied", { status: 403 });
      }
      const body = objects.get(key);
      const disposition = url.searchParams.get("response-content-disposition");
      return body
        ? new HttpResponse(new Uint8Array(body), {
            headers: disposition ? { "Content-Disposition": disposition } : {},
          })
        : new HttpResponse(null, { status: 404 });
    }),
  );
  await flag(actor, true);

  async function upload(
    owner = actor,
    content: string | Buffer = "Original generated PDF",
    options: {
      filename?: string;
      contentType?: string;
      bearerToken?: string;
    } = {},
  ) {
    const prepared = await accept(
      api()(uploadsContract).prepare({
        headers: headers(owner),
        body: {
          filename: options.filename ?? "report.pdf",
          contentType: options.contentType ?? "application/pdf",
          size: Buffer.byteLength(content),
          purpose: "artifact",
        },
      }),
      [200],
    );
    if (!("uploadUrl" in prepared.body)) {
      throw new Error("Expected a single upload");
    }
    const key = decodeURIComponent(
      new URL(prepared.body.uploadUrl).pathname.slice(1),
    );
    objects.set(key, Buffer.from(content));
    await accept(
      api()(uploadsContract).complete({
        headers: options.bearerToken
          ? { authorization: `Bearer ${options.bearerToken}` }
          : headers(owner),
        body: { id: prepared.body.id },
      }),
      [200],
    );
    return { id: prepared.body.id, url: prepared.body.url, key };
  }

  async function selection(
    content: string,
    omitted = "Unselected private information",
  ) {
    const { threadId, runId } = await chat.sendAndLaunch(actor, {
      agentId: agent.agentId,
      prompt: content,
    });
    await chat.requestSendEvent(
      actor,
      { agentId: agent.agentId, threadId, prompt: omitted },
      [201],
    );
    await flushWaitUntilForTest();
    const { events } = await chat.listThreadEvents(actor, threadId);
    const event = events.find((entry) => {
      return entry.eventType === "input.prompt" && entry.runId === runId;
    });
    if (!event) {
      throw new Error("Expected selected message");
    }
    return { threadId, runId, eventId: event.id, content };
  }

  return {
    actor,
    runnerGroup,
    objects,
    copies,
    failedWrites,
    upload,
    selection,
  };
}

function share(
  actor: ApiTestUser,
  selection: { threadId: string; eventId: string },
  options?: { signal: AbortSignal; rethrowErrors: boolean; id?: string },
) {
  return api(options?.rethrowErrors)(sharedThreadsContract).create({
    fetchOptions: { signal: options?.signal },
    headers: headers(actor),
    params: { threadId: selection.threadId },
    body: { eventIds: [selection.eventId], id: options?.id },
  });
}

function referenceName(url: string): string {
  return new URL(url, "https://app.okou.ai").pathname.slice(
    "/artifacts/".length,
  );
}

test("copies only selected artifacts, rewrites the snapshot, and preserves source messages and permissions", async () => {
  const f = await fixture();
  const file = await f.upload();
  const other = await f.upload(f.actor, "Unselected document");
  const selection = await f.selection(
    `[Report](${file.url}) and ${file.url}`,
    `[Unselected](${other.url})`,
  );
  const created = await accept(share(f.actor, selection), [201]);
  const shared = await accept(
    api()(sharedThreadsContract).get({ params: { id: created.body.id } }),
    [200],
  );
  const content = shared.body.messages[0]!.content;
  const urls = content.match(
    /https:\/\/app\.okou\.ai\/artifacts\/[a-z0-9]{10}\.pdf/gu,
  );
  expect(urls).toHaveLength(2);
  expect(new Set(urls).size).toBe(1);
  expect(urls![0]).not.toBe(new URL(file.url, "https://app.okou.ai").href);
  expect(content).not.toContain("Signature");
  expect(
    f.copies.filter((copy) => {
      return copy.source === file.key;
    }),
  ).toHaveLength(1);
  expect(
    f.copies.some((copy) => {
      return copy.source === other.key;
    }),
  ).toBeFalsy();
  const copy = f.copies.find((entry) => {
    return entry.source === file.key;
  })!;
  f.objects.set(file.key, Buffer.from("Changed original"));
  const resolved = await accept(
    api()(artifactReferencesContract).resolve({
      params: { reference: referenceName(urls![0]!) },
    }),
    [200],
  );
  expect(resolved.body.url).toContain(copy.destination);
  await expect((await fetch(resolved.body.url)).text()).resolves.toBe(
    "Original generated PDF",
  );
  const source = await chat.listThreadEvents(f.actor, selection.threadId);
  expect(JSON.stringify(source.events)).toContain(file.url);
  expect(JSON.stringify(source.events)).not.toContain(urls![0]);
  context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
    {
      data: [
        {
          publicUserData: { userId: f.actor.userId },
          organization: { id: f.actor.orgId, name: "Owner organization" },
        },
      ],
    },
  );
  const status = await accept(
    api()(artifactSharesContract).status({
      headers: headers(f.actor),
      body: { kind: "file", id: file.id },
    }),
    [200],
  );
  expect(status.body.audience).toBe("private");
  const meta = await accept(
    api()(sharedThreadsContract).meta({ params: { id: created.body.id } }),
    [200],
  );
  expect(meta.headers.get("cache-control")).toBe("no-store");
});

test("leaves ordinary relative API paths unchanged", async () => {
  const f = await fixture();
  const content = "The client calls /api/users before rendering.";
  const selection = await f.selection(content);
  const created = await accept(share(f.actor, selection), [201]);
  const shared = await accept(
    api()(sharedThreadsContract).get({ params: { id: created.body.id } }),
    [200],
  );
  expect(shared.body.messages[0]!.content).toBe(content);
  expect(f.copies).toStrictEqual([]);
});

test("preserves existing snapshot links and qualifies hostless ones when sharing them again", async () => {
  const f = await fixture();
  const file = await f.upload();
  const originalSelection = await f.selection(file.url);
  const first = await accept(share(f.actor, originalSelection), [201]);
  const firstView = await accept(
    api()(sharedThreadsContract).get({ params: { id: first.body.id } }),
    [200],
  );
  const snapshotUrl = firstView.body.messages[0]!.content;
  const source = `${snapshotUrl} ${new URL(snapshotUrl).pathname}`;
  const secondSelection = await f.selection(source);
  const second = await accept(share(f.actor, secondSelection), [201]);
  const secondView = await accept(
    api()(sharedThreadsContract).get({ params: { id: second.body.id } }),
    [200],
  );
  expect(secondView.body.messages[0]!.content).toBe(
    `${snapshotUrl} ${snapshotUrl}`,
  );
  expect(f.copies).toHaveLength(1);
  const original = await chat.listThreadEvents(
    f.actor,
    secondSelection.threadId,
  );
  expect(JSON.stringify(original.events)).toContain(source);
  await accept(
    api()(sharedThreadsContract).delete({
      headers: headers(f.actor),
      params: { id: first.body.id },
    }),
    [204],
  );
  await accept(
    api()(sharedThreadsContract).get({ params: { id: second.body.id } }),
    [200],
  );
  await accept(
    api()(artifactReferencesContract).resolve({
      params: { reference: referenceName(snapshotUrl) },
    }),
    [404],
  );
});

test("resolves a public snapshot to copied bytes without exposing its private source or management APIs", async () => {
  const f = await fixture();
  const file = await f.upload();
  const selection = await f.selection(file.url);
  const created = await accept(share(f.actor, selection), [201]);
  const shared = await accept(
    api()(sharedThreadsContract).get({ params: { id: created.body.id } }),
    [200],
  );
  const reference = referenceName(shared.body.messages[0]!.content);
  const resolved = await accept(
    api()(artifactReferencesContract).resolve({ params: { reference } }),
    [200],
  );
  expect(resolved.body).toMatchObject({
    filename: "report.pdf",
    contentType: "application/pdf",
  });
  expect(resolved.body).not.toHaveProperty("previewImageUrl");
  expect(resolved.body.url).toContain(`/thread-shares/${created.body.id}/`);
  expect(resolved.body.url).toContain("X-Amz-Signature=");
  expect(resolved.headers.get("cache-control")).toBe("private, no-store");
  const outsider = bdd.user({ orgId: null });
  const downloads = api()(artifactDownloadsContract);
  const download = () => {
    return downloads.download({
      headers: headers(outsider),
      params: { reference },
    });
  };
  const downloaded = await accept(download(), [200]);
  expect(downloaded.body).toStrictEqual({
    kind: "file",
    filename: "report.pdf",
    contentType: "application/pdf",
    url: resolved.body.url,
  });
  const cloneFile = await accept(
    downloads.files({
      headers: headers(outsider),
      params: { reference },
    }),
    [404],
  );
  expect(cloneFile.body).not.toHaveProperty("files");
  expect(cloneFile.body).not.toHaveProperty("url");
  const published = await accept(
    api()(artifactReferencesContract).publicUrl({ params: { reference } }),
    [200],
  );
  expect(published.body).toMatchObject({
    url: resolved.body.url,
    preview: { filename: "report.pdf", contentType: "application/pdf" },
  });
  expect(published.body.preview).not.toHaveProperty("previewImageUrl");
  await accept(
    api()(artifactReferencesContract).resolve({
      params: { reference: referenceName(file.url) },
    }),
    [401],
  );
  await accept(
    api()(artifactReferencesContract).publicUrl({
      params: { reference: referenceName(file.url) },
    }),
    [404],
  );
  for (const kind of ["file", "html", "artifact"] as const) {
    await accept(
      api()(artifactReferencesContract).resolve({
        headers: headers(f.actor),
        params: { reference },
        query: { kind },
      }),
      [404],
    );
  }
  f.objects.delete(file.key);
  const retained = await accept(
    api()(artifactReferencesContract).resolve({ params: { reference } }),
    [200],
  );
  await expect((await fetch(retained.body.url)).text()).resolves.toBe(
    "Original generated PDF",
  );
  const retainedDownload = await accept(download(), [200]);
  expect(retainedDownload.body).toStrictEqual(downloaded.body);
  await accept(
    api()(sharedThreadsContract).delete({
      headers: headers(f.actor),
      params: { id: created.body.id },
    }),
    [204],
  );
  const revokedDownload = await accept(download(), [404]);
  expect(revokedDownload.body).not.toHaveProperty("url");
});

async function markdownRenderer(
  options: {
    fail?: boolean;
    invalidImage?: boolean;
    beforeResponse?: () => Promise<void>;
  } = {},
) {
  mockEnv("CLOUDFLARE_BROWSER_RENDERING_API_TOKEN", "markdown-test-token");
  const image = await sharp({
    create: {
      width: options.invalidImage ? 32 : 1200,
      height: options.invalidImage ? 20 : 630,
      channels: 3,
      background: "#f2e8dc",
    },
  })
    .png()
    .toBuffer();
  const requests: {
    html: string;
    rejectRequestPattern: string[];
    viewport: { width: number; height: number };
  }[] = [];
  server.use(
    http.post(
      "https://api.cloudflare.com/client/v4/accounts/:account/browser-rendering/snapshot",
      async ({ request }) => {
        const body = z
          .object({
            html: z.string(),
            rejectRequestPattern: z.array(z.string()),
            viewport: z.object({ width: z.number(), height: z.number() }),
          })
          .parse(await request.json());
        requests.push(body);
        await options.beforeResponse?.();
        if (options.fail) {
          return new HttpResponse(null, { status: 503 });
        }
        return HttpResponse.json({
          success: true,
          result: { content: body.html, screenshot: image.toString("base64") },
        });
      },
    ),
  );
  return { image, requests };
}

async function enableMarkdownCovers(actor: ApiTestUser, enabled: boolean) {
  await accept(
    api()(featureSwitchesContract).update({
      headers: headers(actor),
      body: { switches: { artifactPreviews: enabled } },
    }),
    [200],
  );
  await flushWaitUntilForTest();
}

async function markdownImageQuery(reference: string) {
  const target = { kind: "reference" as const, id: reference };
  const metadata = await accept(
    api()(artifactOgContract).metadata({ query: target }),
    [200],
  );
  if (!metadata.body.available) {
    throw new Error("Expected public Markdown metadata");
  }
  return {
    ...target,
    version: new URL(metadata.body.imageUrl).searchParams.get("version")!,
  };
}

async function markdownPublishedText(reference: string): Promise<string> {
  const outsider = bdd.user({ orgId: null });
  const download = await accept(
    api()(artifactDownloadsContract).download({
      headers: headers(outsider),
      params: { reference },
    }),
    [200],
  );
  if (download.body.kind !== "file") {
    throw new Error("Expected a Markdown file download");
  }
  const response = await fetch(download.body.url);
  expect(response.status).toBe(200);
  return response.text();
}

const markdownContent =
  "# Quarterly review 季度回顾\n\n**Revenue** grew 42%.\n\n| Team | Result |\n| --- | --- |\n| Sales | 42 |\n\n```ts\nconst result = 42;\n```\n";

test.each(["user", "agent"] as const)(
  "markdown covers use the immutable ordinary share for %s-created files",
  async (producer) => {
    const f = await fixture();
    const renderer = await markdownRenderer();
    await enableMarkdownCovers(f.actor, true);
    let bearerToken: string | undefined;
    if (producer === "agent") {
      const run = await f.selection("Create a Markdown artifact");
      await runs.heartbeatRunner(f.runnerGroup);
      bearerToken = okouTokenFromClaim(await runs.claimRunnerJob(run.runId));
    }
    const source = await f.upload(f.actor, markdownContent, {
      filename: "review.md",
      contentType: "text/markdown",
      bearerToken,
    });
    const target = { kind: "file" as const, id: source.id };
    const published = await accept(
      api()(artifactSharesContract).update({
        headers: headers(f.actor),
        body: { target, audience: "public" },
      }),
      [200],
    );
    // The background task must read the publication copy, never this later mutation.
    f.objects.set(source.key, Buffer.from("# Later private changes"));
    await flushWaitUntilForTest();
    expect(renderer.requests).toHaveLength(1);
    expect(renderer.requests[0]!.html).toContain(
      "<h1>Quarterly review 季度回顾</h1>",
    );
    expect(renderer.requests[0]!.html).not.toContain("Later private changes");
    expect(renderer.requests[0]!.rejectRequestPattern).toStrictEqual([".*"]);
    expect(renderer.requests[0]!.viewport).toStrictEqual({
      width: 1200,
      height: 630,
    });
    const reference = referenceName(source.url);
    const query = await markdownImageQuery(reference);
    expect(query.version).toContain(":");
    const image = await accept(
      api()(artifactOgContract).image({ query }),
      [200],
    );
    const bytes = Buffer.from(await image.body.arrayBuffer());
    await expect(sharp(bytes).metadata()).resolves.toMatchObject({
      width: 1200,
      height: 630,
    });
    const raw = await accept(
      api()(artifactReferencesContract).publicUrl({ params: { reference } }),
      [200],
    );
    expect(raw.body.preview).toMatchObject({
      filename: "review.md",
      contentType: "text/markdown",
    });
    await expect(markdownPublishedText(reference)).resolves.toBe(
      markdownContent,
    );
    expect(published.body.ownerUrl).toBe(source.url);
    const sourceFingerprint = createHash("sha256")
      .update(markdownContent)
      .digest("hex");
    const policies = [...f.objects.entries()].filter(([key]) => {
      return key.includes("artifact-shares/");
    });
    expect(
      policies.some(([, bytes]) => {
        return bytes.toString().includes(sourceFingerprint);
      }),
    ).toBeTruthy();
    await accept(
      api()(artifactSharesContract).status({
        headers: headers(f.actor),
        body: target,
      }),
      [200],
    );
    await flushWaitUntilForTest();
    expect(renderer.requests).toHaveLength(1);
    await enableMarkdownCovers(f.actor, false);
    const disabled = await accept(
      api()(artifactOgContract).image({ query }),
      [302],
    );
    expect(disabled.headers.get("location")).toBe(ARTIFACT_OG_BRAND.imageUrl);
    expect(disabled.headers.get("cache-control")).toBe("private, no-store");
    await enableMarkdownCovers(f.actor, true);
    await accept(api()(artifactOgContract).image({ query }), [200]);
    for (const audience of ["organization", "private"] as const) {
      await accept(
        api()(artifactSharesContract).update({
          headers: headers(f.actor),
          body: { target, audience },
        }),
        [200],
      );
      await accept(api()(artifactOgContract).image({ query }), [302]);
    }
    await flushWaitUntilForTest();
  },
);

test("markdown covers catch up files shared while OFF without re-uploading and invalidate pending image URLs", async () => {
  const f = await fixture();
  const entered = createDeferredPromise<void>(context.signal);
  const release = createDeferredPromise<void>(context.signal);
  onTestFinished(() => {
    if (!release.settled()) {
      release.resolve(undefined);
    }
  });
  const renderer = await markdownRenderer({
    beforeResponse: async () => {
      entered.resolve(undefined);
      await release.promise;
    },
  });
  await enableMarkdownCovers(f.actor, false);
  const source = await f.upload(f.actor, markdownContent, {
    filename: "review.markdown",
    contentType: "text/plain",
  });
  const target = { kind: "file" as const, id: source.id };
  await accept(
    api()(artifactSharesContract).update({
      headers: headers(f.actor),
      body: { target, audience: "public" },
    }),
    [200],
  );
  await flushWaitUntilForTest();
  expect(renderer.requests).toHaveLength(0);
  const reference = referenceName(source.url);
  // Enabling queues work but metadata/image reads themselves never render.
  await accept(
    api()(featureSwitchesContract).update({
      headers: headers(f.actor),
      body: { switches: { artifactPreviews: true } },
    }),
    [200],
  );
  await entered.promise;
  const pending = await markdownImageQuery(reference);
  release.resolve(undefined);
  await flushWaitUntilForTest();
  const ready = await markdownImageQuery(reference);
  expect(ready.version).not.toBe(pending.version);
  await accept(api()(artifactOgContract).image({ query: pending }), [302]);
  await accept(api()(artifactOgContract).image({ query: ready }), [200]);
  expect(renderer.requests).toHaveLength(1);
  expect(f.objects.get(source.key)).toStrictEqual(Buffer.from(markdownContent));
});

test.each(["failure", "invalid-image"] as const)(
  "markdown cover %s leaves the original usable and bounds retries",
  async (outcome) => {
    const f = await fixture();
    const renderer = await markdownRenderer({
      fail: outcome === "failure",
      invalidImage: outcome === "invalid-image",
    });
    await enableMarkdownCovers(f.actor, true);
    const source = await f.upload(f.actor, markdownContent, {
      filename: "review.md",
      contentType: "text/markdown",
    });
    const target = { kind: "file" as const, id: source.id };
    await accept(
      api()(artifactSharesContract).update({
        headers: headers(f.actor),
        body: { target, audience: "public" },
      }),
      [200],
    );
    await flushWaitUntilForTest();
    const reference = referenceName(source.url);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await accept(
        api()(artifactSharesContract).status({
          headers: headers(f.actor),
          body: target,
        }),
        [200],
      );
      await flushWaitUntilForTest();
    }
    expect(renderer.requests).toHaveLength(2);
    await accept(
      api()(artifactOgContract).image({
        query: await markdownImageQuery(reference),
      }),
      [302],
    );
    await accept(
      api()(artifactReferencesContract).publicUrl({ params: { reference } }),
      [200],
    );
    await expect(markdownPublishedText(reference)).resolves.toBe(
      markdownContent,
    );
    expect(f.objects.get(source.key)).toStrictEqual(
      Buffer.from(markdownContent),
    );
  },
);

test("markdown covers cannot republish an ordinary grant revoked while rendering", async () => {
  const f = await fixture();
  const entered = createDeferredPromise<void>(context.signal);
  const release = createDeferredPromise<void>(context.signal);
  onTestFinished(() => {
    if (!release.settled()) {
      release.resolve(undefined);
    }
  });
  const renderer = await markdownRenderer({
    beforeResponse: async () => {
      entered.resolve(undefined);
      await release.promise;
    },
  });
  await enableMarkdownCovers(f.actor, true);
  const source = await f.upload(f.actor, markdownContent, {
    filename: "review.md",
    contentType: "text/markdown",
  });
  const target = { kind: "file" as const, id: source.id };
  await accept(
    api()(artifactSharesContract).update({
      headers: headers(f.actor),
      body: { target, audience: "public" },
    }),
    [200],
  );
  await entered.promise;
  await accept(
    api()(artifactSharesContract).update({
      headers: headers(f.actor),
      body: { target, audience: "private" },
    }),
    [200],
  );
  release.resolve(undefined);
  await flushWaitUntilForTest();
  expect(renderer.requests).toHaveLength(1);
  const metadata = await accept(
    api()(artifactOgContract).metadata({
      query: { kind: "reference", id: referenceName(source.url) },
    }),
    [200],
  );
  expect(metadata.body).toStrictEqual({ available: false });
  await accept(
    api()(artifactReferencesContract).publicUrl({
      params: { reference: referenceName(source.url) },
    }),
    [404],
  );
});

test("markdown covers belong to independent conversation snapshots, including existing OFF shares", async () => {
  const f = await fixture();
  const renderer = await markdownRenderer();
  await enableMarkdownCovers(f.actor, false);
  const source = await f.upload(f.actor, markdownContent, {
    filename: "review.md",
    contentType: "text/markdown",
  });
  const selection = await f.selection(source.url);
  const created = await accept(share(f.actor, selection), [201]);
  await flushWaitUntilForTest();
  expect(renderer.requests).toHaveLength(0);
  f.objects.delete(source.key);
  await enableMarkdownCovers(f.actor, true);
  const shared = await accept(
    api()(sharedThreadsContract).get({ params: { id: created.body.id } }),
    [200],
  );
  const reference = referenceName(shared.body.messages[0]!.content);
  const query = await markdownImageQuery(reference);
  await accept(api()(artifactOgContract).image({ query }), [200]);
  expect(renderer.requests).toHaveLength(1);
  expect(renderer.requests[0]!.html).toContain("Quarterly review 季度回顾");
  await enableMarkdownCovers(f.actor, false);
  await accept(api()(artifactOgContract).image({ query }), [302]);
  await enableMarkdownCovers(f.actor, true);
  await accept(api()(artifactOgContract).image({ query }), [200]);
  await accept(
    api()(sharedThreadsContract).delete({
      headers: headers(f.actor),
      params: { id: created.body.id },
    }),
    [204],
  );
  await accept(api()(artifactOgContract).image({ query }), [302]);
});

test("markdown conversation publication succeeds while its cover is pending or failed", async () => {
  const f = await fixture();
  const entered = createDeferredPromise<void>(context.signal);
  const release = createDeferredPromise<void>(context.signal);
  onTestFinished(() => {
    if (!release.settled()) {
      release.resolve(undefined);
    }
  });
  await markdownRenderer({
    fail: true,
    beforeResponse: async () => {
      entered.resolve(undefined);
      await release.promise;
    },
  });
  await enableMarkdownCovers(f.actor, true);
  const source = await f.upload(f.actor, markdownContent, {
    filename: "review.md",
    contentType: "text/markdown",
  });
  const selection = await f.selection(source.url);
  const created = await accept(share(f.actor, selection), [201]);
  await entered.promise;
  const shared = await accept(
    api()(sharedThreadsContract).get({ params: { id: created.body.id } }),
    [200],
  );
  const reference = referenceName(shared.body.messages[0]!.content);
  const raw = await accept(
    api()(artifactReferencesContract).publicUrl({ params: { reference } }),
    [200],
  );
  await expect((await fetch(raw.body.url)).text()).resolves.toBe(
    markdownContent,
  );
  release.resolve(undefined);
  await flushWaitUntilForTest();
  await accept(
    api()(sharedThreadsContract).get({ params: { id: created.body.id } }),
    [200],
  );
  await accept(
    api()(artifactOgContract).image({
      query: await markdownImageQuery(reference),
    }),
    [302],
  );
});

test.each([
  {
    label: "empty",
    filename: "empty.md",
    contentType: "text/markdown",
    content: Buffer.alloc(0),
  },
  {
    label: "oversized",
    filename: "large.md",
    contentType: "text/markdown",
    content: Buffer.alloc(256 * 1024 + 1, 65),
  },
  {
    label: "invalid UTF-8",
    filename: "invalid.md",
    contentType: "text/plain",
    content: Buffer.from([0xff, 0xfe, 0x41]),
  },
  {
    label: "HTML MIME",
    filename: "invalid.md",
    contentType: "text/html",
    content: Buffer.from("<h1>Not Markdown</h1>"),
  },
  {
    label: "PDF",
    filename: "report.pdf",
    contentType: "application/pdf",
    content: Buffer.from("PDF fixture"),
  },
  {
    label: "Excel",
    filename: "report.xlsx",
    contentType: "application/octet-stream",
    content: Buffer.from("Workbook fixture"),
  },
])(
  "markdown covers skip $label safely with unchanged downloads",
  async ({ filename, contentType, content }) => {
    const f = await fixture();
    const renderer = await markdownRenderer();
    await enableMarkdownCovers(f.actor, true);
    const source = await f.upload(f.actor, content, { filename, contentType });
    const reference = referenceName(source.url);
    const privateMetadata = await accept(
      api()(artifactOgContract).metadata({
        query: { kind: "reference", id: reference },
      }),
      [200],
    );
    expect(privateMetadata.body).toStrictEqual({ available: false });
    await accept(
      api()(artifactSharesContract).update({
        headers: headers(f.actor),
        body: { target: { kind: "file", id: source.id }, audience: "public" },
      }),
      [200],
    );
    await flushWaitUntilForTest();
    expect(renderer.requests).toHaveLength(0);
    await accept(
      api()(artifactOgContract).image({
        query: await markdownImageQuery(reference),
      }),
      [302],
    );
    expect(f.objects.get(source.key)).toStrictEqual(content);
  },
);

test("markdown covers deduplicate in-flight owner requests and keep internal covers private", async () => {
  const f = await fixture();
  const entered = createDeferredPromise<void>(context.signal);
  const release = createDeferredPromise<void>(context.signal);
  onTestFinished(() => {
    if (!release.settled()) {
      release.resolve(undefined);
    }
  });
  const renderer = await markdownRenderer({
    beforeResponse: async () => {
      if (!entered.settled()) {
        entered.resolve(undefined);
      }
      await release.promise;
    },
  });
  await enableMarkdownCovers(f.actor, true);
  const source = await f.upload(f.actor, markdownContent, {
    filename: "review.md",
    contentType: "text/markdown",
  });
  const target = { kind: "file" as const, id: source.id };
  await accept(
    api()(artifactSharesContract).update({
      headers: headers(f.actor),
      body: { target, audience: "public" },
    }),
    [200],
  );
  await entered.promise;
  await Promise.all(
    [0, 1, 2].map(async () => {
      await accept(
        api()(artifactSharesContract).status({
          headers: headers(f.actor),
          body: target,
        }),
        [200],
      );
    }),
  );
  release.resolve(undefined);
  await flushWaitUntilForTest();
  expect(renderer.requests).toHaveLength(1);
  const coverKey = [...f.objects.keys()].find((key) => {
    return (
      key.endsWith("/markdown-cover-v1.png") && !key.includes("/thread-shares/")
    );
  });
  if (!coverKey) {
    throw new Error("Expected a private cached Markdown cover");
  }
  const coverId = coverKey.split("/")[2]!;
  await accept(
    api()(artifactReferencesContract).publicUrl({
      params: {
        reference: referenceName(
          artifactReferencePath(coverId, "markdown-cover-v1.png"),
        ),
      },
    }),
    [404],
  );
  await accept(
    api()(artifactOgContract).image({
      query: await markdownImageQuery(referenceName(source.url)),
    }),
    [200],
  );
});

test("markdown covers admit an older owned conversation through authenticated file reads", async () => {
  const f = await fixture();
  const renderer = await markdownRenderer();
  await enableMarkdownCovers(f.actor, false);
  const source = await f.upload(f.actor, markdownContent, {
    filename: "review.md",
    contentType: "text/markdown",
  });
  const threadIds: string[] = [];
  const selection = await f.selection(source.url);
  for (let index = 0; index < 5; index += 1) {
    threadIds.push((await accept(share(f.actor, selection), [201])).body.id);
  }
  await flushWaitUntilForTest();
  await enableMarkdownCovers(f.actor, true);
  const pendingId = threadIds.find((id) => {
    const policy = f.objects.get(
      `test-hosted-sites/shared-thread-artifacts/okou/${id}.json`,
    );
    return (
      policy !== undefined &&
      sharedThreadArtifactPolicySchema.parse(JSON.parse(policy.toString()))
        .previews === undefined
    );
  });
  if (!pendingId) {
    throw new Error("Expected a snapshot outside the bounded catch-up batch");
  }
  const shared = await accept(
    api()(sharedThreadsContract).get({ params: { id: pendingId } }),
    [200],
  );
  const reference = referenceName(shared.body.messages[0]!.content);
  const pending = await markdownImageQuery(reference);
  await accept(api()(artifactOgContract).image({ query: pending }), [302]);
  await accept(
    api()(artifactReferencesContract).read({
      headers: headers(f.actor),
      params: { reference },
    }),
    [200],
  );
  await flushWaitUntilForTest();
  const ready = await markdownImageQuery(reference);
  expect(ready.version).not.toBe(pending.version);
  await accept(api()(artifactOgContract).image({ query: ready }), [200]);
  expect(renderer.requests).toHaveLength(1);
});

test("copies an uploaded video with independent bytes and the parent revocation", async () => {
  const f = await fixture();
  const sourceRun = await f.selection("Upload a video");
  await runs.heartbeatRunner(f.runnerGroup);
  const claim = await runs.claimRunnerJob(sourceRun.runId);
  const bearerToken = okouTokenFromClaim(claim);
  const source = await f.upload(f.actor, "Private video bytes", {
    filename: "video.mp4",
    contentType: "video/mp4",
    bearerToken,
  });
  const sourceArtifacts = await chat.listThreadArtifacts(
    f.actor,
    sourceRun.threadId,
  );
  expect(
    sourceArtifacts.runs.flatMap((run) => {
      return run.files;
    }),
  ).toStrictEqual(
    expect.arrayContaining([
      expect.objectContaining({ url: source.url, contentType: "video/mp4" }),
    ]),
  );
  const selection = await f.selection(source.url);
  const created = await accept(share(f.actor, selection), [201]);
  const shared = await accept(
    api()(sharedThreadsContract).get({ params: { id: created.body.id } }),
    [200],
  );
  const reference = referenceName(shared.body.messages[0]!.content);
  const resolved = await accept(
    api()(artifactReferencesContract).resolve({ params: { reference } }),
    [200],
  );
  expect(resolved.body.downloadUrl).toBeDefined();
  const download = new URL(resolved.body.downloadUrl!);
  expect(download.searchParams.get("X-Amz-Credential")).toBe(
    "snapshot-private-key",
  );
  expect(download.searchParams.get("response-content-disposition")).toBe(
    'attachment; filename="video.mp4"',
  );
  expect(download.pathname).toContain(created.body.id);
  const downloaded = await fetch(download);
  expect(downloaded.status).toBe(200);
  expect(downloaded.headers.get("content-disposition")).toBe(
    'attachment; filename="video.mp4"',
  );
  await expect(downloaded.text()).resolves.toBe("Private video bytes");
  const published = await accept(
    api()(artifactReferencesContract).publicUrl({ params: { reference } }),
    [200],
  );
  expect(published.body.preview).toMatchObject({
    filename: "video.mp4",
    contentType: "video/mp4",
  });
  expect(published.body.downloadUrl).toBe(resolved.body.downloadUrl);
  f.objects.set(source.key, Buffer.from("Changed source video"));
  await expect((await fetch(published.body.url)).text()).resolves.toBe(
    "Private video bytes",
  );
  f.objects.delete(source.key);
  const retained = await accept(
    api()(artifactReferencesContract).publicUrl({ params: { reference } }),
    [200],
  );
  await expect((await fetch(retained.body.url)).text()).resolves.toBe(
    "Private video bytes",
  );
  await accept(
    api()(artifactReferencesContract).publicUrl({
      params: { reference: referenceName(source.url) },
    }),
    [404],
  );
  await accept(
    api()(sharedThreadsContract).delete({
      headers: headers(f.actor),
      params: { id: created.body.id },
    }),
    [204],
  );
  await accept(
    api()(artifactReferencesContract).resolve({ params: { reference } }),
    [404],
  );
  await accept(
    api()(artifactReferencesContract).publicUrl({ params: { reference } }),
    [404],
  );
});

test.each(["missing", "unavailable"] as const)(
  "does not resolve a snapshot when its parent policy is %s",
  async (failure) => {
    const f = await fixture();
    const file = await f.upload();
    const selection = await f.selection(file.url);
    const created = await accept(share(f.actor, selection), [201]);
    const shared = await accept(
      api()(sharedThreadsContract).get({ params: { id: created.body.id } }),
      [200],
    );
    const reference = referenceName(shared.body.messages[0]!.content);
    const key = `shared-thread-artifacts/okou/${created.body.id}.json`;
    if (failure === "missing") {
      f.objects.delete(`test-hosted-sites/${key}`);
    } else {
      const storage = context.mocks.s3.send.getMockImplementation()!;
      context.mocks.s3.send.mockImplementation((command) => {
        if (command instanceof GetObjectCommand && command.input.Key === key) {
          return Promise.reject(
            new Error("Snapshot policy storage unavailable"),
          );
        }
        return storage(command);
      });
    }
    const expected = failure === "missing" ? 404 : 500;
    const resolved = await accept(
      api()(artifactReferencesContract).resolve({ params: { reference } }),
      [expected],
    );
    expect(resolved.body).not.toHaveProperty("url");
    const published = await accept(
      api()(artifactReferencesContract).publicUrl({ params: { reference } }),
      [expected],
    );
    expect(published.body).not.toHaveProperty("preview");
    const og = api()(artifactOgContract);
    const disabledQuery = { kind: "reference" as const, id: reference };
    expect(
      (await accept(og.metadata({ query: disabledQuery }), [200])).body,
    ).toStrictEqual({ available: false });
    const disabledImage = await accept(
      og.image({ query: { ...disabledQuery, version: "published" } }),
      [302],
    );
    expect(disabledImage.headers.get("location")).toBe(
      ARTIFACT_OG_BRAND.imageUrl,
    );
    await accept(
      api()(featureSwitchesContract).update({
        headers: headers(f.actor),
        body: { switches: { [FeatureSwitchKey.ArtifactPreviews]: true } },
      }),
      [200],
    );
    const ogStatus = failure === "missing" ? 200 : 500;
    const metadata = await accept(
      og.metadata({ query: { kind: "reference", id: reference } }),
      [ogStatus],
    );
    expect(metadata.body).not.toHaveProperty("imageUrl");
    const image = await accept(
      og.image({
        query: { kind: "reference", id: reference, version: "published" },
      }),
      [failure === "missing" ? 302 : 500],
    );
    expect(image.headers.get("cache-control")).toBe("private, no-store");
    const downloaded = await accept(
      api()(artifactDownloadsContract).download({
        headers: headers(f.actor),
        params: { reference },
      }),
      [expected],
    );
    expect(downloaded.body).not.toHaveProperty("url");
  },
);

test.each(["short", "legacy"] as const)(
  "%s organization share references cannot authorize a recipient to publish a thread snapshot",
  async (format) => {
    const f = await fixture();
    const owner = bdd.user({ orgId: f.actor.orgId });
    await flag(owner, true);
    const file = await f.upload(owner);
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
      {
        data: [
          {
            publicUserData: { userId: owner.userId },
            organization: { id: f.actor.orgId, name: "Owner organization" },
          },
          {
            publicUserData: { userId: f.actor.userId },
            organization: { id: f.actor.orgId, name: "Owner organization" },
          },
        ],
        totalCount: 2,
      },
    );
    const shared = await accept(
      api()(artifactSharesContract).update({
        headers: headers(owner),
        body: {
          target: { kind: "file", id: file.id },
          audience: "organization",
        },
      }),
      [200],
    );
    const url =
      format === "short"
        ? shared.body.shortUrl
        : `https://app.okou.ai${artifactReferencePath(shared.body.shareId!, "report.pdf")}`;
    const selection = await f.selection(`[Organization report](${url})`);
    await accept(share(f.actor, selection), [400]);
    const catalog = await chat.listArtifactCatalog(f.actor, {
      kind: "shared-thread",
      chatThreadId: selection.threadId,
    });
    expect(catalog.artifacts).toStrictEqual([]);
  },
);

test("a partial copy failure leaves no usable share and cleans copied private bytes", async () => {
  const f = await fixture();
  const file = await f.upload();
  const missing = await f.upload();
  const selection = await f.selection(
    `[One](${file.url}) [Two](${missing.url})`,
  );
  f.objects.delete(missing.key);
  await accept(share(f.actor, selection), [400]);
  expect(
    [...f.objects.keys()].filter((key) => {
      return key.includes("/thread-shares/");
    }),
  ).toStrictEqual([]);
  const catalog = await chat.listArtifactCatalog(f.actor, {
    kind: "shared-thread",
    chatThreadId: selection.threadId,
  });
  expect(catalog.artifacts).toStrictEqual([]);
  expect(f.objects.has(file.key)).toBeTruthy();
});

test("independent thread snapshots use different short references and revoke separately", async () => {
  const f = await fixture();
  const file = await f.upload();
  const selection = await f.selection(file.url);
  const first = await accept(share(f.actor, selection), [201]);
  const second = await accept(share(f.actor, selection), [201]);
  const firstView = await accept(
    api()(sharedThreadsContract).get({ params: { id: first.body.id } }),
    [200],
  );
  const secondView = await accept(
    api()(sharedThreadsContract).get({ params: { id: second.body.id } }),
    [200],
  );
  const firstUrl = firstView.body.messages[0]!.content;
  const secondUrl = secondView.body.messages[0]!.content;
  expect(firstUrl).toMatch(
    /^https:\/\/app\.okou\.ai\/artifacts\/[a-z0-9]{10}\.pdf$/u,
  );
  expect(secondUrl).toMatch(
    /^https:\/\/app\.okou\.ai\/artifacts\/[a-z0-9]{10}\.pdf$/u,
  );
  expect(secondUrl).not.toBe(firstUrl);
  await accept(
    api()(sharedThreadsContract).delete({
      headers: headers(f.actor),
      params: { id: first.body.id },
    }),
    [204],
  );
  await accept(
    api()(sharedThreadsContract).get({ params: { id: first.body.id } }),
    [404],
  );
  const retained = await accept(
    api()(sharedThreadsContract).get({ params: { id: second.body.id } }),
    [200],
  );
  expect(retained.body.messages[0]!.content).toBe(secondUrl);
  await accept(
    api()(artifactReferencesContract).resolve({
      params: { reference: referenceName(firstUrl) },
    }),
    [404],
  );
  await accept(
    api()(artifactReferencesContract).publicUrl({
      params: { reference: referenceName(firstUrl) },
    }),
    [404],
  );
  const retainedArtifact = await accept(
    api()(artifactReferencesContract).resolve({
      params: { reference: referenceName(secondUrl) },
    }),
    [200],
  );
  expect(retainedArtifact.body.url).toContain(second.body.id);
});

test("owner deletion revokes a snapshot after switch rollback and preserves the private original", async () => {
  const f = await fixture();
  const file = await f.upload();
  const selection = await f.selection(file.url);
  const created = await accept(share(f.actor, selection), [201]);
  await accept(
    api()(sharedThreadsContract).delete({
      headers: headers(bdd.user({ orgId: f.actor.orgId })),
      params: { id: created.body.id },
    }),
    [404],
  );
  await flag(f.actor, false);
  await accept(
    api()(sharedThreadsContract).delete({
      headers: headers(f.actor),
      params: { id: created.body.id },
    }),
    [204],
  );
  await accept(
    api()(sharedThreadsContract).get({ params: { id: created.body.id } }),
    [404],
  );
  await accept(
    api()(sharedThreadsContract).meta({ params: { id: created.body.id } }),
    [404],
  );
  expect(
    [...f.objects.keys()].filter((key) => {
      return key.includes("/thread-shares/");
    }),
  ).toStrictEqual([]);
  expect(f.objects.has(file.key)).toBeTruthy();
});

test("switch-off shares retain the established message-only projection", async () => {
  const f = await fixture();
  const file = await f.upload();
  const selection = await f.selection(file.url);
  await flag(f.actor, false);
  const created = await accept(share(f.actor, selection), [201]);
  const shared = await accept(
    api()(sharedThreadsContract).get({ params: { id: created.body.id } }),
    [200],
  );
  expect(shared.body.messages[0]!.content).toBe(file.url);
  expect(f.copies).toStrictEqual([]);
});

test.each(["organization", "user"] as const)(
  "%s deletion revokes resource access before acknowledging the webhook",
  async (kind) => {
    const f = await fixture();
    const file = await f.upload();
    const selection = await f.selection(file.url);
    const created = await accept(share(f.actor, selection), [201]);
    await flag(f.actor, false);
    context.mocks.stripe.subscriptions.list.mockResolvedValue({
      data: [],
      has_more: false,
    });
    const webhooks = createWebhookCallbackApi(context);
    webhooks.configureClerkWebhookSecret();
    webhooks.verifyNextClerkWebhook({
      type: kind === "organization" ? "organization.deleted" : "user.deleted",
      data: { id: kind === "organization" ? f.actor.orgId : f.actor.userId },
    });
    await webhooks.requestClerkWebhook("{}", {}, [200]);
    // The foreground revocation is sufficient even before background deletion.
    await accept(
      api()(sharedThreadsContract).get({ params: { id: created.body.id } }),
      [404],
    );
    await flushWaitUntilForTest();
    expect(
      [...f.objects.keys()].filter((key) => {
        return key.includes("/thread-shares/");
      }),
    ).toStrictEqual([]);
  },
);

test("a failed deletion revocation is retryable and is never acknowledged as success", async () => {
  const f = await fixture();
  const file = await f.upload();
  const selection = await f.selection(file.url);
  const created = await accept(share(f.actor, selection), [201]);
  const key = `test-hosted-sites/shared-thread-artifacts/okou/${created.body.id}.json`;
  f.failedWrites.add(key);
  const webhooks = createWebhookCallbackApi(context);
  webhooks.configureClerkWebhookSecret();
  webhooks.verifyNextClerkWebhook({
    type: "organization.deleted",
    data: { id: f.actor.orgId },
  });
  await webhooks.requestClerkWebhook("{}", {}, [503]);
  f.failedWrites.delete(key);
  context.mocks.stripe.subscriptions.list.mockResolvedValue({
    data: [],
    has_more: false,
  });
  webhooks.verifyNextClerkWebhook({
    type: "organization.deleted",
    data: { id: f.actor.orgId },
  });
  await webhooks.requestClerkWebhook("{}", {}, [200]);
  await expect(
    api()(sharedThreadsContract).get({ params: { id: created.body.id } }),
  ).resolves.toMatchObject({ status: 404 });
});

test("publication rechecks current ownership after allocating its durable snapshot", async () => {
  const f = await fixture();
  const file = await f.upload();
  const selection = await f.selection(file.url);
  context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
    { data: [], totalCount: 0 },
  );
  await accept(share(f.actor, selection), [400]);
  expect(f.copies).toStrictEqual([]);
  const catalog = await chat.listArtifactCatalog(f.actor, {
    kind: "shared-thread",
    chatThreadId: selection.threadId,
  });
  expect(catalog.artifacts).toStrictEqual([]);
});

test.each(["publish", "delete", "cancel"] as const)(
  "copies while the title is pending and respects the final action: %s",
  async (action) => {
    const f = await fixture();
    const file = await f.upload();
    const selection = await f.selection(file.url);
    const titleEntered = createDeferredPromise<void>(context.signal);
    const releaseTitle = createDeferredPromise<void>(context.signal);
    const copied = createDeferredPromise<void>(context.signal);
    const id = randomUUID();
    const providerReturned = createDeferredPromise<void>(context.signal);
    const controller = new AbortController();
    const originalSend = context.mocks.s3.send.getMockImplementation()!;
    context.mocks.s3.send.mockImplementation(async (command: unknown) => {
      const result = await originalSend(command);
      if (
        command instanceof CopyObjectCommand &&
        command.input.CopySource === file.key
      ) {
        copied.resolve();
      }
      return result;
    });
    mockGoogleText();
    server.use(
      http.post(VERTEX_TEXT_URL, async () => {
        titleEntered.resolve(undefined);
        await releaseTitle.promise;
        providerReturned.resolve(undefined);
        return HttpResponse.json({
          candidates: [
            {
              finishReason: "STOP",
              content: {
                parts: [
                  {
                    text: "Shared report",
                  },
                ],
              },
            },
          ],
        });
      }),
    );
    const pending = share(f.actor, selection, {
      signal: controller.signal,
      rethrowErrors: true,
      id,
    });
    const outcome = Promise.allSettled([pending]);
    onTestFinished(async () => {
      if (!releaseTitle.settled()) {
        releaseTitle.resolve(undefined);
      }
      await outcome;
    });
    await titleEntered.promise;
    await copied.promise;
    await accept(api()(sharedThreadsContract).get({ params: { id } }), [404]);
    expect(
      (await chat.listArtifactCatalog(f.actor, { kind: "shared-thread" }))
        .artifacts,
    ).toStrictEqual([]);
    if (action === "cancel") {
      const reason = new DOMException("Caller cancelled", "AbortError");
      controller.abort(reason);
      await expect(pending).rejects.toBe(reason);
      expect(
        [...f.objects.keys()].filter((key) => {
          return key.includes("/thread-shares/");
        }),
      ).toStrictEqual([]);
      releaseTitle.resolve(undefined);
      await providerReturned.promise;
      return;
    }
    if (action === "delete") {
      await accept(
        api()(sharedThreadsContract).delete({
          headers: headers(f.actor),
          params: { id },
        }),
        [204],
      );
      releaseTitle.resolve(undefined);
      await accept(pending, [400]);
      await accept(api()(sharedThreadsContract).get({ params: { id } }), [404]);
      expect(
        [...f.objects.keys()].filter((key) => {
          return key.includes("/thread-shares/");
        }),
      ).toStrictEqual([]);
      return;
    }
    releaseTitle.resolve(undefined);
    const created = await accept(pending, [201]);
    expect(created.body.id).toBe(id);
    const shared = await accept(
      api()(sharedThreadsContract).get({ params: { id } }),
      [200],
    );
    expect(shared.body.title).toBe("Shared report");
  },
);

test("a losing snapshot creator preserves the ordinary share that won its client ID", async () => {
  const f = await fixture();
  const file = await f.upload();
  const privateSelection = await f.selection(file.url);
  const ordinarySelection = await f.selection(
    "Ordinary conversation remains readable",
  );
  const id = randomUUID();
  const entered = createDeferredPromise<void>(context.signal);
  const release = createDeferredPromise<void>(context.signal);
  const originalSend = context.mocks.s3.send.getMockImplementation()!;
  context.mocks.s3.send.mockImplementation(async (command: unknown) => {
    const response = await originalSend(command);
    if (
      command instanceof PutObjectCommand &&
      command.input.Key === `shared-thread-artifacts/okou/${id}.json` &&
      command.input.IfNoneMatch === "*"
    ) {
      entered.resolve(undefined);
      await release.promise;
    }
    return response;
  });
  const pending = api()(sharedThreadsContract).create({
    headers: headers(f.actor),
    params: { threadId: privateSelection.threadId },
    body: { id, eventIds: [privateSelection.eventId] },
  });
  const outcome = Promise.allSettled([pending]);
  onTestFinished(async () => {
    if (!release.settled()) {
      release.resolve(undefined);
    }
    await outcome;
  });
  await entered.promise;
  await accept(
    api()(sharedThreadsContract).create({
      headers: headers(f.actor),
      params: { threadId: ordinarySelection.threadId },
      body: { id, eventIds: [ordinarySelection.eventId] },
    }),
    [201],
  );
  release.resolve(undefined);
  await accept(pending, [409]);
  const shared = await accept(
    api()(sharedThreadsContract).get({ params: { id } }),
    [200],
  );
  expect(shared.body.messages).toContainEqual(
    expect.objectContaining({
      content: "Ordinary conversation remains readable",
    }),
  );
  await accept(api()(sharedThreadsContract).meta({ params: { id } }), [200]);
});

test("deletes an unpublished snapshot while copying and never republishes its grant", async () => {
  const f = await fixture();
  const file = await f.upload();
  const selection = await f.selection(file.url);
  const id = randomUUID();
  const entered = createDeferredPromise<void>(context.signal);
  const release = createDeferredPromise<void>(context.signal);
  const originalSend = context.mocks.s3.send.getMockImplementation()!;
  context.mocks.s3.send.mockImplementation(async (command: unknown) => {
    if (command instanceof CopyObjectCommand) {
      entered.resolve(undefined);
      await release.promise;
    }
    return originalSend(command);
  });
  const pending = api()(sharedThreadsContract).create({
    headers: headers(f.actor),
    params: { threadId: selection.threadId },
    body: { id, eventIds: [selection.eventId] },
  });
  const outcome = Promise.allSettled([pending]);
  onTestFinished(async () => {
    if (!release.settled()) {
      release.resolve(undefined);
    }
    await outcome;
  });
  await entered.promise;
  await accept(api()(sharedThreadsContract).get({ params: { id } }), [404]);
  await accept(api()(sharedThreadsContract).meta({ params: { id } }), [404]);
  await accept(
    api()(sharedThreadsContract).delete({
      headers: headers(f.actor),
      params: { id },
    }),
    [204],
  );
  release.resolve(undefined);
  await accept(pending, [400]);
  await accept(api()(sharedThreadsContract).get({ params: { id } }), [404]);
  await accept(api()(sharedThreadsContract).meta({ params: { id } }), [404]);
  expect(
    (await chat.listArtifactCatalog(f.actor, { kind: "shared-thread" }))
      .artifacts,
  ).toStrictEqual([]);
  await accept(
    api()(artifactReferencesContract).resolve({
      headers: headers(f.actor),
      params: { reference: referenceName(file.url) },
    }),
    [200],
  );
});

test("drains an in-flight copy before rolling back another copy's failure", async () => {
  const f = await fixture();
  const first = await f.upload();
  const second = await f.upload(f.actor, "Second file");
  const selection = await f.selection(`${first.url} ${second.url}`);
  const release = createDeferredPromise<void>(context.signal);
  const failed = createDeferredPromise<void>(context.signal);
  const originalSend = context.mocks.s3.send.getMockImplementation()!;
  let copiesStarted = 0;
  let deletedWhileCopying = false;
  context.mocks.s3.send.mockImplementation(async (command: unknown) => {
    if (command instanceof CopyObjectCommand) {
      copiesStarted += 1;
      if (copiesStarted === 1) {
        await release.promise;
      } else {
        failed.resolve(undefined);
        throw new Error("Copy failed");
      }
    }
    if (command instanceof DeleteObjectsCommand && !release.settled()) {
      deletedWhileCopying = true;
    }
    return originalSend(command);
  });
  const pending = share(f.actor, selection);
  const outcome = Promise.allSettled([pending]);
  onTestFinished(async () => {
    if (!release.settled()) {
      release.resolve(undefined);
    }
    await outcome;
  });
  await failed.promise;
  expect(deletedWhileCopying).toBeFalsy();
  release.resolve(undefined);
  await expect(pending).rejects.toThrow("Unknown response status 500");
  expect(deletedWhileCopying).toBeFalsy();
  expect(
    [...f.objects.keys()].filter((key) => {
      return key.includes("/thread-shares/");
    }),
  ).toStrictEqual([]);
  expect(
    (await chat.listArtifactCatalog(f.actor, { kind: "shared-thread" }))
      .artifacts,
  ).toStrictEqual([]);
});

test("shares distinct files and reuses a reference for repeated links", async () => {
  const f = await fixture();
  const first = await f.upload();
  const second = await f.upload(f.actor, "Another dependency");
  const selection = await f.selection(
    `${first.url} ${second.url} ${first.url}`,
  );
  const created = await accept(share(f.actor, selection), [201]);
  const shared = await accept(
    api()(sharedThreadsContract).get({ params: { id: created.body.id } }),
    [200],
  );
  const links = shared.body.messages[0]!.content.split(" ");
  expect(links).toHaveLength(3);
  expect(links[0]).toBe(links[2]);
  expect(links[0]).not.toBe(links[1]);
  for (const [index, content] of [
    "Original generated PDF",
    "Another dependency",
  ].entries()) {
    const resolved = await accept(
      api()(artifactReferencesContract).resolve({
        params: { reference: referenceName(links[index]!) },
      }),
      [200],
    );
    const download = await fetch(resolved.body.url);
    expect(download.status).toBe(200);
    await expect(download.text()).resolves.toBe(content);
  }
});

test("oG uses the published thread snapshot and revokes its old image URL with the parent share", async () => {
  const f = await fixture();
  await accept(
    api()(featureSwitchesContract).update({
      headers: headers(f.actor),
      body: { switches: { [FeatureSwitchKey.ArtifactPreviews]: true } },
    }),
    [200],
  );
  const bytes = await sharp({
    create: { width: 64, height: 40, channels: 3, background: "#226688" },
  })
    .png()
    .toBuffer();
  const file = await f.upload(f.actor, bytes, {
    filename: "published.png",
    contentType: "image/png",
  });
  const selection = await f.selection(file.url);
  const created = await accept(share(f.actor, selection), [201]);
  const shared = await accept(
    api()(sharedThreadsContract).get({ params: { id: created.body.id } }),
    [200],
  );
  const target = {
    kind: "reference" as const,
    id: referenceName(shared.body.messages[0]!.content),
  };
  const og = api()(artifactOgContract);
  const metadata = await accept(og.metadata({ query: target }), [200]);
  expect(metadata.body).toMatchObject({
    available: true,
    title: "published.png",
  });
  if (!metadata.body.available) {
    throw new Error("Expected published metadata");
  }
  const query = {
    ...target,
    version: new URL(metadata.body.imageUrl).searchParams.get("version")!,
  };
  // The snapshot remains public independently of the private source's lifetime.
  f.objects.delete(file.key);
  const image = await accept(og.image({ query }), [200]);
  const publishedBytes = Buffer.from(await image.body.arrayBuffer());
  await expect(sharp(publishedBytes).metadata()).resolves.toMatchObject({
    width: 64,
    height: 40,
  });
  expect(
    (
      await accept(
        og.metadata({
          query: { kind: "reference", id: referenceName(file.url) },
        }),
        [200],
      )
    ).body,
  ).toStrictEqual({ available: false });
  await accept(
    api()(sharedThreadsContract).delete({
      headers: headers(f.actor),
      params: { id: created.body.id },
    }),
    [204],
  );
  expect(
    (await accept(og.metadata({ query: target }), [200])).body,
  ).toStrictEqual({
    available: false,
  });
  const revoked = await accept(og.image({ query }), [302]);
  expect(revoked.headers.get("cache-control")).toBe("private, no-store");
  expect(revoked.headers.get("location")).toBe(ARTIFACT_OG_BRAND.imageUrl);
});
