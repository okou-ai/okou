import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { artifactReferencesContract } from "@okouai/api-contracts/contracts/artifact-references";
import { artifactOgContract } from "@okouai/api-contracts/contracts/artifact-og";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { ARTIFACT_OG_BRAND } from "@okouai/core/artifact-og";
import {
  hostContract,
  type HostedSitePrepareResponse,
  type HostedSitePreview,
} from "@okouai/api-contracts/contracts/host";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { setupAppWithRoutes } from "../../../__tests__/test-app";
import { setupApp } from "../../../__tests__/test-helpers";
import { accept, testContext } from "../../../__tests__/test-context";
import { env } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { featureSwitchesRoutes } from "../feature-switches";
import { artifactReferenceRoutes } from "../artifact-references";
import { artifactOgRoutes } from "../artifact-og";
import { hostRoutes } from "../host";
import { createBddApi } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { hostedTextFile } from "./helpers/api-bdd-host-files";
import { createHostBddApi } from "./helpers/api-bdd-host";
import {
  createChatEventsFixture,
  okouTokenFromClaim,
} from "./helpers/chat-events-fixture";
import { createRouteMocks } from "./helpers/route-test";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";

const context = testContext();
const host = createHostBddApi(context);
const chat = createChatFilesBddApi(context);

/** Model real uploads through the returned presigned URL; no private DB setup. */
function previewStorage(
  options: { readonly failStagingDeleteOnce?: boolean } = {},
) {
  let failStagingDelete = options.failStagingDeleteOnce ?? false;
  const fileSigner = context.mocks.s3.getSignedUrl.getMockImplementation();
  host.captureHostedSitesS3();
  const baseSend = context.mocks.s3.send.getMockImplementation();
  const baseSign = context.mocks.s3.getSignedUrl.getMockImplementation();
  if (!baseSend || !baseSign || !fileSigner) {
    throw new Error("Missing object-storage fixture");
  }
  const objects = new Map<string, Buffer>();
  const contentTypes = new Map<string, string>();
  const grants = new Map<string, string>();
  context.mocks.s3.getSignedUrl.mockImplementation(
    (client, command, options) => {
      if (
        command instanceof GetObjectCommand &&
        command.input.Bucket === env("R2_PRIVATE_ARTIFACTS_BUCKET_NAME")
      ) {
        return fileSigner(client, command, options);
      }
      if (
        command instanceof PutObjectCommand &&
        command.input.Bucket === env("R2_PRIVATE_ARTIFACTS_BUCKET_NAME") &&
        command.input.Key
      ) {
        const token = randomUUID();
        grants.set(token, command.input.Key);
        return Promise.resolve(`https://preview-upload.example/${token}`);
      }
      return baseSign(client, command, options);
    },
  );
  server.use(
    http.put(
      "https://preview-upload.example/:token",
      async ({ request, params }) => {
        const key = grants.get(String(params.token));
        if (!key) {
          return new HttpResponse(null, { status: 403 });
        }
        objects.set(key, Buffer.from(await request.arrayBuffer()));
        return new HttpResponse(null, { status: 200 });
      },
    ),
  );
  context.mocks.s3.send.mockImplementation((command, ...rest) => {
    if (
      command instanceof DeleteObjectsCommand &&
      command.input.Bucket === env("R2_PRIVATE_ARTIFACTS_BUCKET_NAME")
    ) {
      if (failStagingDelete) {
        failStagingDelete = false;
        return Promise.reject(new Error("Preview staging cleanup unavailable"));
      }
      for (const entry of command.input.Delete?.Objects ?? []) {
        if (entry.Key) {
          objects.delete(entry.Key);
        }
      }
      return Promise.resolve({});
    }
    if (
      (command instanceof GetObjectCommand ||
        command instanceof HeadObjectCommand ||
        command instanceof PutObjectCommand) &&
      command.input.Bucket === env("R2_PRIVATE_ARTIFACTS_BUCKET_NAME") &&
      command.input.Key?.startsWith("private-artifacts/")
    ) {
      const key = command.input.Key;
      if (command instanceof PutObjectCommand) {
        if (!objects.has(key)) {
          const body = command.input.Body;
          if (!Buffer.isBuffer(body)) {
            throw new Error("Expected original preview bytes");
          }
          objects.set(key, body);
          contentTypes.set(key, command.input.ContentType ?? "");
        }
        return Promise.resolve({});
      }
      const bytes = objects.get(key);
      if (!bytes) {
        const error = Object.assign(new Error("No such object"), {
          name: "NoSuchKey",
          $metadata: { httpStatusCode: 404 },
        });
        return Promise.reject(error);
      }
      return Promise.resolve({
        Body: Readable.from([bytes]),
        ContentLength: bytes.length,
        ContentType: contentTypes.get(key) ?? "image/png",
        ETag: '"preview"',
      });
    }
    return baseSend(command, ...rest);
  });
  return objects;
}

