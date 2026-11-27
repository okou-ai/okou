import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import {
  CopyObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { array, object, string } from "zod";
import { beforeEach, expect, test } from "vitest";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  artifactAccessContract,
  type ArtifactVisibilityValue,
} from "@okouai/api-contracts/contracts/artifact-access";
import { artifactCatalogContract } from "@okouai/api-contracts/contracts/artifact-catalog";
import { artifactSharesContract } from "@okouai/api-contracts/contracts/artifact-shares";
import { artifactSharingContract } from "@okouai/api-contracts/contracts/artifact-sharing";
import { hostContract } from "@okouai/api-contracts/contracts/host";
import { hostedSiteSharingContract } from "@okouai/api-contracts/contracts/hosted-site-sharing";
import { uploadsContract } from "@okouai/api-contracts/contracts/uploads";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupAppWithRoutes } from "../../../__tests__/test-app";
import { now } from "../../../lib/time";
import { artifactAccessRoutes } from "../artifact-access";
import { artifactCatalogRoutes } from "../artifact-catalog";
import { artifactShareRoutes } from "../artifact-shares";
import { artifactSharingRoutes } from "../artifact-sharing";
import { hostRoutes } from "../host";
import { uploadsCompleteRoutes } from "../uploads-complete";
import { uploadsPrepareRoutes } from "../uploads-prepare";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createHostBddApi } from "./helpers/api-bdd-host";
import { hostedTextFile } from "./helpers/api-bdd-host-files";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { mockClerkUsers } from "./helpers/clerk-users";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const headers = { authorization: "Bearer clerk-session" } as const;

beforeEach(() => {
  context.mocks.resend.send.mockResolvedValue({
    data: { id: randomUUID() },
    error: null,
  });
});

function app(user: ApiTestUser) {
  createRouteMocks(context).clerk.session(
    user.userId,
    user.orgId,
    user.orgRole,
  );
  context.mocks.clerk.authenticateRequest.mockImplementation((request) => {
    return Promise.resolve({
      isAuthenticated:
        request instanceof Request &&
        request.headers.get("Authorization") === headers.authorization,
      toAuth: () => {
        return {
          userId: user.userId,
          orgId: user.orgId,
          orgRole: user.orgRole,
          sessionId: `sess_${user.userId}`,
        };
      },
    });
  });
  context.mocks.clerk.sessions.getSession.mockResolvedValue({
    id: `sess_${user.userId}`,
    userId: user.userId,
    status: "active",
    expireAt: now() + 86_400_000,
  });
  return setupAppWithRoutes({
    context,
    routes: [
      ...artifactAccessRoutes,
      ...artifactCatalogRoutes,
      ...artifactSharingRoutes,
      ...artifactShareRoutes,
      ...hostRoutes,
      ...uploadsPrepareRoutes,
      ...uploadsCompleteRoutes,
    ],
    baseUrl: "https://api.okou.ai",
  });
}

function profile(user: ApiTestUser, firstName = "Taylor", lastName = "Owner") {
  const emailId = `em_${user.userId}`;
  return {
    id: user.userId,
    firstName,
    lastName,
    imageUrl: null,
    banned: false,
    primaryEmailAddressId: emailId,
    emailAddresses: [
      {
        id: emailId,
        emailAddress: user.email,
        verification: { status: "verified" as const },
      },
    ],
  };
}

function directory(
  profiles: ReturnType<typeof profile>[],
  members: ApiTestUser[],
) {
  mockClerkUsers(context, profiles);
  context.mocks.clerk.organizations.getOrganization.mockImplementation(
    (input) => {
      const params = object({ organizationId: string() }).parse(input);
      return Promise.resolve({
        id: params.organizationId,
        name: "Sharing workspace",
      });
    },
  );
  context.mocks.clerk.users.getUserList.mockImplementation((input) => {
    const params = object({ userId: array(string()) }).parse(input);
    return Promise.resolve({
      data: profiles.filter((user) => {
        return params.userId.includes(user.id);
      }),
    });
  });
  context.mocks.clerk.organizations.getOrganizationMembershipList.mockImplementation(
    (input) => {
      const params = object({
        organizationId: string(),
        userId: array(string()).optional(),
        emailAddress: array(string()).optional(),
      }).parse(input);
      return Promise.resolve({
        data: members
          .filter((member) => {
            return (
              member.orgId === params.organizationId &&
              (!params.userId || params.userId.includes(member.userId)) &&
              (!params.emailAddress ||
                params.emailAddress.includes(member.email))
            );
          })
          .map((member) => {
            return {
              publicUserData: { userId: member.userId },
              organization: { id: member.orgId, name: "Sharing workspace" },
            };
          }),
      });
    },
  );
}

