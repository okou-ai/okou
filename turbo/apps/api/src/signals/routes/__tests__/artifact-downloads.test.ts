import {
  CopyObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { artifactDownloadsContract } from "@okouai/api-contracts/contracts/artifact-downloads";
import { artifactReferencesContract } from "@okouai/api-contracts/contracts/artifact-references";
import {
  artifactSharesContract,
  type ArtifactShareTarget,
} from "@okouai/api-contracts/contracts/artifact-shares";
import {
  hostContract,
  type HostedSiteFilesResponse,
} from "@okouai/api-contracts/contracts/host";
import { uploadsContract } from "@okouai/api-contracts/contracts/uploads";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { expect, test } from "vitest";
import { z } from "zod";
import { apiTestS3PresignedUrl } from "../../../__tests__/mocks";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { artifactDownloadRoutes } from "../artifact-downloads";
import { artifactReferenceRoutes } from "../artifact-references";
import { artifactShareRoutes } from "../artifact-shares";
import { hostRoutes } from "../host";
import { uploadsCompleteRoutes } from "../uploads-complete";
import { uploadsPrepareRoutes } from "../uploads-prepare";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createBillingMediaApi } from "./helpers/api-bdd-billing-media";
import { hostedTextFile } from "./helpers/api-bdd-host-files";
import { createHostMapsBddApi } from "./helpers/api-bdd-host-maps";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const mocks = createRouteMocks(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });

function api() {
  return setupApp({
    context,
    routes: [
      ...artifactDownloadRoutes,
      ...artifactReferenceRoutes,
      ...artifactShareRoutes,
      ...hostRoutes,
      ...uploadsPrepareRoutes,
      ...uploadsCompleteRoutes,
    ],
  });
}

function session(actor: ApiTestUser) {
  mocks.clerk.session(actor.userId, actor.orgId);
}

function reference(url: string) {
  return new URL(url, "https://app.okou.ai").pathname.split("/").at(-1)!;
}

function storageKey(url: string) {
  const object = new URL(url).searchParams.get("object");
  expect(object).not.toBeNull();
  return object!.split("/").slice(1).join("/");
}

function runHeaders(actor: ApiTestUser, capabilities: readonly string[]) {
  const seconds = Math.floor(now() / 1000);
  const token = signSandboxJwtForTests({
    scope: "okou",
    userId: actor.userId,
    orgId: actor.orgId!,
    runId: randomUUID(),
    capabilities: [...capabilities],
    iat: seconds,
    exp: seconds + 3600,
  });
  return { authorization: `Bearer ${token}` };
}

async function download(actor: ApiTestUser, url: string) {
  session(actor);
  return await accept(
    api()(artifactDownloadsContract).download({
      headers,
      params: { reference: reference(url) },
    }),
    [200],
  );
}

function cloneReference(actor: ApiTestUser, url: string) {
  return api()(artifactDownloadsContract).files({
    headers: runHeaders(actor, ["host:read"]),
    params: { reference: reference(url) },
  });
}

async function rejectDownload(actor: ApiTestUser, url: string) {
  session(actor);
  const result = await accept(
    api()(artifactDownloadsContract).download({
      headers,
      params: { reference: reference(url) },
    }),
    [404],
  );
  expect(result.body).not.toHaveProperty("site");
  expect(result.body).not.toHaveProperty("url");
}

const siteFiles = Object.freeze([
  hostedTextFile("/index.html", '<a href="pages/report.html">Report</a>'),
  hostedTextFile("/pages/report.html", "<main>Report details</main>"),
  hostedTextFile("/assets/site.css", "main { color: green }", "text/css"),
  hostedTextFile("/assets/site.js", "console.log('report')", "text/javascript"),
  hostedTextFile("/assets/chart.svg", "<svg></svg>", "image/svg+xml"),
]);

