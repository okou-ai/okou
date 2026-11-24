import { createRunsApi } from "./helpers/api-bdd-runs";
import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { array, object, string } from "zod";
import { beforeEach, expect, test } from "vitest";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { artifactSharingContract } from "@okouai/api-contracts/contracts/artifact-sharing";
import { artifactReferencesContract } from "@okouai/api-contracts/contracts/artifact-references";
import { artifactDownloadsContract } from "@okouai/api-contracts/contracts/artifact-downloads";
import { uploadsContract } from "@okouai/api-contracts/contracts/uploads";
import { hostContract } from "@okouai/api-contracts/contracts/host";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupAppWithRoutes } from "../../../__tests__/test-app";
import { now } from "../../../lib/time";
import { artifactSharingRoutes } from "../artifact-sharing";
import { artifactReferenceRoutes } from "../artifact-references";
import { artifactDownloadRoutes } from "../artifact-downloads";
import { artifactShareRoutes } from "../artifact-shares";
import { uploadsPrepareRoutes } from "../uploads-prepare";
import { uploadsCompleteRoutes } from "../uploads-complete";
import { hostRoutes } from "../host";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createHostBddApi } from "./helpers/api-bdd-host";
import { hostedTextFile } from "./helpers/api-bdd-host-files";
import { createRouteMocks } from "./helpers/route-test";
import { mockClerkUsers } from "./helpers/clerk-users";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { flushWaitUntilForTest } from "../../context/wait-until";

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
      ...artifactSharingRoutes,
      ...artifactReferenceRoutes,
      ...artifactDownloadRoutes,
      ...artifactShareRoutes,
      ...uploadsPrepareRoutes,
      ...uploadsCompleteRoutes,
      ...hostRoutes,
    ],
  });
}

function profile(user: ApiTestUser, verified = true) {
  return {
    id: user.userId,
    firstName: "Taylor",
    lastName: "Viewer",
    username: `nickname_${user.userId}`,
    banned: false,
    primaryEmailAddressId: `email_${user.userId}`,
    emailAddresses: [
      {
        id: `email_${user.userId}`,
        emailAddress: user.email,
        verification: { status: verified ? "verified" : "unverified" },
      },
    ],
  };
}