function installFileStorageMock(contentType: string) {
  const objects = new Map<string, Buffer>();
  context.mocks.s3.send.mockImplementation((operation) => {
    if (operation instanceof HeadObjectCommand) {
      const key = operation.input.Key ?? "";
      const stored = objects.get(key);
      return Promise.resolve({
        ContentLength: stored?.length ?? 13,
        ContentType: contentType,
        ETag: '"etag"',
      });
    }
    if (operation instanceof ListObjectsV2Command) {
      return Promise.resolve({ Contents: [] });
    }
    if (operation instanceof CopyObjectCommand) {
      const dest = operation.input.Key ?? "";
      objects.set(dest, Buffer.from("copied-content"));
      return Promise.resolve({ CopyObjectResult: { ETag: '"copied"' } });
    }
    if (operation instanceof PutObjectCommand) {
      const key = operation.input.Key ?? "";
      const body = operation.input.Body;
      objects.set(
        key,
        typeof body === "string"
          ? Buffer.from(body)
          : body instanceof Uint8Array
            ? Buffer.from(body)
            : Buffer.from(""),
      );
      return Promise.resolve({ ETag: '"stored"' });
    }
    if (operation instanceof GetObjectCommand) {
      const key = operation.input.Key ?? "";
      const body = objects.get(key);
      if (!body) {
        return Promise.reject(
          Object.assign(new Error("Missing"), { name: "NoSuchKey" }),
        );
      }
      return Promise.resolve({
        Body: Readable.from([body]),
        ETag: `"${createHash("md5").update(body).digest("hex")}"`,
      });
    }
    throw new Error("Unexpected storage operation");
  });
  return objects;
}

async function createFileArtifact(
  owner: ApiTestUser,
  filename: string,
  contentType: string,
) {
  const objects = installFileStorageMock(contentType);
  const prepared = await accept(
    app(owner)(uploadsContract).prepare({
      headers,
      body: { filename, contentType, size: 13, purpose: "artifact" },
    }),
    [200],
  );
  await accept(
    app(owner)(uploadsContract).complete({
      headers,
      body: { id: prepared.body.id },
    }),
    [200],
  );
  const catalog = await accept(
    app(owner)(artifactCatalogContract).list({
      headers,
      query: {},
    }),
    [200],
  );
  const entry = catalog.body.artifacts[0];
  if (!entry) {
    throw new Error("Expected catalog entry after artifact upload");
  }
  return { fileId: prepared.body.id, artifactId: entry.id, objects };
}

async function createHostedArtifact(
  owner: ApiTestUser,
  artifactKind: "hosted-site" | "presentation-html",
  visibility: ArtifactVisibilityValue = "private",
) {
  const bdd = createBddApi(context);
  const runs = createRunsApi(context);
  bdd.acceptStorageWrites();
  runs.acceptStorageDownloads();
  runs.acceptTelemetryIngest();
  const runnerGroup = await runs.configureRunnerGroup();
  await runs.grantProEntitlement(owner);
  await runs.ensurePersonalSubscriptionModel(owner);
  await runs.heartbeatRunner(runnerGroup);
  const run = await runs.createThreadRun(owner, {
    prompt: `publish ${artifactKind}`,
  });
  const execution = await runs.executionInput(run.runId);
  const bearerToken = execution.platformEnvironment.OKOU_TOKEN;
  if (!bearerToken) {
    throw new Error("Expected OKOU_TOKEN in run execution platformEnvironment");
  }

  const host = createHostBddApi(context);
  host.captureHostedSitesS3();
  const siteSlug = `unified-${artifactKind}-${randomUUID().slice(0, 8)}`;
  const expectedTitle =
    artifactKind === "presentation-html" ? "Unified Deck" : "Unified Site";
  const expectedKind =
    artifactKind === "presentation-html" ? "presentation" : "hosted-site";
  const prepared = await host.prepareHostedSite(
    { bearerToken },
    {
      site: siteSlug,
      title: expectedTitle,
      artifactKind,
      spaFallback: false,
      visibility,
      files: [hostedTextFile("/index.html", "<h1>Unified Artifact</h1>")],
    },
  );
  await host.completeHostedSite({ bearerToken }, prepared.deploymentId);
  const catalog = await accept(
    app(owner)(artifactCatalogContract).list({ headers, query: {} }),
    [200],
  );
  const entry = catalog.body.artifacts.find((item) => {
    return item.kind === expectedKind && item.title === expectedTitle;
  });
  if (!entry) {
    throw new Error(`Expected catalog entry for ${artifactKind}`);
  }
  return {
    siteId: prepared.siteId,
    siteSlug,
    deploymentId: prepared.deploymentId,
    artifactId: entry.id,
    kind: entry.kind,
    visibility: entry.visibility,
    bearerToken,
    host,
  };
}

