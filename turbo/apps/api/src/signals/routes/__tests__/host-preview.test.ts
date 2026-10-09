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
import type { HostedSitePrepareResponse } from "@okouai/api-contracts/contracts/host";
import { http, HttpResponse } from "msw";
import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { setupAppWithRoutes } from "../../../__tests__/test-app";
import { accept, testContext } from "../../../__tests__/test-context";
import { env } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { featureSwitchesRoutes } from "../feature-switches";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { artifactReferenceRoutes } from "../artifact-references";
import { artifactOgRoutes } from "../artifact-og";
import { createBddApi } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { hostedTextFile } from "./helpers/api-bdd-host-files";
import { createHostMapsBddApi } from "./helpers/api-bdd-host-maps";
import {
  createChatEventsFixture,
  okouTokenFromClaim,
} from "./helpers/chat-events-fixture";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const host = createHostMapsBddApi(context);
const chat = createChatFilesBddApi(context);

/** Model real uploads through the returned presigned URL; no private DB setup. */
function previewStorage(
  options: { readonly failStagingDeleteOnce?: boolean } = {},
) {
  let failStagingDelete = options.failStagingDeleteOnce ?? false;
  host.captureHostedSitesS3();
  const baseSend = context.mocks.s3.send.getMockImplementation();
  const baseSign = context.mocks.s3.getSignedUrl.getMockImplementation();
  if (!baseSend || !baseSign) {
    throw new Error("Missing object-storage fixture");
  }
  const objects = new Map<string, Buffer>();
  const grants = new Map<string, string>();
  context.mocks.s3.getSignedUrl.mockImplementation(
    (client, command, options) => {
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
            throw new Error("Expected normalized preview bytes");
          }
          objects.set(key, body);
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
        ContentType: "image/png",
        ETag: '"preview"',
      });
    }
    return baseSend(command, ...rest);
  });
  return objects;
}

function image(color = "#2463eb") {
  return sharp({
    create: { width: 1200, height: 630, channels: 3, background: color },
  })
    .png()
    .toBuffer();
}