function directory(
  profiles: readonly ReturnType<typeof profile>[],
  members: readonly ApiTestUser[],
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
        query: string().optional(),
      }).parse(input);
      return Promise.resolve({
        data: members
          .filter((member) => {
            const user = profiles.find((entry) => {
              return entry.id === member.userId;
            });
            return (
              member.orgId === params.organizationId &&
              (!params.userId || params.userId.includes(member.userId)) &&
              (!params.emailAddress ||
                params.emailAddress.includes(member.email)) &&
              (!params.query ||
                `${user?.firstName} ${user?.lastName} ${user?.username} ${member.email}`
                  .toLowerCase()
                  .includes(params.query.toLowerCase()))
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

async function file(
  owner: ApiTestUser,
  filename = "report.pdf",
  contentType = "application/pdf",
) {
  const objects = new Map<string, Buffer>();
  context.mocks.s3.getSignedUrl.mockResolvedValue(
    "https://private-r2.example/report?signature=temporary",
  );
  context.mocks.s3.send.mockImplementation((operation) => {
    if (operation instanceof HeadObjectCommand) {
      return Promise.resolve({
        ContentLength: 13,
        ContentType: contentType,
        Metadata: { "artifact-id": operation.input.Key?.split("/")[1] },
      });
    }
    if (operation instanceof ListObjectsV2Command) {
      return Promise.resolve({ Contents: [] });
    }
    if (operation instanceof PutObjectCommand) {
      const body = operation.input.Body;
      if (typeof body !== "string" && !(body instanceof Uint8Array)) {
        throw new Error("Expected storage bytes");
      }
      objects.set(operation.input.Key!, Buffer.from(body));
      return Promise.resolve({ ETag: '"stored"' });
    }
    if (operation instanceof GetObjectCommand) {
      const body = objects.get(operation.input.Key!);
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
  const completed = await accept(
    app(owner)(uploadsContract).complete({
      headers,
      body: { id: prepared.body.id },
    }),
    [200],
  );
  return {
    params: { kind: "file" as const, id: prepared.body.id },
    reference: new URL(completed.body.url).pathname.slice("/artifacts/".length),
  };
}

async function enabled(owner: ApiTestUser, value = true) {
  if (!owner.orgId) {
    throw new Error("Sharing fixture requires a workspace");
  }
  await updateFeatureSwitchesForUser(
    context,
    { ...owner, orgId: owner.orgId },
    {
      [FeatureSwitchKey.HostedSiteEmailSharing]: value,
    },
  );
}

test.each([
  ["report.pdf", "application/pdf"],
  ["recording.mp4", "video/mp4"],
])(
  "named viewers can open and download %s from another active workspace",
  async (filename, contentType) => {
    const owner = createBddApi(context).user();
    const viewer = { ...createBddApi(context).user(), orgId: owner.orgId };
    await enabled(owner);
    const resource = await file(owner, filename, contentType);
    directory([profile(owner), profile(viewer)], [owner, viewer]);
    const grant = await accept(
      app(owner)(artifactSharingContract).share({
        headers,
        params: resource.params,
        body: { email: viewer.email },
      }),
      [200],
    );
    expect(grant.body).toStrictEqual({
      share: { id: expect.any(String), email: viewer.email },
    });
    const outside = { ...viewer, orgId: `other_${randomUUID()}` };
    await createRunsApi(context).grantProEntitlement(outside);
    const preview = await accept(
      app(outside)(artifactReferencesContract).resolve({
        headers,
        params: { reference: resource.reference },
      }),
      [200],
    );
    expect(preview.body).toMatchObject({
      filename,
      contentType,
      target: { kind: "file", id: resource.params.id },
    });
    const download = await accept(
      app(outside)(artifactDownloadsContract).download({
        headers,
        params: { reference: resource.reference },
      }),
      [200],
    );
    expect(download.body).toMatchObject({
      kind: "file",
      filename,
      contentType,
    });
    await accept(
      app(outside)(artifactSharingContract).share({
        headers,
        params: resource.params,
        body: { email: "other@example.com" },
      }),
      [404],
    );
    await accept(
      app(owner)(artifactSharingContract).remove({
        headers,
        params: { ...resource.params, shareId: grant.body.share.id },
      }),
      [200],
    );
    await accept(
      app(outside)(artifactReferencesContract).resolve({
        headers,
        params: { reference: resource.reference },
      }),
      [404],
    );
    await accept(
      app(outside)(artifactDownloadsContract).download({
        headers,
        params: { reference: resource.reference },
      }),
      [404],
    );
    expect(context.mocks.resend.send).not.toHaveBeenCalled();
  },
);

test("external invitations use the Resend file template, deduplicate and require a verified email to claim", async () => {
  const owner = createBddApi(context).user();
  const viewer = createBddApi(context).user();
  await enabled(owner);
  const resource = await file(owner);
  directory([profile(owner)], [owner]);
  const invite = () => {
    return app(owner)(artifactSharingContract).share({
      headers,
      params: resource.params,
      body: { email: viewer.email },
    });
  };
  const first = await accept(invite(), [200]);
  await flushWaitUntilForTest();
  const repeated = await accept(invite(), [200]);
  await flushWaitUntilForTest();
  expect(repeated.body).toStrictEqual(first.body);
  expect(context.mocks.resend.send).toHaveBeenCalledTimes(1);
  expect(context.mocks.resend.send.mock.calls[0]?.[0]).toMatchObject({
    to: viewer.email,
    template: {
      id: "okou-artifact-invitation-v1",
      variables: {
        RECIPIENT_EMAIL: viewer.email,
        ARTIFACT_URL: expect.stringContaining("/artifacts/"),
      },
    },
  });
  directory([profile(owner), profile(viewer, false)], [owner]);
  await accept(
    app(viewer)(artifactReferencesContract).resolve({
      headers,
      params: { reference: resource.reference },
    }),
    [404],
  );
  directory([profile(owner), profile(viewer)], [owner]);
  await accept(
    app(viewer)(artifactReferencesContract).resolve({
      headers,
      params: { reference: resource.reference },
    }),
    [200],
  );
  await accept(
    app(owner)(artifactSharingContract).remove({
      headers,
      params: { ...resource.params, shareId: first.body.share.id },
    }),
    [200],
  );
  await accept(
    app(viewer)(artifactReferencesContract).resolve({
      headers,
      params: { reference: resource.reference },
    }),
    [404],
  );
});

test("nickname search stays in the owner's workspace and an unrelated account cannot claim an invitation", async () => {
  const owner = createBddApi(context).user();
  const local = { ...createBddApi(context).user(), orgId: owner.orgId };
  const external = createBddApi(context).user();
  const stranger = createBddApi(context).user();
  await enabled(owner);
  const resource = await file(owner);
  directory(
    [profile(owner), profile(local), profile(external), profile(stranger)],
    [owner, local],
  );
  const found = await accept(
    app(owner)(artifactSharingContract).search({
      headers,
      params: resource.params,
      query: { query: `nickname_${local.userId}` },
    }),
    [200],
  );
  expect(found.body.accounts).toStrictEqual([
    { userId: local.userId, name: "Taylor Viewer", email: local.email },
  ]);
  const hidden = await accept(
    app(owner)(artifactSharingContract).search({
      headers,
      params: resource.params,
      query: { query: external.email },
    }),
    [200],
  );
  expect(hidden.body.accounts).toStrictEqual([]);
  await accept(
    app(owner)(artifactSharingContract).share({
      headers,
      params: resource.params,
      body: { email: external.email },
    }),
    [200],
  );
  await accept(
    app(stranger)(artifactReferencesContract).resolve({
      headers,
      params: { reference: resource.reference },
    }),
    [404],
  );
  await accept(
    app(stranger)(artifactSharingContract).search({
      headers,
      params: resource.params,
      query: { query: "Taylor" },
    }),
    [404],
  );
});

test("file sharing honors the server switch and recipient quotas", async () => {
  const owner = createBddApi(context).user();
  const resource = await file(owner);
  await enabled(owner, false);
  directory([profile(owner)], [owner]);
  await accept(
    app(owner)(artifactSharingContract).share({
      headers,
      params: resource.params,
      body: { email: "viewer@example.com" },
    }),
    [404],
  );
  await enabled(owner);
  for (let i = 0; i < 3; i++) {
    await accept(
      app(owner)(artifactSharingContract).share({
        headers,
        params: resource.params,
        body: { email: "viewer@example.com" },
      }),
      [200],
    );
  }
  const limited = await accept(
    app(owner)(artifactSharingContract).share({
      headers,
      params: resource.params,
      body: { email: "viewer@example.com" },
    }),
    [429],
  );
  expect(limited.body.error.code).toBe("RATE_LIMITED");
  const otherOrg = { ...owner, orgId: `other_${randomUUID()}` };
  await enabled(otherOrg);
  await accept(
    app(otherOrg)(artifactSharingContract).list({
      headers,
      params: resource.params,
    }),
    [404],
  );
});

test("the common sharing API preserves existing website grants", async () => {
  const owner = createBddApi(context).user();
  const viewer = { ...createBddApi(context).user(), orgId: owner.orgId };
  await enabled(owner);
  const host = createHostBddApi(context);
  host.captureHostedSitesS3();
  const site = await host.prepareHostedSite(owner, {
    site: `sharing-${randomUUID().slice(0, 8)}`,
    title: "Shared site",
    artifactKind: "hosted-site",
    spaFallback: false,
    files: [hostedTextFile("/index.html", "<p>Private site</p>")],
    visibility: "private",
  });
  await host.completeHostedSite(owner, site.deploymentId);
  directory([profile(owner), profile(viewer)], [owner, viewer]);
  const params = { kind: "site" as const, id: site.siteId };
  const grant = await accept(
    app(owner)(artifactSharingContract).share({
      headers,
      params,
      body: { email: viewer.email },
    }),
    [200],
  );
  const listed = await accept(
    app(owner)(artifactSharingContract).list({ headers, params }),
    [200],
  );
  expect(listed.body.shares).toStrictEqual([grant.body.share]);
  const check = () => {
    return app(viewer)(hostContract).sitePreview({
      headers,
      params: { publicSlug: site.publicSlug },
      query: { hostname: `${site.publicSlug}.okou.app` },
    });
  };
  await accept(check(), [200]);
  await accept(
    app(owner)(artifactSharingContract).remove({
      headers,
      params: { ...params, shareId: grant.body.share.id },
    }),
    [200],
  );
  await accept(check(), [404]);
});