async function fixture(privateArtifacts = true) {
  const bdd = createBddApi(context);
  const actor = bdd.user();
  await createRunsApi(context).grantProEntitlement(actor);
  await createBillingMediaApi(context).updateFeatureSwitches(actor, {
    [FeatureSwitchKey.PrivateArtifacts]: privateArtifacts,
  });
  mockEnv("OKOU_API_BACKEND_URL", "https://api.okou.ai");
  mockEnv("APP_URL", "https://app.okou.ai");
  mockEnv("OKOU_PUBLIC_HOST_DOMAIN", "okou.app");
  mockEnv("OKOU_HOST_SCHEME", "https");

  const members = new Set([actor.userId]);
  context.mocks.clerk.organizations.getOrganizationMembershipList.mockImplementation(
    (input) => {
      const params = z
        .object({ organizationId: z.string(), userId: z.array(z.string()) })
        .parse(input);
      return Promise.resolve({
        data: params.userId
          .filter((userId) => {
            return params.organizationId === actor.orgId && members.has(userId);
          })
          .map((userId) => {
            return {
              publicUserData: { userId },
              role: "org:member",
              organization: { id: actor.orgId, name: "Artifact owners" },
            };
          }),
        totalCount: members.size,
      });
    },
  );
  context.mocks.clerk.users.getOrganizationMembershipList.mockImplementation(
    (input) => {
      const { userId } = z.object({ userId: z.string() }).parse(input);
      return Promise.resolve({
        data: members.has(userId)
          ? [{ organization: { id: actor.orgId }, role: "org:member" }]
          : [],
      });
    },
  );

  const objects = new Map<string, string>();
  function etag(body: string) {
    return `"${createHash("md5").update(body).digest("hex")}"`;
  }
  context.mocks.s3.getSignedUrl.mockImplementation((_client, command) => {
    return Promise.resolve(apiTestS3PresignedUrl(command));
  });
  context.mocks.s3.send.mockImplementation((command) => {
    if (command instanceof ListObjectsV2Command) {
      return Promise.resolve({ Contents: [] });
    }
    if (command instanceof HeadObjectCommand) {
      return Promise.resolve({
        ContentLength: 13,
        Metadata: { "artifact-id": command.input.Key?.split("/")[1] },
      });
    }
    if (command instanceof CopyObjectCommand) {
      return Promise.resolve({});
    }
    if (command instanceof PutObjectCommand) {
      const key = command.input.Key!;
      const previous = objects.get(key);
      if (
        (command.input.IfNoneMatch === "*" && previous !== undefined) ||
        (command.input.IfMatch &&
          (previous === undefined || command.input.IfMatch !== etag(previous)))
      ) {
        return Promise.reject(
          Object.assign(new Error("Stale policy write"), {
            name: "PreconditionFailed",
          }),
        );
      }
      objects.set(key, String(command.input.Body));
      return Promise.resolve({});
    }
    if (command instanceof GetObjectCommand) {
      const body =
        objects.get(command.input.Key!) ??
        (command.input.Key?.startsWith("private-sites/")
          ? "Hosted fixture"
          : undefined);
      if (body === undefined) {
        return Promise.reject(
          Object.assign(new Error("Missing"), { name: "NoSuchKey" }),
        );
      }
      return Promise.resolve({
        Body: Readable.from([Buffer.from(body)]),
        ETag: etag(body),
      });
    }
    throw new Error("Unexpected storage operation");
  });

  const host = createHostMapsBddApi(context);
  async function deploy(site = `download-${randomUUID().slice(0, 8)}`) {
    const prepared = await host.prepareHostedSite(actor, {
      site,
      artifactKind: "hosted-site",
      spaFallback: false,
      files: [...siteFiles],
    });
    await host.completeHostedSite(actor, prepared.deploymentId);
    return { ...prepared, site };
  }
  async function share(
    target: ArtifactShareTarget,
    audience: "private" | "organization" | "public",
  ) {
    session(actor);
    return (
      await accept(
        api()(artifactSharesContract).update({
          headers,
          body: { target, audience },
        }),
        [200],
      )
    ).body;
  }
  return { actor, bdd, host, members, deploy, share };
}