// Fixed PNG and JPEG uploads; tests neither generate nor decode image data.
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+afo8AAAAASUVORK5CYII=",
  "base64",
);
const secondPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR4nGP4z8DwHwyBNBgAAEnICff5q7YNAAAAAElFTkSuQmCC",
  "base64",
);
const jpeg = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k=",
  "base64",
);

function preview(
  bytes: Buffer,
  contentType: HostedSitePreview["contentType"] = "image/png",
) {
  return {
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    contentType,
  };
}

async function upload(prepared: HostedSitePrepareResponse, bytes: Buffer) {
  if (!prepared.preview) {
    throw new Error("API did not acknowledge preview");
  }
  const response = await fetch(prepared.preview.uploadUrl, {
    method: "PUT",
    body: new Uint8Array(bytes),
  });
  expect(response.status).toBe(200);
}

describe("sandbox hosted previews", () => {
  it("uses official welcome covers only after authorizing the publication", async () => {
    // The production cover catalog matches this exact, globally unique hostname.
    // Isolate the global hosted-address namespace so repeat runs can claim it.
    const app = await setupApp({
      context,
      routes: hostRoutes,
      isolatePg: true,
    });
    const api = app(hostContract);
    const owner = createBddApi(context).user();
    if (!owner.orgId) {
      throw new Error("Expected an organization");
    }
    await updateFeatureSwitchesForUser(
      context,
      { ...owner, orgId: owner.orgId },
      { [FeatureSwitchKey.HostedSiteVisibility]: false },
    );
    previewStorage();
    const prepared = await host.prepareHostedSite(owner, {
      site: "sproutpop-launch-deck-p9jk",
      artifactKind: "presentation-html",
      spaFallback: false,
      files: [hostedTextFile("/index.html", "<main>Welcome example</main>")],
    });
    await host.completeHostedSite(owner, prepared.deploymentId);
    const headers = { authorization: "Bearer clerk-session" };
    const request = {
      headers,
      params: { publicSlug: prepared.publicSlug },
      query: { hostname: `${prepared.publicSlug}.okou.app` },
    };
    const outsider = createBddApi(context).user();
    const mocks = createRouteMocks(context);
    mocks.clerk.session(outsider.userId, outsider.orgId);
    expect((await accept(api.sitePreview(request), [200])).body).toStrictEqual({
      url: "https://sproutpop-launch-deck-p9jk.okou.app/",
      expiresAt: null,
      previewImageUrl:
        "https://static.vm0.io/vm0/welcome-thread/2026-10-26-previews/sproutpop-a826bd3d2831.png",
    });
    mocks.clerk.session(owner.userId, owner.orgId);
    await accept(
      setupAppWithRoutes({ context, routes: featureSwitchesRoutes })(
        featureSwitchesContract,
      ).update({
        headers,
        body: { switches: { [FeatureSwitchKey.HostedSiteVisibility]: true } },
      }),
      [200],
    );
    await accept(
      api.updateSiteVisibility({
        headers,
        params: { siteId: prepared.siteId },
        body: { visibility: "private", expectedRevision: null },
      }),
      [200],
    );
    mocks.clerk.session(outsider.userId, outsider.orgId);
    await accept(api.sitePreview(request), [404]);
  });

  it.each([
    { bytes: png, contentType: "image/png", extension: "png" },
    { bytes: jpeg, contentType: "image/jpeg", extension: "jpg" },
  ] as const)(
    "preserves original $contentType bytes and file identity",
    async ({ bytes, contentType, extension }) => {
      const owner = createBddApi(context).user();
      if (!owner.orgId) {
        throw new Error("Expected an organization");
      }
      const actor = { ...owner, orgId: owner.orgId };
      const objects = previewStorage();
      const declared = preview(bytes, contentType);
      const prepared = await host.prepareHostedSite(actor, {
        site: `original-${randomUUID().slice(0, 8)}`,
        artifactKind: "hosted-site",
        spaFallback: false,
        files: [hostedTextFile("/index.html", "<main>Original cover</main>")],
        preview: declared,
      });
      expect(prepared.preview?.sha256).toBe(declared.sha256);
      await upload(prepared, bytes);
      const completed = await host.completeHostedSite(
        actor,
        prepared.deploymentId,
      );
      expect(completed.previewImageUrl?.endsWith(`.${extension}`)).toBeTruthy();
      expect([...objects.values()]).toStrictEqual([bytes]);
      expect(context.mocks.s3.send).toHaveBeenCalledWith(
        expect.objectContaining({
          input: expect.objectContaining({
            Body: bytes,
            ContentType: contentType,
            IfNoneMatch: "*",
          }),
        }),
        expect.objectContaining({ abortSignal: expect.any(AbortSignal) }),
      );
      if (!completed.previewImageUrl) {
        throw new Error("Missing completed preview reference");
      }
      const reference = new URL(completed.previewImageUrl).pathname
        .split("/")
        .at(-1);
      if (!reference) {
        throw new Error("Missing preview reference");
      }
      createRouteMocks(context).clerk.session(actor.userId, actor.orgId);
      const references = setupAppWithRoutes({
        context,
        routes: artifactReferenceRoutes,
      })(artifactReferencesContract);
      const resolved = await accept(
        references.resolve({
          headers: { authorization: "Bearer clerk-session" },
          params: { reference },
        }),
        [200],
      );
      expect(resolved.body).toMatchObject({
        contentType,
        filename: `preview-${declared.sha256}.${extension}`,
      });
      await expect(
        host.completeHostedSite(actor, prepared.deploymentId),
      ).resolves.toMatchObject({
        previewImageUrl: completed.previewImageUrl,
      });
      expect([...objects.values()]).toStrictEqual([bytes]);
    },
  );

  it("resolves published covers with visibility settings disabled and authorizes them through the current Site policy", async () => {
    const owner = createBddApi(context).user();
    if (!owner.orgId) {
      throw new Error("Expected an organization");
    }
    const actor = { ...owner, orgId: owner.orgId };
    const headers = { authorization: "Bearer clerk-session" };
    const mocks = createRouteMocks(context);
    mocks.clerk.session(actor.userId, actor.orgId);
    const features = setupAppWithRoutes({
      context,
      routes: featureSwitchesRoutes,
    })(featureSwitchesContract);
    await accept(
      features.update({
        headers,
        body: { switches: { [FeatureSwitchKey.HostedSiteVisibility]: false } },
      }),
      [200],
    );
    previewStorage();
    const bytes = png;
    const prepared = await host.prepareHostedSite(actor, {
      site: `cover-${randomUUID().slice(0, 8)}`,
      artifactKind: "hosted-site",
      spaFallback: false,
      files: [hostedTextFile("/index.html", "<main>Website</main>")],
      preview: preview(bytes),
    });
    await upload(prepared, bytes);
    const completed = await host.completeHostedSite(
      actor,
      prepared.deploymentId,
    );
    expect(completed.previewImageUrl).toBeDefined();
    const api = setupAppWithRoutes({ context, routes: hostRoutes })(
      hostContract,
    );
    const request = {
      headers,
      params: { publicSlug: prepared.publicSlug },
      query: { hostname: `${prepared.publicSlug}.okou.app` },
    };
    mocks.clerk.session(actor.userId, actor.orgId);
    const first = await accept(api.sitePreview(request), [200]);
    expect(first.body.expiresAt).toBeNull();
    expect(first.body.previewImageUrl).toBeDefined();
    expect(
      new URL(first.body.previewImageUrl!).searchParams.get("object"),
    ).toContain("test-private-artifacts/private-artifacts/");
    expect((await accept(api.sitePreview(request), [200])).body).toStrictEqual(
      first.body,
    );
    await accept(
      features.update({
        headers,
        body: { switches: { [FeatureSwitchKey.HostedSiteVisibility]: true } },
      }),
      [200],
    );
    await accept(
      api.updateSiteVisibility({
        headers,
        params: { siteId: prepared.siteId },
        body: { visibility: "private", expectedRevision: null },
      }),
      [200],
    );
    const privatePreview = await accept(api.sitePreview(request), [200]);
    expect(privatePreview.body.previewImageUrl).toBe(
      first.body.previewImageUrl,
    );
    expect(privatePreview.body.url).toMatch(/^https:\/\/pv-/u);
    const outsider = createBddApi(context).user();
    mocks.clerk.session(outsider.userId, outsider.orgId);
    await accept(api.sitePreview(request), [404]);
  });

  it("reads authored HTML metadata with the hosted-sites credentials even without an uploaded cover", async () => {
    const owner = createBddApi(context).user();
    if (!owner.orgId) {
      throw new Error("Expected an organization");
    }
    const actor = { ...owner, orgId: owner.orgId };
    host.captureHostedSitesS3();
    const html =
      '<html><head><title>Morning coffee</title><meta name="description" content="Fresh coffee daily"><meta property="og:image" content="social-card.png"></head><body>Coffee menu</body></html>';
    const provider = context.mocks.s3.send.getMockImplementation()!;
    context.mocks.s3.send.mockImplementation((cmd, ...args) => {
      if (
        cmd instanceof GetObjectCommand &&
        cmd.input.Key?.endsWith("/index.html")
      ) {
        return Promise.resolve({
          Body: Readable.from([Buffer.from(html)]),
          ContentLength: Buffer.byteLength(html),
        });
      }
      return provider(cmd, ...args);
    });
    const prepared = await host.prepareHostedSite(actor, {
      site: `og-html-${randomUUID().slice(0, 8)}`,
      artifactKind: "hosted-site",
      spaFallback: false,
      visibility: "public",
      files: [hostedTextFile("/index.html", html)],
    });
    await host.completeHostedSite(actor, prepared.deploymentId);
    const og = setupAppWithRoutes({ context, routes: artifactOgRoutes })(
      artifactOgContract,
    );
    context.mocks.s3.clientConfig.mockClear();
    const metadata = await accept(
      og.metadata({ query: { kind: "host", id: prepared.deploymentId } }),
      [200],
    );
    expect(metadata.body).toMatchObject({
      available: true,
      title: "Morning coffee",
      description: "Fresh coffee daily",
    });
    expect(context.mocks.s3.clientConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        credentials: {
          accessKeyId: "test-hosted-sites-access-key",
          secretAccessKey: "test-hosted-sites-secret-key",
        },
      }),
    );
    expect(context.mocks.s3.clientConfig).not.toHaveBeenCalledWith(
      expect.objectContaining({
        credentials: {
          accessKeyId: "test-access-key",
          secretAccessKey: "test-secret-key",
        },
      }),
    );
  });

  it("redirects to the original published cover anonymously, retains older versions, and revokes OG on deletion", async () => {
    const owner = createBddApi(context).user();
    if (!owner.orgId) {
      throw new Error("Expected an organization");
    }
    const actor = { ...owner, orgId: owner.orgId };
    const previewObjects = previewStorage();
    const html =
      '<html><head><title>Quarterly &amp; Annual</title><meta name="description" content="Public summary"></head><body>Report</body></html>';
    const provider = context.mocks.s3.send.getMockImplementation()!;
    context.mocks.s3.send.mockImplementation((cmd, ...args) => {
      if (
        cmd instanceof GetObjectCommand &&
        cmd.input.Key?.endsWith("/index.html")
      ) {
        return Promise.resolve({
          Body: Readable.from([Buffer.from(html)]),
          ContentLength: Buffer.byteLength(html),
          ETag: '"html"',
        });
      }
      return provider(cmd, ...args);
    });
    const og = setupAppWithRoutes({ context, routes: artifactOgRoutes })(
      artifactOgContract,
    );
    const bytes = png;
    const site = `og-${randomUUID().slice(0, 8)}`;
    const first = await host.prepareHostedSite(actor, {
      site,
      artifactKind: "hosted-site",
      spaFallback: false,
      visibility: "public",
      files: [hostedTextFile("/index.html", html)],
      preview: preview(bytes),
    });
    const target = { kind: "host" as const, id: first.deploymentId };
    expect(
      (await accept(og.metadata({ query: target }), [200])).body,
    ).toStrictEqual({
      available: false,
    });
    await upload(first, bytes);
    await host.completeHostedSite(actor, first.deploymentId);
    const metadata = await accept(og.metadata({ query: target }), [200]);
    expect(metadata.body).toMatchObject({
      available: true,
      title: "Quarterly & Annual",
      description: "Public summary",
    });
    if (!metadata.body.available) {
      throw new Error("Expected public OG metadata");
    }
    expect(JSON.stringify(metadata.body)).not.toContain("private-artifacts/");
    expect(metadata.body.imageUrl).toContain("/cdn-cgi/image/");
    const source = metadata.body.imageUrl.split("metadata=none/")[1];
    if (!source) {
      throw new Error("Missing original cover source URL");
    }
    const version = new URL(source).searchParams.get("version")!;
    const imageQuery = { ...target, version };
    const original = await accept(og.image({ query: imageQuery }), [302]);
    const originalUrl = original.headers.get("location");
    if (!originalUrl) {
      throw new Error("Missing original cover redirect");
    }
    const originalObject = new URL(originalUrl).searchParams.get("object");
    const bucketPrefix = `${env("R2_PRIVATE_ARTIFACTS_BUCKET_NAME")}/`;
    if (!originalObject?.startsWith(bucketPrefix)) {
      throw new Error("Missing original cover object in the signing fixture");
    }
    const originalKey = originalObject.slice(bucketPrefix.length);
    expect(previewObjects.get(originalKey)).toStrictEqual(bytes);
    const compact = await accept(
      og.image({ query: { ...imageQuery, variant: "slack" } }),
      [302],
    );
    expect(compact.headers.get("location")).toBe(originalUrl);
    expect(original.headers.get("cache-control")).toBe("private, no-store");
    expect(original.headers.get("cloudflare-cdn-cache-control")).toBe(
      "no-store",
    );
    const brand = await accept(og.defaultImage(), [302]);
    expect(brand.headers.get("location")).toBe(ARTIFACT_OG_BRAND.imageUrl);
    expect(brand.headers.get("cache-control")).toBe("private, no-store");
    const stale = await accept(
      og.image({ query: { ...imageQuery, version: "wrong" } }),
      [302],
    );
    expect(stale.headers.get("location")).toBe(ARTIFACT_OG_BRAND.imageUrl);
    const compactStale = await accept(
      og.image({
        query: { ...imageQuery, version: "wrong", variant: "slack" },
      }),
      [302],
    );
    expect(compactStale.headers.get("location")).toBe(
      ARTIFACT_OG_BRAND.imageUrl,
    );

    const nextBytes = secondPng;
    const second = await host.prepareHostedSite(actor, {
      site,
      artifactKind: "hosted-site",
      spaFallback: false,
      files: [hostedTextFile("/index.html", html)],
      preview: preview(nextBytes),
    });
    await upload(second, nextBytes);
    await host.completeHostedSite(actor, second.deploymentId);
    const retained = await accept(og.image({ query: imageQuery }), [302]);
    expect(retained.headers.get("location")).toBe(originalUrl);
    expect(previewObjects.get(originalKey)).toStrictEqual(bytes);
    await host.deleteHostedSite(actor, first.publicSlug);
    expect(
      (await accept(og.metadata({ query: target }), [200])).body,
    ).toStrictEqual({
      available: false,
    });
    const deleted = await accept(og.image({ query: imageQuery }), [302]);
    expect(deleted.headers.get("location")).toBe(ARTIFACT_OG_BRAND.imageUrl);
  });

  it("keeps the active HTML cover in the catalog across late completions and retries", async () => {
    const fixture = createChatEventsFixture(context);
    const entitled = await fixture.entitledNativeChatActor();
    if (!entitled.actor.orgId) {
      throw new Error("Expected an organization");
    }
    const actor = { ...entitled.actor, orgId: entitled.actor.orgId };
    const run = await fixture.sendChatRun(actor, {
      agentId: entitled.agentId,
      prompt: "Publish a site with a preview",
    });
    const { claim } = await fixture.claimChatRun(
      entitled.runnerGroup,
      run.runId,
    );
    const runner = { bearerToken: okouTokenFromClaim(claim) };
    const features = setupAppWithRoutes({
      context,
      routes: featureSwitchesRoutes,
    })(featureSwitchesContract);
    const headers = { authorization: `Bearer ${runner.bearerToken}` };
    const available = await accept(features.get({ headers }), [200]);
    expect(available.headers.get("cache-control")).toBe("private, no-store");
    await accept(
      features.update({
        headers,
        body: { switches: { [FeatureSwitchKey.Dummy]: false } },
      }),
      [403],
    );
    await accept(features.delete({ headers }), [403]);
    previewStorage();
    const firstImage = png;
    const secondImage = secondPng;
    const body = {
      site: `preview-${randomUUID().slice(0, 8)}`,
      artifactKind: "hosted-site" as const,
      spaFallback: false,
      visibility: "public" as const,
      files: [hostedTextFile("/index.html", "<main>Website</main>")],
    };
    const first = await host.prepareHostedSite(runner, {
      ...body,
      preview: preview(firstImage),
    });
    const second = await host.prepareHostedSite(runner, {
      ...body,
      preview: preview(secondImage),
    });
    await upload(first, firstImage);
    await upload(second, secondImage);
    const latest = await host.completeHostedSite(runner, second.deploymentId);
    const older = await host.completeHostedSite(runner, first.deploymentId);
    expect(older.isActive).toBeFalsy();
    expect(latest.previewImageUrl).toMatch(/\/artifacts\/[a-z0-9]+\.png$/u);
    expect(older.previewImageUrl).not.toBe(latest.previewImageUrl);
    await expect(
      host.completeHostedSite(runner, second.deploymentId),
    ).resolves.toMatchObject({ previewImageUrl: latest.previewImageUrl });
    const catalog = await chat.listArtifactCatalog(actor);
    expect(catalog.artifacts).toStrictEqual([
      expect.objectContaining({
        kind: "hosted-site",
        title: body.site,
        thumbnail: { url: latest.previewImageUrl },
      }),
    ]);
    // A leaked reference is not a credential, even though its parent site is public.
    if (!latest.previewImageUrl) {
      throw new Error("Missing completed preview reference");
    }
    const reference = new URL(latest.previewImageUrl).pathname
      .split("/")
      .at(-1);
    if (!reference) {
      throw new Error("Missing preview reference");
    }
    const references = setupAppWithRoutes({
      context,
      routes: artifactReferenceRoutes,
    })(artifactReferencesContract);
    createRouteMocks(context).clerk.session(actor.userId, actor.orgId);
    await accept(
      references.resolve({
        headers: { authorization: "Bearer clerk-session" },
        params: { reference },
      }),
      [200],
    );
    const outsider = createBddApi(context).user();
    createRouteMocks(context).clerk.session(outsider.userId, outsider.orgId);
    await accept(
      references.resolve({
        headers: { authorization: "Bearer clerk-session" },
        params: { reference },
      }),
      [404],
    );
  });

  it("retries a sealed cover after staging cleanup fails without activating it early", async () => {
    const fixture = createChatEventsFixture(context);
    const entitled = await fixture.entitledNativeChatActor();
    if (!entitled.actor.orgId) {
      throw new Error("Expected an organization");
    }
    const actor = { ...entitled.actor, orgId: entitled.actor.orgId };
    const run = await fixture.sendChatRun(actor, {
      agentId: entitled.agentId,
      prompt: "Publish a site with a retryable preview",
    });
    const { claim } = await fixture.claimChatRun(
      entitled.runnerGroup,
      run.runId,
    );
    const runner = { bearerToken: okouTokenFromClaim(claim) };
    const objects = previewStorage({ failStagingDeleteOnce: true });
    const bytes = jpeg;
    const body = {
      site: `preview-retry-${randomUUID().slice(0, 8)}`,
      artifactKind: "hosted-site" as const,
      spaFallback: false,
      files: [hostedTextFile("/index.html", "<main>Website</main>")],
      preview: preview(bytes, "image/jpeg"),
    };
    const prepared = await host.prepareHostedSite(runner, body);
    await upload(prepared, bytes);
    await host.requestCompleteHostedSite(runner, prepared.deploymentId, [500]);
    const pending = await host.readHostedSiteDeployments(runner, body.site);
    expect(pending.activeDeploymentId).toBeNull();
    expect(pending.deployments[0]?.status).toBe("uploading");
    expect(objects.size).toBe(2);

    const completed = await host.completeHostedSite(
      runner,
      prepared.deploymentId,
    );
    expect(completed.previewImageUrl).toMatch(/\.jpg$/u);
    expect(completed.isActive).toBeTruthy();
    expect([...objects.values()]).toStrictEqual([bytes]);
    expect(objects.size).toBe(1);
    expect([...objects.keys()][0]).not.toMatch(/\/upload$/u);
    await expect(
      host.completeHostedSite(runner, prepared.deploymentId),
    ).resolves.toMatchObject({ previewImageUrl: completed.previewImageUrl });
    expect([...objects.values()]).toStrictEqual([bytes]);
    expect((await chat.listArtifactCatalog(actor)).artifacts).toStrictEqual([
      expect.objectContaining({
        kind: "hosted-site",
        title: body.site,
        thumbnail: { url: completed.previewImageUrl },
      }),
    ]);
  });

  it("does not activate missing or integrity-mismatched previews and permits repair", async () => {
    const owner = createBddApi(context).user();
    if (!owner.orgId) {
      throw new Error("Expected an organization");
    }
    const actor = { ...owner, orgId: owner.orgId };
    const objects = previewStorage();
    const bytes = png;
    const body = {
      site: `preview-errors-${randomUUID().slice(0, 8)}`,
      artifactKind: "hosted-site" as const,
      spaFallback: false,
      files: [hostedTextFile("/index.html", "<main>Website</main>")],
      preview: preview(bytes),
    };
    const prepared = await host.prepareHostedSite(actor, body);
    await host.requestCompleteHostedSite(actor, prepared.deploymentId, [400]);
    await upload(prepared, Buffer.from("incomplete upload"));
    await host.requestCompleteHostedSite(actor, prepared.deploymentId, [400]);
    const mismatched = Buffer.from(bytes);
    mismatched[0] = 0;
    await upload(prepared, mismatched);
    await host.requestCompleteHostedSite(actor, prepared.deploymentId, [400]);
    const pending = await host.readHostedSiteDeployments(actor, body.site);
    expect(pending.activeDeploymentId).toBeNull();
    expect(pending.deployments[0]?.status).toBe("uploading");
    await upload(prepared, bytes);
    const completed = await host.completeHostedSite(
      actor,
      prepared.deploymentId,
    );
    expect(completed.previewImageUrl).toBeDefined();
    expect(
      [...objects.keys()].some((key) => {
        return key.endsWith("/upload");
      }),
    ).toBeFalsy();
    const sealed = [...objects.values()].map((bytes) => {
      return bytes.toString("base64");
    });
    // Replacing the temporary PUT object cannot mutate the sealed preview.
    await upload(prepared, Buffer.from("replaced staging bytes"));
    await expect(
      host.completeHostedSite(actor, prepared.deploymentId),
    ).resolves.toMatchObject({ previewImageUrl: completed.previewImageUrl });

    expect(
      [...objects.values()].map((bytes) => {
        return bytes.toString("base64");
      }),
    ).toStrictEqual(sealed);
  });
});