test("unified artifact visibility bidirectionally syncs file artifacts", async () => {
  const owner = createBddApi(context).user();
  directory([profile(owner)], [owner]);

  const { fileId, artifactId } = await createFileArtifact(
    owner,
    "report.pdf",
    "application/pdf",
  );

  // 1. Update via new unified PATCH /api/artifacts/:artifactId/visibility
  const patched = await accept(
    app(owner)(artifactAccessContract).updateVisibility({
      headers,
      params: { artifactId },
      body: { visibility: "organization" },
    }),
    [200],
  );
  expect(patched.body.artifactId).toBe(artifactId);
  expect(patched.body.visibility).toBe("organization");

  // Legacy POST /api/artifact-shares/status observes the update
  const legacyStatus = await accept(
    app(owner)(artifactSharesContract).status({
      headers,
      body: { kind: "file", id: fileId },
    }),
    [200],
  );
  expect(legacyStatus.body.audience).toBe("organization");

  // Catalog reflects the synced visibility
  const catalog = await accept(
    app(owner)(artifactCatalogContract).list({ headers, query: {} }),
    [200],
  );
  expect(catalog.body.artifacts[0]?.visibility).toBe("organization");

  // 2. Update via legacy PUT /api/artifact-shares -> unified GET & catalog reflect it
  await accept(
    app(owner)(artifactSharesContract).update({
      headers,
      body: { target: { kind: "file", id: fileId }, audience: "private" },
    }),
    [200],
  );

  const unifiedRead = await accept(
    app(owner)(artifactAccessContract).getVisibility({
      headers,
      params: { artifactId },
    }),
    [200],
  );
  expect(unifiedRead.body.visibility).toBe("private");
  expect(unifiedRead.body.shareUrl).toBeNull();
});

test("unified file visibility read-repairs drifted artifacts.visibility from legacy R2 policy", async () => {
  const owner = createBddApi(context).user();
  directory([profile(owner)], [owner]);

  const { fileId, artifactId, objects } = await createFileArtifact(
    owner,
    "legacy-shared.pdf",
    "application/pdf",
  );

  await accept(
    app(owner)(artifactSharesContract).update({
      headers,
      body: { target: { kind: "file", id: fileId }, audience: "organization" },
    }),
    [200],
  );
  const policyEntry = [...objects.entries()].find(([key]) => {
    return key.startsWith("artifact-shares/") && key.endsWith(".json");
  });
  if (!policyEntry) {
    throw new Error("Expected R2 policy object for shared file");
  }
  const [policyKey, orgPolicyBuffer] = policyEntry;

  await accept(
    app(owner)(artifactSharesContract).update({
      headers,
      body: { target: { kind: "file", id: fileId }, audience: "private" },
    }),
    [200],
  );
  const beforeRepairCatalog = await accept(
    app(owner)(artifactCatalogContract).list({ headers, query: {} }),
    [200],
  );
  expect(beforeRepairCatalog.body.artifacts[0]?.visibility).toBe("private");

  // Simulate pre-R1 drift: R2 policy says "organization" while artifacts.visibility is "private".
  objects.set(policyKey, orgPolicyBuffer);

  const repaired = await accept(
    app(owner)(artifactAccessContract).getVisibility({
      headers,
      params: { artifactId },
    }),
    [200],
  );
  expect(repaired.body.visibility).toBe("organization");

  const afterRepairCatalog = await accept(
    app(owner)(artifactCatalogContract).list({ headers, query: {} }),
    [200],
  );
  expect(afterRepairCatalog.body.artifacts[0]?.visibility).toBe("organization");
});

