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
import { artifactAccessContract } from "@okouai/api-contracts/contracts/artifact-access";
import { artifactCatalogContract } from "@okouai/api-contracts/contracts/artifact-catalog";
import { artifactSharesContract } from "@okouai/api-contracts/contracts/artifact-shares";
import { artifactSharingContract } from "@okouai/api-contracts/contracts/artifact-sharing";
import { uploadsContract } from "@okouai/api-contracts/contracts/uploads";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupAppWithRoutes } from "../../../__tests__/test-app";
import { now } from "../../../lib/time";
import { artifactAccessRoutes } from "../artifact-access";
import { artifactCatalogRoutes } from "../artifact-catalog";
import { artifactShareRoutes } from "../artifact-shares";
import { artifactSharingRoutes } from "../artifact-sharing";
import { uploadsCompleteRoutes } from "../uploads-complete";
import { uploadsPrepareRoutes } from "../uploads-prepare";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
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
      ...uploadsPrepareRoutes,
      ...uploadsCompleteRoutes,
    ],
  });
}

function profile(user: ApiTestUser) {
  return {
    id: user.userId,
    firstName: "Taylor",
    lastName: "Owner",
    imageUrl: null,
    banned: false,
    emailAddresses: [
      {
        id: `em_${user.userId}`,
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

async function createFileArtifact(
  owner: ApiTestUser,
  filename: string,
  contentType: string,
) {
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
  return { fileId: prepared.body.id, artifactId: entry.id };
}

test("unified artifact visibility bidirectionally syncs file artifacts with legacy share status", async () => {
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

test("unified artifact shares bidirectionally sync with legacy file shares", async () => {
  const owner = createBddApi(context).user();
  const colleague = { ...createBddApi(context).user(), orgId: owner.orgId };
  if (!owner.orgId) {
    throw new Error("Fixture requires orgId");
  }
  await updateFeatureSwitchesForUser(
    context,
    { ...owner, orgId: owner.orgId },
    { [FeatureSwitchKey.HostedSiteEmailSharing]: true },
  );
  directory([profile(owner), profile(colleague)], [owner, colleague]);

  const { fileId, artifactId } = await createFileArtifact(
    owner,
    "deck.pdf",
    "application/pdf",
  );

  // Add via unified POST /api/artifacts/:artifactId/shares
  const addRes = await accept(
    app(owner)(artifactAccessContract).addShare({
      headers,
      params: { artifactId },
      body: { email: colleague.email },
    }),
    [200],
  );
  expect(addRes.body.share.email).toBe(colleague.email);
  expect(addRes.body.share.userId).toBe(colleague.userId);

  // Legacy GET /api/artifact-sharing/file/:fileId/shares observes the share
  const legacyList = await accept(
    app(owner)(artifactSharingContract).list({
      headers,
      params: { kind: "file", id: fileId },
    }),
    [200],
  );
  expect(
    legacyList.body.shares.map((s) => {
      return s.email;
    }),
  ).toStrictEqual([colleague.email]);

  // Remove via unified DELETE /api/artifacts/:artifactId/shares/:shareId
  await accept(
    app(owner)(artifactAccessContract).removeShare({
      headers,
      params: { artifactId, shareId: addRes.body.share.id },
    }),
    [200],
  );

  const afterRemoveUnified = await accept(
    app(owner)(artifactAccessContract).listShares({
      headers,
      params: { artifactId },
    }),
    [200],
  );
  expect(afterRemoveUnified.body.shares).toHaveLength(0);
});