function preview(bytes: Buffer) {
  return {
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    contentType: "image/png" as const,
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
  it("serves the exact published cover anonymously, retains older versions, and revokes OG on disable or deletion", async () => {
    const owner = createBddApi(context).user();
    if (!owner.orgId) {
      throw new Error("Expected an organization");
    }
    const actor = { ...owner, orgId: owner.orgId };
    await updateFeatureSwitchesForUser(context, actor, {
      artifactPreviews: true,
    });
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
    const bytes = await image("#ee2211");
    const site = `og-${randomUUID().slice(0, 8)}`;
    const first = await host.prepareHostedSite(actor, {
      site,
      artifactKind: "hosted-site",
      spaFallback: false,
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
    const version = new URL(metadata.body.imageUrl).searchParams.get(
      "version",
    )!;
    const imageQuery = { ...target, version };
    const original = await accept(og.image({ query: imageQuery }), [200]);
    const originalBytes = Buffer.from(await original.body.arrayBuffer());
    await expect(sharp(originalBytes).metadata()).resolves.toMatchObject({
      width: 1200,
      height: 630,
    });
    expect(original.headers.get("cache-control")).toBe("private, no-store");
    expect(original.headers.get("cloudflare-cdn-cache-control")).toBe(
      "no-store",
    );
    const generic = Buffer.from(
      await (await accept(og.defaultImage(), [200])).body.arrayBuffer(),
    );
    await expect(sharp(generic).metadata()).resolves.toMatchObject({
      width: 1280,
      height: 800,
    });
    expect(
      Buffer.from(
        await (
          await accept(
            og.image({ query: { ...imageQuery, version: "wrong" } }),
            [200],
          )
        ).body.arrayBuffer(),
      ),
    ).toStrictEqual(generic);

    const nextBytes = await image("#1122ee");
    const second = await host.prepareHostedSite(actor, {
      site,
      artifactKind: "hosted-site",
      spaFallback: false,
      files: [hostedTextFile("/index.html", html)],
      preview: preview(nextBytes),
    });
    await upload(second, nextBytes);
    await host.completeHostedSite(actor, second.deploymentId);
    expect(
      Buffer.from(
        await (
          await accept(og.image({ query: imageQuery }), [200])
        ).body.arrayBuffer(),
      ),
    ).toStrictEqual(originalBytes);
    await updateFeatureSwitchesForUser(context, actor, {
      artifactPreviews: false,
    });
    expect(
      (await accept(og.metadata({ query: target }), [200])).body,
    ).toStrictEqual({
      available: false,
    });
    expect(
      Buffer.from(
        await (
          await accept(og.image({ query: imageQuery }), [200])
        ).body.arrayBuffer(),
      ),
    ).toStrictEqual(generic);
    await updateFeatureSwitchesForUser(context, actor, {
      artifactPreviews: true,
    });
    previewObjects.clear();
    const missing = await accept(og.image({ query: imageQuery }), [200]);
    expect(Buffer.from(await missing.body.arrayBuffer())).toStrictEqual(
      generic,
    );
    await host.deleteHostedSite(actor, first.publicSlug);
    expect(
      (await accept(og.metadata({ query: target }), [200])).body,
    ).toStrictEqual({
      available: false,
    });
    expect(
      Buffer.from(
        await (
          await accept(og.image({ query: imageQuery }), [200])
        ).body.arrayBuffer(),
      ),
    ).toStrictEqual(generic);
    expect(
      (
        await accept(
          og.metadata({ query: { kind: "host", id: randomUUID() } }),
          [200],
        )
      ).body,
    ).toStrictEqual({ available: false });
  });

  it.each(["missing", "corrupt"])(
    "publishes normally with a %s cover when previews are disabled",
    async (coverState) => {
      const owner = createBddApi(context).user();
      if (!owner.orgId) {
        throw new Error("Expected an organization");
      }
      const actor = { ...owner, orgId: owner.orgId };
      previewStorage();
      const bytes = await image();
      const body = {
        site: `preview-switch-${randomUUID().slice(0, 8)}`,
        artifactKind: "hosted-site" as const,
        spaFallback: false,
        files: [hostedTextFile("/index.html", "<main>Website</main>")],
      };
      const ignored = await host.prepareHostedSite(actor, {
        ...body,
        preview: preview(bytes),
      });
      expect(ignored.previewSkipped).toBeTruthy();
      expect(ignored.preview).toBeUndefined();
      const original = await host.completeHostedSite(
        actor,
        ignored.deploymentId,
      );
      expect(original.previewImageUrl).toBeUndefined();
      await updateFeatureSwitchesForUser(context, actor, {
        artifactPreviews: true,
      });
      const prepared = await host.prepareHostedSite(actor, {
        ...body,
        preview: preview(bytes),
      });
      if (coverState === "corrupt") {
        await upload(prepared, Buffer.from("not an image"));
      }
      await updateFeatureSwitchesForUser(context, actor, {
        artifactPreviews: false,
      });
      const skipped = await host.completeHostedSite(
        actor,
        prepared.deploymentId,
      );
      expect(skipped).toMatchObject({
        status: "ready",
        isActive: true,
        previewSkipped: true,
      });
      expect(skipped.previewImageUrl).toBeUndefined();
      expect(
        (await host.readHostedSiteDeployments(actor, body.site))
          .activeDeploymentId,
      ).toBe(prepared.deploymentId);
      await expect(
        host.completeHostedSite(actor, prepared.deploymentId),
      ).resolves.toMatchObject({ previewSkipped: true });
      await updateFeatureSwitchesForUser(context, actor, {
        artifactPreviews: true,
      });
      await upload(prepared, bytes);
      const completed = await host.completeHostedSite(
        actor,
        prepared.deploymentId,
      );
      expect(completed.previewImageUrl).toBeDefined();
      await updateFeatureSwitchesForUser(context, actor, {
        artifactPreviews: false,
      });
      expect(
        (await host.readHostedSiteDeployments(actor, body.site))
          .activeDeploymentId,
      ).toBe(prepared.deploymentId);
    },
  );
  it("keeps the active HTML cover in the catalog across late completions and retries", async () => {
    const fixture = createChatEventsFixture(context);
    const entitled = await fixture.entitledNativeChatActor();
    if (!entitled.actor.orgId) {
      throw new Error("Expected an organization");
    }
    const actor = { ...entitled.actor, orgId: entitled.actor.orgId };
    await updateFeatureSwitchesForUser(context, actor, {
      [FeatureSwitchKey.ArtifactPreviews]: true,
    });
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
    expect(available.body.effectiveSwitches.artifactPreviews).toBeTruthy();
    expect(available.headers.get("cache-control")).toBe("private, no-store");
    await accept(
      features.update({
        headers,
        body: { switches: { artifactPreviews: false } },
      }),
      [403],
    );
    await accept(features.delete({ headers }), [403]);
    previewStorage();
    const firstImage = await image();
    const secondImage = await image("#ee3355");
    const body = {
      site: `preview-${randomUUID().slice(0, 8)}`,
      artifactKind: "hosted-site" as const,
      spaFallback: false,
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
    await updateFeatureSwitchesForUser(context, actor, {
      artifactPreviews: false,
    });
    await host.completeHostedSite(runner, second.deploymentId);
    expect((await chat.listArtifactCatalog(actor)).artifacts).toMatchObject([
      { title: body.site, thumbnail: { url: latest.previewImageUrl } },
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
    await updateFeatureSwitchesForUser(context, actor, {
      [FeatureSwitchKey.ArtifactPreviews]: true,
    });
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
    const bytes = await image();
    const body = {
      site: `preview-retry-${randomUUID().slice(0, 8)}`,
      artifactKind: "hosted-site" as const,
      spaFallback: false,
      files: [hostedTextFile("/index.html", "<main>Website</main>")],
      preview: preview(bytes),
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
    expect(completed.previewImageUrl).toBeDefined();
    expect(completed.isActive).toBeTruthy();
    expect(objects.size).toBe(1);
    expect([...objects.keys()][0]).not.toMatch(/\/upload$/u);
    await expect(
      host.completeHostedSite(runner, prepared.deploymentId),
    ).resolves.toMatchObject({ previewImageUrl: completed.previewImageUrl });
    expect((await chat.listArtifactCatalog(actor)).artifacts).toStrictEqual([
      expect.objectContaining({
        kind: "hosted-site",
        title: body.site,
        thumbnail: { url: completed.previewImageUrl },
      }),
    ]);
  });

  it("does not activate missing, corrupt, or checksum-mismatched previews and permits repair", async () => {
    const owner = createBddApi(context).user();
    if (!owner.orgId) {
      throw new Error("Expected an organization");
    }
    const actor = { ...owner, orgId: owner.orgId };
    await updateFeatureSwitchesForUser(context, actor, {
      [FeatureSwitchKey.ArtifactPreviews]: true,
    });
    const objects = previewStorage();
    const bytes = await image();
    const body = {
      site: `preview-errors-${randomUUID().slice(0, 8)}`,
      artifactKind: "hosted-site" as const,
      spaFallback: false,
      files: [hostedTextFile("/index.html", "<main>Website</main>")],
      preview: preview(bytes),
    };
    const prepared = await host.prepareHostedSite(actor, body);
    await host.requestCompleteHostedSite(actor, prepared.deploymentId, [400]);
    await upload(prepared, Buffer.from("not an image"));
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

    const corrupt = Buffer.from(
      "declared checksum is valid, but this is not PNG data",
    );
    const malformed = await host.prepareHostedSite(actor, {
      ...body,
      preview: preview(corrupt),
    });
    await upload(malformed, corrupt);
    await host.requestCompleteHostedSite(actor, malformed.deploymentId, [400]);
    expect(
      (await host.readHostedSiteDeployments(actor, body.site))
        .activeDeploymentId,
    ).toBe(prepared.deploymentId);
  });
});