test.each([
  ["hosted-site", "public"],
  ["hosted-site", "organization"],
  ["presentation-html", "public"],
  ["presentation-html", "organization"],
] as const)(
  "newly published %s initializes artifacts.visibility to %s and preserves it on re-publish",
  async (artifactKind, initialVisibility) => {
    const owner = createBddApi(context).user();
    directory([profile(owner)], [owner]);

    const created = await createHostedArtifact(
      owner,
      artifactKind,
      initialVisibility,
    );
    expect(created.visibility).toBe(initialVisibility);

    // Re-publish without specifying --visibility must preserve non-private visibility
    const republished = await created.host.prepareHostedSite(
      { bearerToken: created.bearerToken },
      {
        site: created.siteSlug,
        title: "Republished Hosted Artifact",
        artifactKind,
        spaFallback: false,
        files: [hostedTextFile("/index.html", "<h1>Republished</h1>")],
      },
    );
    await created.host.completeHostedSite(
      { bearerToken: created.bearerToken },
      republished.deploymentId,
    );

    const catalogAfterRepublish = await accept(
      app(owner)(artifactCatalogContract).list({ headers, query: {} }),
      [200],
    );
    expect(
      catalogAfterRepublish.body.artifacts.find((item) => {
        return item.id === created.artifactId;
      })?.visibility,
    ).toBe(initialVisibility);
  },
);

test("unified artifact shares support userId primary path, email fallback, non-member rejection, and DELETE by userId", async () => {
  const owner = createBddApi(context).user();
  const colleague = { ...createBddApi(context).user(), orgId: owner.orgId };
  const secondColleague = {
    ...createBddApi(context).user(),
    orgId: owner.orgId,
  };
  if (!owner.orgId) {
    throw new Error("Fixture requires orgId");
  }
  await updateFeatureSwitchesForUser(
    context,
    { ...owner, orgId: owner.orgId },
    {
      [FeatureSwitchKey.ArtifactUserSharing]: true,
      [FeatureSwitchKey.HostedSiteEmailSharing]: true,
    },
  );
  directory(
    [
      profile(owner, "Owner", "User"),
      profile(colleague, "Alice", "Member"),
      profile(secondColleague, "Bob", "Member"),
    ],
    [owner, colleague, secondColleague],
  );

  const { fileId, artifactId } = await createFileArtifact(
    owner,
    "deck.pdf",
    "application/pdf",
  );

  // 1. Primary path: add by userId
  const addByUserId = await accept(
    app(owner)(artifactAccessContract).addShare({
      headers,
      params: { artifactId },
      body: { userId: colleague.userId },
    }),
    [200],
  );
  expect(addByUserId.body.share).toStrictEqual({
    userId: colleague.userId,
    email: colleague.email,
    name: "Alice Member",
  });

  // 2. Fallback path: add by email (resolved in current org directory)
  const addByEmail = await accept(
    app(owner)(artifactAccessContract).addShare({
      headers,
      params: { artifactId },
      body: { email: secondColleague.email },
    }),
    [200],
  );
  expect(addByEmail.body.share).toStrictEqual({
    userId: secondColleague.userId,
    email: secondColleague.email,
    name: "Bob Member",
  });

  // 3. Reject non-workspace members (both email and userId) with 400
  await accept(
    app(owner)(artifactAccessContract).addShare({
      headers,
      params: { artifactId },
      body: { email: "outsider@external.example" },
    }),
    [400],
  );
  await accept(
    app(owner)(artifactAccessContract).addShare({
      headers,
      params: { artifactId },
      body: { userId: "user_non_member" },
    }),
    [400],
  );

  // 4. Reject self-share
  await accept(
    app(owner)(artifactAccessContract).addShare({
      headers,
      params: { artifactId },
      body: { userId: owner.userId },
    }),
    [400],
  );

  // Legacy GET /api/artifact-sharing/file/:fileId/shares observes both grants
  const legacyList = await accept(
    app(owner)(artifactSharingContract).list({
      headers,
      params: { kind: "file", id: fileId },
    }),
    [200],
  );
  expect(
    legacyList.body.shares
      .map((s) => {
        return s.email;
      })
      .sort(),
  ).toStrictEqual([colleague.email, secondColleague.email].sort());

  // 5. Remove via unified DELETE /api/artifacts/:artifactId/shares/:userId
  const removedFirst = await accept(
    app(owner)(artifactAccessContract).removeShare({
      headers,
      params: { artifactId, userId: colleague.userId },
    }),
    [200],
  );
  expect(removedFirst.body).toStrictEqual({ removed: colleague.userId });

  const afterRemoveUnified = await accept(
    app(owner)(artifactAccessContract).listShares({
      headers,
      params: { artifactId },
    }),
    [200],
  );
  expect(afterRemoveUnified.body.shares).toStrictEqual([
    {
      userId: secondColleague.userId,
      email: secondColleague.email,
      name: "Bob Member",
    },
  ]);

  // Removing a second time returns 404
  await accept(
    app(owner)(artifactAccessContract).removeShare({
      headers,
      params: { artifactId, userId: colleague.userId },
    }),
    [404],
  );
});