function expectCompleteSite(
  site: HostedSiteFilesResponse,
  deploymentId: string,
) {
  expect(site).toMatchObject({ deploymentId, fileCount: siteFiles.length });
  expect(site.size).toBe(
    siteFiles.reduce((total, file) => {
      return total + file.size;
    }, 0),
  );
  expect(site.files).toHaveLength(siteFiles.length);
  expect(site.files).toStrictEqual(
    expect.arrayContaining(
      siteFiles.map((file) => {
        return expect.objectContaining(file);
      }),
    ),
  );
}

function expectSharedSnapshot(site: HostedSiteFilesResponse) {
  const prefix = storageKey(site.files[0]!.downloadUrl).slice(
    0,
    -site.files[0]!.path.length,
  );
  expect(prefix).toMatch(
    /^shared-artifacts\/okou\/[a-f0-9-]{36}\/[a-f0-9-]{36}$/u,
  );
  expect(prefix.endsWith(`/${site.deploymentId}`)).toBeTruthy();
  for (const file of site.files) {
    expect(storageKey(file.downloadUrl)).toBe(`${prefix}${file.path}`);
  }
}

test("downloads every page and asset in an owner-only site", async () => {
  const { actor, host, deploy } = await fixture();
  const site = await deploy();
  const result = await download(actor, site.url);
  expect(result.headers.get("cache-control")).toBe("private, no-store");
  expect(result.body.kind).toBe("html");
  if (result.body.kind !== "html") {
    throw new Error("Expected a hosted-site download");
  }
  expectCompleteSite(result.body.site, site.deploymentId);
  for (const file of result.body.site.files) {
    expect(storageKey(file.downloadUrl)).toBe(
      `private-sites/okou/${site.deploymentId}${file.path}`,
    );
  }
  const cloned = await host.readHostedSiteFiles(
    actor,
    `dpl-${site.deploymentId}`,
  );
  expectCompleteSite(cloned, site.deploymentId);
  const runDownload = await accept(
    api()(artifactDownloadsContract).download({
      headers: runHeaders(actor, ["artifact:read"]),
      params: { reference: reference(site.url) },
    }),
    [200],
  );
  expect(runDownload.body).toStrictEqual(result.body);
  const runClone = await accept(cloneReference(actor, site.url), [200]);
  expect(runClone.headers.get("cache-control")).toBe("private, no-store");
  expect(runClone.body).toStrictEqual(result.body.site);
});

test("only-me sites deny other members and outsiders without exposing a manifest", async () => {
  const { actor, bdd, host, members, deploy } = await fixture();
  const site = await deploy();
  const colleague = bdd.user({ orgId: actor.orgId });
  members.add(colleague.userId);
  for (const reader of [colleague, bdd.user()]) {
    await rejectDownload(reader, site.url);
    await accept(cloneReference(reader, site.url), [404]);
    for (const slug of [site.publicSlug, `dpl-${site.deploymentId}`]) {
      const response = await host.requestHostedSiteFiles(reader, slug, [404]);
      expect(response.body).not.toHaveProperty("files");
    }
  }
});

test("organization downloads and clones use current membership across active organizations", async () => {
  const { actor, bdd, host, members, deploy, share } = await fixture();
  const site = await deploy();
  const target = { kind: "html" as const, id: site.deploymentId };
  const shared = await share(target, "organization");
  const recipient = bdd.user();
  members.add(recipient.userId);
  const runClone = await accept(cloneReference(recipient, shared.url!), [200]);
  expectCompleteSite(runClone.body, site.deploymentId);
  expectSharedSnapshot(runClone.body);

  for (const reader of [recipient, { ...recipient, orgId: null }]) {
    const result = await download(reader, shared.url!);
    if (result.body.kind !== "html") {
      throw new Error("Expected a shared-site download");
    }
    expectCompleteSite(result.body.site, site.deploymentId);
    expectSharedSnapshot(result.body.site);
    const cloned = await host.readHostedSiteFiles(
      reader,
      `dpl-${site.deploymentId}`,
    );
    expectCompleteSite(cloned, site.deploymentId);
    expectSharedSnapshot(cloned);
    expect(cloned).toStrictEqual(result.body.site);
  }

  members.delete(recipient.userId);
  await rejectDownload(recipient, site.url);
  await host.requestHostedSiteFiles(
    recipient,
    `dpl-${site.deploymentId}`,
    [404],
  );
  members.add(recipient.userId);
  await share(target, "private");
  await rejectDownload(recipient, shared.url!);
  await accept(cloneReference(recipient, shared.url!), [404]);
  await host.requestHostedSiteFiles(
    recipient,
    `dpl-${site.deploymentId}`,
    [404],
  );
  await download(actor, site.url);
});

