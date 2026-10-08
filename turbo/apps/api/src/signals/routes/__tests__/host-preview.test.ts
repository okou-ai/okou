import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { artifactReferencesContract } from "@okouai/api-contracts/contracts/artifact-references";
import type { HostedSitePrepareResponse } from "@okouai/api-contracts/contracts/host";
import { http, HttpResponse } from "msw";
import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { setupAppWithRoutes } from "../../../__tests__/test-app";
import { accept, testContext } from "../../../__tests__/test-context";
import { env } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { artifactReferenceRoutes } from "../artifact-references";
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
function previewStorage() {
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
  it("keeps the active HTML cover in the catalog across late completions and retries", async () => {
    const fixture = createChatEventsFixture(context);
    const entitled = await fixture.entitledNativeChatActor();
    const actor = entitled.actor;
    const run = await fixture.sendChatRun(actor, {
      agentId: entitled.agentId,
      prompt: "Publish a site with a preview",
    });
    const { claim } = await fixture.claimChatRun(
      entitled.runnerGroup,
      run.runId,
    );
    const runner = { bearerToken: okouTokenFromClaim(claim) };
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

  it("does not activate missing, corrupt, or checksum-mismatched previews and permits repair", async () => {
    const actor = createBddApi(context).user();
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