test("unified /shares routes are gated by ArtifactUserSharing independently from HostedSiteEmailSharing", async () => {
  const owner = createBddApi(context).user();
  if (!owner.orgId) {
    throw new Error("Fixture requires orgId");
  }
  await updateFeatureSwitchesForUser(
    context,
    { ...owner, orgId: owner.orgId },
    {
      [FeatureSwitchKey.HostedSiteEmailSharing]: true,
      [FeatureSwitchKey.ArtifactUserSharing]: false,
    },
  );
  directory([profile(owner)], [owner]);

  const { fileId, artifactId } = await createFileArtifact(
    owner,
    "gated.pdf",
    "application/pdf",
  );

  // Legacy route stays available under HostedSiteEmailSharing
  await accept(
    app(owner)(artifactSharingContract).list({
      headers,
      params: { kind: "file", id: fileId },
    }),
    [200],
  );

  // Unified route stays hidden while ArtifactUserSharing is off
  await accept(
    app(owner)(artifactAccessContract).listShares({
      headers,
      params: { artifactId },
    }),
    [404],
  );

  await updateFeatureSwitchesForUser(
    context,
    { ...owner, orgId: owner.orgId },
    { [FeatureSwitchKey.ArtifactUserSharing]: true },
  );

  const allowed = await accept(
    app(owner)(artifactAccessContract).listShares({
      headers,
      params: { artifactId },
    }),
    [200],
  );
  expect(allowed.body.shares).toStrictEqual([]);
});