test("public URLs pin the selected snapshot while owners can clone newer private versions", async () => {
  const { actor, bdd, host, deploy, share } = await fixture();
  const first = await deploy();
  const target = { kind: "html" as const, id: first.deploymentId };
  const published = await share(target, "public");
  const hostname = new URL(published.url!).hostname;
  const alias = hostname.split(".")[0]!;
  function clonePublished(reader: ApiTestUser) {
    session(reader);
    return api()(hostContract).files({
      headers,
      params: { publicSlug: alias },
      query: { hostname },
    });
  }
  const second = await deploy(first.site);
  const outsider = bdd.user({ orgId: null });
  const publicRunner = bdd.user();
  const runClone = await accept(cloneReference(publicRunner, first.url), [200]);
  expectCompleteSite(runClone.body, first.deploymentId);
  expectSharedSnapshot(runClone.body);

  const selected = await download(outsider, first.url);
  if (selected.body.kind !== "html") {
    throw new Error("Expected a public-site download");
  }
  expectCompleteSite(selected.body.site, first.deploymentId);
  expectSharedSnapshot(selected.body.site);
  const outsiderClone = await host.readHostedSiteFiles(outsider, alias);
  expectCompleteSite(outsiderClone, first.deploymentId);
  expectSharedSnapshot(outsiderClone);
  for (const reader of [outsider, actor]) {
    const cloned = await accept(clonePublished(reader), [200]);
    expectCompleteSite(cloned.body, first.deploymentId);
    expectSharedSnapshot(cloned.body);
  }
  expectCompleteSite(
    await host.readHostedSiteFiles(actor, first.publicSlug),
    second.deploymentId,
  );
  await rejectDownload(outsider, second.url);
  await host.requestHostedSiteFiles(
    outsider,
    `dpl-${second.deploymentId}`,
    [404],
  );
  await host.requestHostedSiteFiles(outsider, alias, [404], 2);

  await share({ kind: "html", id: second.deploymentId }, "public");
  await rejectDownload(outsider, first.url);
  await host.requestHostedSiteFiles(
    outsider,
    `dpl-${first.deploymentId}`,
    [404],
  );
  const updated = await host.readHostedSiteFiles(outsider, alias);
  expectCompleteSite(updated, second.deploymentId);
  expectSharedSnapshot(updated);

  await share(target, "private");
  await rejectDownload(outsider, second.url);
  await accept(cloneReference(publicRunner, second.url), [404]);
  await host.requestHostedSiteFiles(outsider, alias, [404]);
  const revoked = await accept(clonePublished(actor), [404]);
  expect(revoked.body).not.toHaveProperty("files");
  expectCompleteSite(
    await host.readHostedSiteFiles(actor, first.publicSlug),
    second.deploymentId,
  );
});

test("public downloads still require authentication and the matching read capability", async () => {
  const { actor, host, deploy, share } = await fixture();
  const site = await deploy();
  const published = await share(
    { kind: "html", id: site.deploymentId },
    "public",
  );
  const alias = new URL(published.url!).hostname.split(".")[0]!;

  const insufficientCapability = await accept(
    api()(artifactDownloadsContract).download({
      headers: runHeaders(actor, ["host:read", "file:read", "artifact:write"]),
      params: { reference: reference(site.url) },
    }),
    [403],
  );
  expect(insufficientCapability.body).not.toHaveProperty("site");
  expect(insufficientCapability.body).not.toHaveProperty("url");
  await accept(
    api()(hostContract).files({
      headers: runHeaders(actor, ["artifact:read"]),
      params: { publicSlug: alias },
      query: {},
    }),
    [403],
  );
  await accept(
    api()(artifactDownloadsContract).files({
      headers: runHeaders(actor, ["artifact:read"]),
      params: { reference: reference(site.url) },
    }),
    [403],
  );
  context.mocks.clerk.authenticateRequest.mockResolvedValue({
    isAuthenticated: false,
  });
  await accept(
    api()(artifactDownloadsContract).download({
      headers: {},
      params: { reference: reference(site.url) },
    }),
    [401],
  );
  await accept(
    api()(artifactDownloadsContract).files({
      headers: {},
      params: { reference: reference(site.url) },
    }),
    [401],
  );
  await host.requestHostedSiteFiles(null, alias, [401]);
});