async function assertHostedArtifactBidirectionalSync(
  artifactKind: "hosted-site" | "presentation-html",
) {
  const owner = createBddApi(context).user();
  const colleague = { ...createBddApi(context).user(), orgId: owner.orgId };
  const secondColleague = {
    ...createBddApi(context).user(),
    orgId: owner.orgId,
  };
  if (!owner.orgId) {
    throw new Error("Fixture requires orgId");
  }
  await updateFeatureSwitchesForUser(
    context,
    { ...owner, orgId: owner.orgId },
    {
      [FeatureSwitchKey.ArtifactUserSharing]: true,
      [FeatureSwitchKey.HostedSiteEmailSharing]: true,
    },
  );
  const created = await createHostedArtifact(owner, artifactKind);
  expect(created.kind).toBe(
    artifactKind === "presentation-html" ? "presentation" : "hosted-site",
  );
  directory(
    [
      profile(owner, "Owner", "User"),
      profile(colleague, "Alice", "Member"),
      profile(secondColleague, "Bob", "Member"),
    ],
    [owner, colleague, secondColleague],
  );

  // 1. Unified PATCH by canonical artifactId (without revision) -> legacy GET + catalog observe it
  const patched = await accept(
    app(owner)(artifactAccessContract).updateVisibility({
      headers,
      params: { artifactId: created.artifactId },
      body: { visibility: "organization" },
    }),
    [200],
  );
  expect(patched.body.artifactId).toBe(created.artifactId);
  expect(patched.body.visibility).toBe("organization");

  const legacyRead = await accept(
    app(owner)(hostContract).siteVisibility({
      headers,
      params: { siteId: created.siteId },
    }),
    [200],
  );
  expect(legacyRead.body.visibility).toBe("organization");

  // 2. Legacy PATCH -> unified GET (both by canonical artifactId and siteId fallback) + catalog observe it
  await accept(
    app(owner)(hostContract).updateSiteVisibility({
      headers,
      params: { siteId: created.siteId },
      body: {
        visibility: "public",
        expectedRevision: legacyRead.body.revision,
      },
    }),
    [200],
  );

  const byArtifactId = await accept(
    app(owner)(artifactAccessContract).getVisibility({
      headers,
      params: { artifactId: created.artifactId },
    }),
    [200],
  );
  expect(byArtifactId.body.visibility).toBe("public");
  expect(byArtifactId.body.artifactId).toBe(created.artifactId);

  const bySiteId = await accept(
    app(owner)(artifactAccessContract).getVisibility({
      headers,
      params: { artifactId: created.siteId },
    }),
    [200],
  );
  expect(bySiteId.body.visibility).toBe("public");
  expect(bySiteId.body.artifactId).toBe(created.artifactId);

  const catalog = await accept(
    app(owner)(artifactCatalogContract).list({ headers, query: {} }),
    [200],
  );
  expect(
    catalog.body.artifacts.find((item) => {
      return item.id === created.artifactId;
    })?.visibility,
  ).toBe("public");

  // 3. Bidirectional per-user shares sync between unified /shares and hosted_site_shares
  const addedUnified = await accept(
    app(owner)(artifactAccessContract).addShare({
      headers,
      params: { artifactId: created.artifactId },
      body: { userId: colleague.userId },
    }),
    [200],
  );
  expect(addedUnified.body.share).toStrictEqual({
    userId: colleague.userId,
    email: colleague.email,
    name: "Alice Member",
  });

  const legacySharesAfterAdd = await accept(
    app(owner)(hostedSiteSharingContract).list({
      headers,
      params: { siteId: created.siteId },
    }),
    [200],
  );
  expect(
    legacySharesAfterAdd.body.shares.map((s) => {
      return s.email;
    }),
  ).toStrictEqual([colleague.email]);

  const addedLegacy = await accept(
    app(owner)(hostedSiteSharingContract).share({
      headers,
      params: { siteId: created.siteId },
      body: { email: secondColleague.email },
    }),
    [200],
  );

  const unifiedSharesAfterLegacyAdd = await accept(
    app(owner)(artifactAccessContract).listShares({
      headers,
      params: { artifactId: created.artifactId },
    }),
    [200],
  );
  expect(
    unifiedSharesAfterLegacyAdd.body.shares
      .map((s) => {
        return s.userId;
      })
      .sort(),
  ).toStrictEqual([colleague.userId, secondColleague.userId].sort());

  // Remove unified share by userId -> disappears from legacy
  await accept(
    app(owner)(artifactAccessContract).removeShare({
      headers,
      params: {
        artifactId: created.artifactId,
        userId: colleague.userId,
      },
    }),
    [200],
  );

  // Remove legacy share -> disappears from unified
  await accept(
    app(owner)(hostedSiteSharingContract).remove({
      headers,
      params: { siteId: created.siteId, shareId: addedLegacy.body.share.id },
    }),
    [200],
  );

  const finalUnifiedShares = await accept(
    app(owner)(artifactAccessContract).listShares({
      headers,
      params: { artifactId: created.artifactId },
    }),
    [200],
  );
  return {
    kind: created.kind,
    remainingShares: finalUnifiedShares.body.shares.length,
  };
}

test("unified artifact visibility and shares bidirectionally sync for hosted-site artifacts", async () => {
  const result = await assertHostedArtifactBidirectionalSync("hosted-site");
  expect(result).toStrictEqual({ kind: "hosted-site", remainingShares: 0 });
});

test("unified artifact visibility and shares bidirectionally sync for presentation artifacts", async () => {
  const result =
    await assertHostedArtifactBidirectionalSync("presentation-html");
  expect(result).toStrictEqual({ kind: "presentation", remainingShares: 0 });
});