test.each([
  { filename: "report.pdf", contentType: "application/pdf" },
  { filename: "standalone.html", contentType: "text/html" },
])(
  "keeps $filename uploads as single-file downloads",
  async ({ filename, contentType }) => {
    const { actor, bdd, share } = await fixture();
    session(actor);
    const prepared = await accept(
      api()(uploadsContract).prepare({
        headers,
        body: { filename, contentType, size: 13, purpose: "artifact" },
      }),
      [200],
    );
    const completed = await accept(
      api()(uploadsContract).complete({
        headers,
        body: { id: prepared.body.id },
      }),
      [200],
    );
    const own = await download(actor, completed.body.url);
    expect(own.body).toMatchObject({ kind: "file", filename, contentType });
    expect(own.body).not.toHaveProperty("site");
    const legacyRead = await accept(
      api()(artifactReferencesContract).read({
        headers,
        params: { reference: reference(completed.body.url) },
      }),
      [200],
    );
    expect(own.body).toStrictEqual({ kind: "file", ...legacyRead.body });
    await accept(cloneReference(actor, completed.body.url), [404]);

    const target = { kind: "file" as const, id: prepared.body.id };
    await share(target, "public");
    const outsider = bdd.user({ orgId: null });
    const publicDownload = await download(outsider, completed.body.url);
    expect(publicDownload.body).toMatchObject({
      kind: "file",
      filename,
      contentType,
    });
    if (publicDownload.body.kind !== "file") {
      throw new Error("Expected a single-file download");
    }
    const key = storageKey(publicDownload.body.url);
    expect(key).toMatch(
      /^private-artifacts\/[a-f0-9-]{36}\/shares\/[a-f0-9-]{36}\//u,
    );
    expect(
      key.startsWith(`private-artifacts/${target.id}/shares/`),
    ).toBeTruthy();
    expect(key.endsWith(`/${filename}`)).toBeTruthy();
    await share(target, "private");
    await rejectDownload(outsider, completed.body.url);
  },
);

test("legacy public sites are cloneable outside their originating organization", async () => {
  const { bdd, host, deploy } = await fixture(false);
  const site = await deploy();
  const outsider = bdd.user({ orgId: null });
  for (const slug of [site.publicSlug, `dpl-${site.deploymentId}`]) {
    const result = await host.readHostedSiteFiles(outsider, slug);
    expectCompleteSite(result, site.deploymentId);
    for (const file of result.files) {
      expect(storageKey(file.downloadUrl)).toMatch(/^sites\//u);
    }
  }
});

test("a legacy published hostname clones its public version while the owner has a newer private version", async () => {
  const { actor, bdd, host, deploy } = await fixture(false);
  const published = await deploy();
  await createBillingMediaApi(context).updateFeatureSwitches(actor, {
    [FeatureSwitchKey.PrivateArtifacts]: true,
  });
  const privateVersion = await deploy(published.site);
  expect(
    (await host.readHostedSiteFiles(actor, published.publicSlug)).deploymentId,
  ).toBe(privateVersion.deploymentId);

  for (const reader of [actor, bdd.user({ orgId: null })]) {
    session(reader);
    const cloned = await accept(
      api()(hostContract).files({
        headers,
        params: { publicSlug: published.publicSlug },
        query: { hostname: new URL(published.url).hostname },
      }),
      [200],
    );
    expectCompleteSite(cloned.body, published.deploymentId);
    for (const file of cloned.body.files) {
      expect(storageKey(file.downloadUrl)).toMatch(/^sites\//u);
    }
  }
});