test("unified artifact visibility works for standalone hosted sites without an artifacts catalog row", async () => {
  const owner = createBddApi(context).user();
  directory([profile(owner)], [owner]);

  const host = createHostBddApi(context);
  host.captureHostedSitesS3();
  const prepared = await host.prepareHostedSite(owner, {
    site: `standalone-${randomUUID().slice(0, 8)}`,
    title: "Standalone PAT Site",
    artifactKind: "hosted-site",
    spaFallback: false,
    visibility: "private",
    files: [hostedTextFile("/index.html", "<p>Standalone</p>")],
  });
  await host.completeHostedSite(owner, prepared.deploymentId);

  const patched = await accept(
    app(owner)(artifactAccessContract).updateVisibility({
      headers,
      params: { artifactId: prepared.siteId },
      body: { visibility: "organization" },
    }),
    [200],
  );
  expect(patched.body.artifactId).toBe(prepared.siteId);
  expect(patched.body.visibility).toBe("organization");

  const legacyRead = await accept(
    app(owner)(hostContract).siteVisibility({
      headers,
      params: { siteId: prepared.siteId },
    }),
    [200],
  );
  expect(legacyRead.body.visibility).toBe("organization");
});

test("addShare returns 404 for unowned or missing artifacts before membership lookup or quota", async () => {
  const owner = createBddApi(context).user();
  const otherOwner = { ...createBddApi(context).user(), orgId: owner.orgId };
  const colleague = { ...createBddApi(context).user(), orgId: owner.orgId };
  if (!owner.orgId) {
    throw new Error("Fixture requires orgId");
  }
  await updateFeatureSwitchesForUser(
    context,
    { ...owner, orgId: owner.orgId },
    { [FeatureSwitchKey.ArtifactUserSharing]: true },
  );
  directory(
    [
      profile(owner, "Owner", "User"),
      profile(otherOwner, "Other", "Owner"),
      profile(colleague, "Alice", "Member"),
    ],
    [owner, otherOwner, colleague],
  );

  const { artifactId: foreignArtifactId } = await createFileArtifact(
    otherOwner,
    "foreign.pdf",
    "application/pdf",
  );
  const { artifactId: ownArtifactId } = await createFileArtifact(
    owner,
    "owned.pdf",
    "application/pdf",
  );
  const missingArtifactId = randomUUID();

  // Fail Clerk membership lookup to prove ownership check short-circuits first
  context.mocks.clerk.organizations.getOrganizationMembershipList.mockRejectedValue(
    new Error("Clerk directory should not be queried for unowned artifacts"),
  );

  for (const targetId of [foreignArtifactId, missingArtifactId]) {
    await accept(
      app(owner)(artifactAccessContract).addShare({
        headers,
        params: { artifactId: targetId },
        body: { email: "outsider@external.example" },
      }),
      [404],
    );
    await accept(
      app(owner)(artifactAccessContract).addShare({
        headers,
        params: { artifactId: targetId },
        body: { userId: colleague.userId },
      }),
      [404],
    );
    await accept(
      app(owner)(artifactAccessContract).addShare({
        headers,
        params: { artifactId: targetId },
        body: { userId: owner.userId },
      }),
      [404],
    );
  }

  // Restore directory and confirm owner can still share their own artifact
  directory(
    [
      profile(owner, "Owner", "User"),
      profile(otherOwner, "Other", "Owner"),
      profile(colleague, "Alice", "Member"),
    ],
    [owner, otherOwner, colleague],
  );
  const granted = await accept(
    app(owner)(artifactAccessContract).addShare({
      headers,
      params: { artifactId: ownArtifactId },
      body: { userId: colleague.userId },
    }),
    [200],
  );
  expect(granted.body.share.userId).toBe(colleague.userId);
});

test("hosted-site visibility read propagates unexpected Clerk lookup errors instead of fabricating orgId", async () => {
  const owner = createBddApi(context).user();
  directory([profile(owner)], [owner]);
  const created = await createHostedArtifact(owner, "hosted-site");

  context.mocks.clerk.organizations.getOrganization.mockRejectedValueOnce(
    new Error("Clerk upstream unavailable"),
  );

  const failed = await accept(
    app(owner)(artifactAccessContract).getVisibility({
      headers,
      params: { artifactId: created.artifactId },
    }),
    [500],
  );
  expect(failed.status).toBe(500);
});

test("composer user uploads and library artifact deletion succeed cleanly with files dual-write active", async () => {
  const owner = createBddApi(context).user();
  directory([profile(owner)], [owner]);

  installFileStorageMock("text/plain");
  const userUpload = await accept(
    app(owner)(uploadsContract).prepare({
      headers,
      body: { filename: "notes.txt", contentType: "text/plain", size: 13 },
    }),
    [200],
  );
  await accept(
    app(owner)(uploadsContract).complete({
      headers,
      body: { id: userUpload.body.id },
    }),
    [200],
  );

  const { artifactId } = await createFileArtifact(
    owner,
    "deliverable.pdf",
    "application/pdf",
  );
  await accept(
    app(owner)(artifactCatalogContract).delete({
      headers,
      params: { artifactId },
    }),
    [200],
  );

  const catalogAfterDelete = await accept(
    app(owner)(artifactCatalogContract).list({ headers, query: {} }),
    [200],
  );
  expect(
    catalogAfterDelete.body.artifacts.some((item) => {
      return item.id === artifactId;
    }),
  ).toBeFalsy();
});

test("run-scoped private artifact upload completes cleanly and exposes unified visibility without duplicate catalog entries", async () => {
  const owner = createBddApi(context).user();

  const bdd = createBddApi(context);
  const runs = createRunsApi(context);
  bdd.acceptStorageWrites();
  runs.acceptStorageDownloads();
  runs.acceptTelemetryIngest();
  const runnerGroup = await runs.configureRunnerGroup();
  await runs.grantProEntitlement(owner);
  await runs.ensurePersonalSubscriptionModel(owner);
  await runs.heartbeatRunner(runnerGroup);
  const run = await runs.createThreadRun(owner, {
    prompt: "upload run-scoped private deliverable",
  });
  const execution = await runs.executionInput(run.runId);
  const bearerToken = execution.platformEnvironment.OKOU_TOKEN;
  if (!bearerToken) {
    throw new Error("Expected OKOU_TOKEN in run execution platformEnvironment");
  }
  const runHeaders = { authorization: `Bearer ${bearerToken}` } as const;

  directory([profile(owner)], [owner]);
  installFileStorageMock("application/pdf");
  const prepared = await accept(
    app(owner)(uploadsContract).prepare({
      headers: runHeaders,
      body: {
        filename: "run-report.pdf",
        contentType: "application/pdf",
        size: 13,
        purpose: "artifact",
      },
    }),
    [200],
  );
  await accept(
    app(owner)(uploadsContract).complete({
      headers: runHeaders,
      body: { id: prepared.body.id },
    }),
    [200],
  );

  const catalog = await accept(
    app(owner)(artifactCatalogContract).list({ headers, query: {} }),
    [200],
  );
  const matching = catalog.body.artifacts.filter((item) => {
    return item.title === "run-report.pdf";
  });
  expect(matching).toHaveLength(1);
  const artifactId = matching[0]!.id;

  const visibility = await accept(
    app(owner)(artifactAccessContract).getVisibility({
      headers,
      params: { artifactId },
    }),
    [200],
  );
  expect(visibility.body.artifactId).toBe(artifactId);
  expect(visibility.body.visibility).toBe("private");

  // Addressing the run-scoped private file by its canonical fileId (e.g. from a
  // chat link) must resolve to the same artifact even after the shadow row updated
  // projection_file_id.
  const byFileId = await accept(
    app(owner)(artifactAccessContract).getVisibility({
      headers,
      params: { artifactId: prepared.body.id },
    }),
    [200],
  );
  expect(byFileId.body.artifactId).toBe(artifactId);
  expect(byFileId.body.visibility).toBe("private");

  // Legacy PUT /api/artifact-shares must still dual-write artifacts.visibility for
  // run-scoped private files whose projection_file_id points at the shadow row.
  await accept(
    app(owner)(artifactSharesContract).update({
      headers,
      body: {
        target: { kind: "file", id: prepared.body.id },
        audience: "public",
      },
    }),
    [200],
  );
  const updatedCatalog = await accept(
    app(owner)(artifactCatalogContract).list({ headers, query: {} }),
    [200],
  );
  const updatedItem = updatedCatalog.body.artifacts.find((item) => {
    return item.id === artifactId;
  });
  expect(updatedItem?.visibility).toBe("public");
});
