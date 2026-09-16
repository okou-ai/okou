import { mockNow, now } from "../../../lib/time";
import { artifactDeliveryKey } from "@okouai/api-contracts/contracts/artifact-delivery";
import {
  artifactReferencePath,
  artifactReferencesContract,
} from "@okouai/api-contracts/contracts/artifact-references";
import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import {
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  CopyObjectCommand,
} from "@aws-sdk/client-s3";
import { z } from "zod";
import { describe, expect, it, test } from "vitest";
import {
  artifactSharePolicySchema,
  artifactSharesContract,
} from "@okouai/api-contracts/contracts/artifact-shares";
import { uploadsContract } from "@okouai/api-contracts/contracts/uploads";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { webFilesContract } from "@okouai/api-contracts/contracts/web-files";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { testContext, accept } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { artifactReferenceRoutes } from "../artifact-references";
import { artifactShareRoutes } from "../artifact-shares";
import { featureSwitchesRoutes } from "../feature-switches";
import { uploadsPrepareRoutes } from "../uploads-prepare";
import { uploadsCompleteRoutes } from "../uploads-complete";
import { webFileUrlRoutes } from "../web-file-url";
import { createRouteMocks } from "./helpers/route-test";
import { createBddApi } from "./helpers/api-bdd";
import { createHostMapsBddApi } from "./helpers/api-bdd-host-maps";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { hostedTextFile } from "./helpers/api-bdd-host-files";

const context = testContext();
const mocks = createRouteMocks(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });

class ClerkApiResponseTestError extends Error {
  static readonly kind = "ClerkAPIResponseError";

  constructor(readonly status: number) {
    super(`Clerk Backend API request failed with status ${status}`);
  }
}

const api = () => {
  return setupApp({
    context,
    routes: [
      ...artifactShareRoutes,
      ...artifactReferenceRoutes,
      ...featureSwitchesRoutes,
      ...uploadsPrepareRoutes,
      ...uploadsCompleteRoutes,
      ...webFileUrlRoutes,
    ],
  });
};
async function flag(enabled: boolean) {
  await accept(
    api()(featureSwitchesContract).update({
      headers,
      body: { switches: { [FeatureSwitchKey.PrivateArtifacts]: enabled } },
    }),
    [200],
  );
}
async function file() {
  const prepared = await accept(
    api()(uploadsContract).prepare({
      headers,
      body: {
        filename: "report.pdf",
        contentType: "application/pdf",
        size: 13,
        purpose: "artifact",
      },
    }),
    [200],
  );
  await accept(
    api()(uploadsContract).complete({
      headers,
      body: { id: prepared.body.id },
    }),
    [200],
  );
  return { kind: "file" as const, id: prepared.body.id };
}

async function fixture() {
  const owner = `user_${randomUUID()}`;
  const org = `org_${randomUUID()}`;
  const organization = { id: org, name: "Original organization" };
  const members = new Set([owner]);
  const objects = new Map<string, string>();
  const etag = (body: string) => {
    return `"${createHash("md5").update(body).digest("hex")}"`;
  };
  mockEnv("OKOU_API_BACKEND_URL", "https://api.okou.ai");
  mockEnv("APP_URL", "https://app.okou.ai");
  mockEnv("OKOU_PUBLIC_HOST_DOMAIN", "okou.app");
  mockEnv("OKOU_HOST_SCHEME", "https");
  context.mocks.clerk.organizations.getOrganization.mockResolvedValue(
    organization,
  );
  context.mocks.clerk.organizations.getOrganizationMembershipList.mockImplementation(
    (input) => {
      const params = z
        .object({
          organizationId: z.string(),
          userId: z.array(z.string()),
          limit: z.literal(1),
        })
        .parse(input);
      expect(params.organizationId).toBe(org);
      return Promise.resolve({
        data: params.userId
          .filter((id: string) => {
            return members.has(id);
          })
          .map((id: string) => {
            return {
              publicUserData: { userId: id },
              role: "org:member",
              organization: { ...organization },
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
          ? [
              {
                organization: { id: org },
                publicUserData: { userId },
                role: "org:member",
              },
            ]
          : [],
      });
    },
  );
  context.mocks.s3.getSignedUrl.mockResolvedValue(
    "https://private-r2.example/report.pdf?signature=temporary",
  );
  context.mocks.s3.send.mockImplementation((cmd) => {
    if (cmd instanceof ListObjectsV2Command) {
      return Promise.resolve({ Contents: [] });
    }
    if (cmd instanceof HeadObjectCommand) {
      return Promise.resolve({
        ContentLength: 13,
        ContentType: "application/pdf",
        Metadata: { "artifact-id": cmd.input.Key?.split("/")[1] },
      });
    }
    if (cmd instanceof CopyObjectCommand) {
      return Promise.resolve({});
    }
    if (cmd instanceof PutObjectCommand) {
      const previous = objects.get(cmd.input.Key!);
      if (
        (cmd.input.IfNoneMatch === "*" && previous !== undefined) ||
        (cmd.input.IfMatch &&
          (previous === undefined || cmd.input.IfMatch !== etag(previous)))
      ) {
        return Promise.reject(
          Object.assign(new Error("Stale policy write"), {
            name: "PreconditionFailed",
          }),
        );
      }
      objects.set(cmd.input.Key!, String(cmd.input.Body));
      return Promise.resolve({});
    }
    if (cmd instanceof GetObjectCommand) {
      const body = objects.get(cmd.input.Key!);
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
  function session(userId = owner, orgId: string | null = org) {
    mocks.clerk.session(userId, orgId);
  }
  session();
  await flag(true);
  return { owner, org, organization, members, objects, session };
}

async function hostedFixture() {
  const sharing = await fixture();
  const organizationMemberships =
    context.mocks.clerk.organizations.getOrganizationMembershipList.getMockImplementation()!;
  const actor = createBddApi(context).user({
    userId: sharing.owner,
    orgId: sharing.org,
  });
  await createRunsApi(context).grantProEntitlement(actor);
  // Entitlement setup installs its own Clerk fixture. Restore the sharing
  // directory before any share request needs organization names or members.
  context.mocks.clerk.organizations.getOrganizationMembershipList.mockImplementation(
    organizationMemberships,
  );
  return { ...sharing, actor };
}

test.each(["private", "organization", "public"] as const)(
  "%s share status reuses the fresh membership name and observes renames",
  async (audience) => {
    const { org, organization } = await fixture();
    const target = await file();
    context.mocks.clerk.organizations.getOrganization.mockClear();
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockClear();

    const updated = await accept(
      api()(artifactSharesContract).update({
        headers,
        body: { target, audience },
      }),
      [200],
    );
    expect(updated.body).toMatchObject({
      audience,
      organization: { id: org, name: "Original organization" },
    });

    for (let read = 0; read < 2; read++) {
      const status = await accept(
        api()(artifactSharesContract).status({ headers, body: target }),
        [200],
      );
      expect(status.body).toStrictEqual(updated.body);
      expect(status.headers.get("cache-control")).toBe("private, no-store");
    }

    organization.name = "Renamed organization";
    const renamed = await accept(
      api()(artifactSharesContract).status({ headers, body: target }),
      [200],
    );
    expect(renamed.body).toStrictEqual({
      ...updated.body,
      organization: { id: org, name: "Renamed organization" },
    });
    expect(
      context.mocks.clerk.organizations.getOrganization,
    ).not.toHaveBeenCalled();
    expect(
      context.mocks.clerk.organizations.getOrganizationMembershipList,
    ).toHaveBeenCalledTimes(4);
  },
);

test("removing the owner denies status and updates after successful name reads", async () => {
  const { owner, members } = await fixture();
  const target = await file();
  await accept(
    api()(artifactSharesContract).update({
      headers,
      body: { target, audience: "public" },
    }),
    [200],
  );
  await accept(
    api()(artifactSharesContract).status({ headers, body: target }),
    [200],
  );

  members.delete(owner);
  const unavailable = await accept(
    api()(artifactSharesContract).status({ headers, body: target }),
    [404],
  );
  expect(unavailable.body).toStrictEqual({
    error: { code: "NOT_FOUND", message: "Artifact not found" },
  });
  await accept(
    api()(artifactSharesContract).update({
      headers,
      body: { target, audience: "organization" },
    }),
    [404],
  );
});

test("viewing and copying stable references grant nothing; only the owner can manage sharing", async () => {
  const { objects, members, session } = await fixture();
  const target = await file();
  const initial = await accept(
    api()(artifactSharesContract).status({ headers, body: target }),
    [200],
  );
  expect(initial.body).toMatchObject({
    audience: "private",
    shareId: null,
    url: null,
  });
  expect(
    [...objects.keys()].filter((key) => {
      return key.startsWith("artifact-shares/");
    }),
  ).toHaveLength(0);
  const peer = `user_${randomUUID()}`;
  members.add(peer);
  session(peer);
  await flag(true);
  await accept(
    api()(artifactSharesContract).status({ headers, body: target }),
    [404],
  );
  await accept(
    api()(artifactSharesContract).update({
      headers,
      body: { target, audience: "public" },
    }),
    [404],
  );
  await accept(
    api()(webFilesContract).fileUrl({ headers, query: { file_id: target.id } }),
    [404],
  );
  session();
  await flag(false);
  await accept(
    api()(artifactSharesContract).update({
      headers,
      body: { target, audience: "public" },
    }),
    [403],
  );
  expect(
    [...objects.keys()].filter((key) => {
      return key.startsWith("artifact-shares/");
    }),
  ).toHaveLength(0);
});

test("hostless owner references authorize before signing and ignore extension hints", async () => {
  const { members, session, objects } = await fixture();
  const target = await file();
  const reference = artifactReferencePath(target.id, "renamed.html")
    .split("/")
    .at(-1)!;
  const resolved = await accept(
    api()(artifactReferencesContract).resolve({
      headers,
      params: { reference },
    }),
    [200],
  );
  expect(resolved.body).toMatchObject({
    filename: "report.pdf",
    contentType: "application/pdf",
    target,
  });
  expect(resolved.body.url).toContain("signature=temporary");
  expect(resolved.headers.get("cache-control")).toBe("private, no-store");
  expect(
    [...objects.keys()].filter((key) => {
      return key.startsWith("artifact-shares/");
    }),
  ).toHaveLength(0);
  await flag(false);
  await accept(
    api()(artifactReferencesContract).resolve({
      headers,
      params: { reference },
    }),
    [200],
  );
  const peer = `user_${randomUUID()}`;
  members.add(peer);
  session(peer);
  const signatures = context.mocks.s3.getSignedUrl.mock.calls.length;
  await accept(
    api()(artifactReferencesContract).resolve({
      headers,
      params: { reference },
    }),
    [404],
  );
  expect(context.mocks.s3.getSignedUrl.mock.calls).toHaveLength(signatures);
  context.mocks.clerk.authenticateRequest.mockResolvedValue({
    isAuthenticated: false,
  });
  const anonymous = await accept(
    api()(artifactReferencesContract).resolve({
      headers: {},
      params: { reference },
    }),
    [401],
  );
  expect(anonymous.headers.get("cache-control")).toBe("private, no-store");
});

test("a private file keeps the same short reference through organization sharing and revocation", async () => {
  const { members, session } = await fixture();
  const prepared = await accept(
    api()(uploadsContract).prepare({
      headers,
      body: {
        filename: "report.pdf",
        contentType: "application/pdf",
        size: 13,
        purpose: "artifact",
      },
    }),
    [200],
  );
  await accept(
    api()(uploadsContract).complete({
      headers,
      body: { id: prepared.body.id },
    }),
    [200],
  );
  const target = { kind: "file" as const, id: prepared.body.id };
  const url = prepared.body.url;
  expect(url).toMatch(/^\/artifacts\/[a-z0-9]{10}\.pdf$/u);
  const reference = url.slice("/artifacts/".length);
  const recipient = `user_${randomUUID()}`;
  members.add(recipient);
  session(recipient);
  await accept(
    api()(artifactReferencesContract).resolve({
      headers,
      params: { reference },
    }),
    [404],
  );
  session();
  const shared = await accept(
    api()(artifactSharesContract).update({
      headers,
      body: { target, audience: "organization" },
    }),
    [200],
  );
  expect(shared.body.shortUrl).toBe(`https://app.okou.ai${url}`);
  expect(shared.body.url).toBe(shared.body.shortUrl);
  session(recipient);
  const resolved = await accept(
    api()(artifactReferencesContract).resolve({
      headers,
      params: { reference },
    }),
    [200],
  );
  expect(resolved.body.target).toStrictEqual(target);
  session();
  await accept(
    api()(artifactSharesContract).update({
      headers,
      body: { target, audience: "private" },
    }),
    [200],
  );
  await accept(
    api()(artifactReferencesContract).resolve({
      headers,
      params: { reference },
    }),
    [200],
  );
  session(recipient);
  await accept(
    api()(artifactReferencesContract).resolve({
      headers,
      params: { reference },
    }),
    [404],
  );
});

test("agent reference resolution enforces resource capability, type and ownership", async () => {
  const { owner, org, members } = await fixture();
  const prepared = await accept(
    api()(uploadsContract).prepare({
      headers,
      body: {
        filename: "report.pdf",
        contentType: "application/pdf",
        size: 13,
      },
    }),
    [200],
  );
  await accept(
    api()(uploadsContract).complete({
      headers,
      body: { id: prepared.body.id },
    }),
    [200],
  );
  await accept(
    api()(artifactSharesContract).update({
      headers,
      body: {
        target: { kind: "file", id: prepared.body.id },
        audience: "organization",
      },
    }),
    [200],
  );
  const reference = prepared.body.url.slice("/artifacts/".length);
  const recipient = `user_${randomUUID()}`;
  members.add(recipient);
  const seconds = Math.floor(now() / 1000);
  for (const [userId, capability, kind, status] of [
    [owner, "file:read", "file", 200],
    [owner, "host:read", "file", 403],
    [owner, "host:read", "html", 404],
    [recipient, "file:read", "file", 404],
  ] as const) {
    const token = signSandboxJwtForTests({
      scope: "okou",
      userId,
      orgId: org,
      runId: randomUUID(),
      capabilities: [capability],
      iat: seconds,
      exp: seconds + 3600,
    });
    const resolved = await accept(
      api()(artifactReferencesContract).resolve({
        headers: { authorization: `Bearer ${token}` },
        params: { reference },
        query: { kind },
      }),
      [status],
    );
    if (status === 200) {
      expect(resolved.body).toMatchObject({
        target: { kind: "file", id: prepared.body.id },
      });
    }
  }
});

test.each(["short", "legacy", "legacy-short"] as const)(
  "%s organization references use current membership and revoke without a rollout dependency",
  async (format) => {
    const { members, session, objects } = await fixture();
    const target = await file();
    const shared = await accept(
      api()(artifactSharesContract).update({
        headers,
        body: { target, audience: "organization" },
      }),
      [200],
    );
    expect(shared.body.shortUrl).toMatch(
      /^https:\/\/app\.okou\.ai\/artifacts\/[a-z0-9]{10}\.pdf$/u,
    );
    const legacyReference = randomUUID().replaceAll("-", "").slice(0, 10);
    if (format === "legacy-short") {
      objects.set(
        `artifact-references/${legacyReference}.json`,
        JSON.stringify({ version: 1, shareId: shared.body.shareId }),
      );
    }
    const reference = new URL(
      format === "legacy-short"
        ? `https://app.okou.ai/artifacts/${legacyReference}.pdf`
        : format === "short"
          ? shared.body.shortUrl!
          : `https://app.okou.ai${artifactReferencePath(shared.body.shareId!, "report.pdf")}`,
    ).pathname
      .split("/")
      .at(-1)!;
    const recipient = `user_${randomUUID()}`;
    members.add(recipient);
    session(recipient, `org_${randomUUID()}`);
    const allowed = await accept(
      api()(artifactReferencesContract).resolve({
        headers,
        params: { reference },
      }),
      [200],
    );
    expect(allowed.body.target).toStrictEqual(target);
    members.delete(recipient);
    await accept(
      api()(artifactReferencesContract).resolve({
        headers,
        params: { reference },
      }),
      [404],
    );
    members.add(recipient);
    session();
    await flag(false);
    await accept(
      api()(artifactSharesContract).update({
        headers,
        body: { target, audience: "private" },
      }),
      [200],
    );
    session(recipient, `org_${randomUUID()}`);
    await accept(
      api()(artifactReferencesContract).resolve({
        headers,
        params: { reference },
      }),
      [404],
    );
  },
);

test.each([false, true])(
  "older organization policies allocate a short link only on explicit sharing (index retained=%s)",
  async (retainIndex) => {
    const { objects } = await fixture();
    const target = await file();
    const shared = await accept(
      api()(artifactSharesContract).update({
        headers,
        body: { target, audience: "organization" },
      }),
      [200],
    );
    const key = `artifact-shares/okou/${shared.body.shareId}.json`;
    const historical = artifactSharePolicySchema.parse(
      JSON.parse(objects.get(key)!),
    );
    if (!retainIndex) {
      objects.delete(
        `artifact-references/${historical.organizationReference}.json`,
      );
    }
    delete historical.organizationReference;
    objects.set(key, JSON.stringify(historical));
    const before = new Map(objects);
    const status = await accept(
      api()(artifactSharesContract).status({ headers, body: target }),
      [200],
    );
    expect(status.body.shortUrl).toBeNull();
    expect(status.body.url).toBeNull();
    expect(objects).toStrictEqual(before);

    const updated = await accept(
      api()(artifactSharesContract).update({
        headers,
        body: { target, audience: "organization" },
      }),
      [200],
    );
    expect(updated.body.shortUrl).toBe(shared.body.shortUrl);
    expect(updated.body.url).toBe(shared.body.url);
  },
);

test("reading a pre-registry public grant preserves its working URL without publishing a new alias", async () => {
  const { objects } = await fixture();
  const target = await file();
  const published = await accept(
    api()(artifactSharesContract).update({
      headers,
      body: { target, audience: "public" },
    }),
    [200],
  );
  const key = `artifact-shares/okou/${published.body.shareId}.json`;
  const historical = artifactSharePolicySchema.parse(
    JSON.parse(objects.get(key)!),
  );
  historical.publicToken = "a".repeat(24);
  delete historical.delivery;
  objects.set(key, JSON.stringify(historical));
  for (const alias of objects.keys()) {
    if (alias.startsWith("artifact-delivery/")) {
      objects.delete(alias);
    }
  }
  const before = new Map(objects);
  const status = await accept(
    api()(artifactSharesContract).status({ headers, body: target }),
    [200],
  );
  expect(status.body.url).toBe(
    `https://sh-${historical.shareId.replaceAll("-", "")}-${historical.publicToken}.okou.app/`,
  );
  expect(objects).toStrictEqual(before);
});

test("public filename collisions retry without replacing a historical file", async () => {
  const { objects } = await fixture();
  const target = await file();
  const storage = context.mocks.s3.send.getMockImplementation()!;
  let collision: string | undefined;
  const existing = JSON.stringify({
    version: 1,
    kind: "legacy-file",
    publicBrand: "okou",
    audience: "public",
    key: "artifacts/0123456789.pdf",
    filename: "old.pdf",
    contentType: "application/pdf",
  });
  context.mocks.s3.send.mockImplementation((cmd) => {
    if (
      !collision &&
      cmd instanceof PutObjectCommand &&
      cmd.input.Key?.startsWith("artifact-delivery/files/")
    ) {
      collision = cmd.input.Key;
      objects.set(collision, existing);
    }
    return storage(cmd);
  });
  const published = await accept(
    api()(artifactSharesContract).update({
      headers,
      body: { target, audience: "public" },
    }),
    [200],
  );
  const alias = new URL(published.body.url!).pathname.slice(1);
  expect(alias).toMatch(/^[a-z0-9]{10}\.pdf$/u);
  expect(collision).not.toBe(`artifact-delivery/files/${alias}.json`);
  expect(objects.get(collision!)).toBe(existing);
  const repeated = await accept(
    api()(artifactSharesContract).update({
      headers,
      body: { target, audience: "public" },
    }),
    [200],
  );
  expect(repeated.body.url).toBe(published.body.url);
});

test("existing 24-character public file links survive updates and revoke normally", async () => {
  const { objects } = await fixture();
  const target = await file();
  const published = await accept(
    api()(artifactSharesContract).update({
      headers,
      body: { target, audience: "public" },
    }),
    [200],
  );
  const key = `artifact-shares/okou/${published.body.shareId}.json`;
  const historical = artifactSharePolicySchema.parse(
    JSON.parse(objects.get(key)!),
  );
  historical.publicToken = "a".repeat(24);
  objects.set(key, JSON.stringify(historical));
  const updated = await accept(
    api()(artifactSharesContract).update({
      headers,
      body: { target, audience: "public" },
    }),
    [200],
  );
  expect(updated.body.url).toBe(`https://a.okou.io/${"a".repeat(24)}.pdf`);
  await accept(
    api()(artifactSharesContract).update({
      headers,
      body: { target, audience: "private" },
    }),
    [200],
  );
  expect(JSON.parse(objects.get(key)!)).toMatchObject({
    status: "revoked",
    publicToken: null,
  });
});

test("exhausted public hash collisions preserve registrations and grant no publication", async () => {
  const { objects } = await fixture();
  const target = await file();
  const storage = context.mocks.s3.send.getMockImplementation()!;
  let conflictingKey: string | undefined;
  const existing = JSON.stringify({
    version: 1,
    kind: "legacy-file",
    publicBrand: "okou",
    audience: "public",
    key: "artifacts/0123456789.pdf",
    filename: "old.pdf",
    contentType: "application/pdf",
  });
  context.mocks.s3.send.mockImplementation((cmd) => {
    if (
      cmd instanceof PutObjectCommand &&
      cmd.input.Key?.startsWith("artifact-delivery/")
    ) {
      conflictingKey = cmd.input.Key;
      objects.set(conflictingKey, existing);
    }
    return storage(cmd);
  });
  await accept(
    api()(artifactSharesContract).update({
      headers,
      body: { target, audience: "public" },
    }),
    [500],
  );
  expect(conflictingKey).toBeDefined();
  expect(objects.get(conflictingKey!)).toBe(existing);
  const status = await accept(
    api()(artifactSharesContract).status({ headers, body: target }),
    [200],
  );
  expect(status.body).toMatchObject({ audience: "private", url: null });
});

test("organization resolution checks current original-org membership and never grants reshare rights", async () => {
  const { members, session } = await fixture();
  const target = await file();
  const shared = await accept(
    api()(artifactSharesContract).update({
      headers,
      body: { target, audience: "organization" },
    }),
    [200],
  );
  const id = shared.body.shareId!;
  expect(shared.body.url).toBe(shared.body.shortUrl);
  expect(shared.headers.get("cache-control")).toBe("private, no-store");
  const recipient = `user_${randomUUID()}`;
  session(recipient, `org_${randomUUID()}`);
  await accept(
    api()(artifactSharesContract).resolve({ headers, params: { id } }),
    [404],
  );
  members.add(recipient);
  mockNow(new Date("2026-09-09T12:00:00.123Z"));
  const allowed = await accept(
    api()(artifactSharesContract).resolve({ headers, params: { id } }),
    [200],
  );
  expect(allowed.body.url).toContain("signature=temporary");
  expect(allowed.body.expiresAt).toBe("2026-09-11T12:00:00.000Z");
  expect(allowed.headers.get("cache-control")).toBe("private, no-store");
  expect(context.mocks.s3.getSignedUrl.mock.calls.at(-1)).toMatchObject({
    1: {
      input: {
        ResponseCacheControl: "private, max-age=31536000, must-revalidate",
      },
    },
    2: {
      expiresIn: 172_800,
      signingDate: new Date("2026-09-09T12:00:00.000Z"),
    },
  });
  await accept(
    api()(artifactSharesContract).status({ headers, body: target }),
    [404],
  );
  members.delete(recipient);
  await accept(
    api()(artifactSharesContract).resolve({ headers, params: { id } }),
    [404],
  );
  context.mocks.clerk.authenticateRequest.mockResolvedValue({
    isAuthenticated: false,
  });
  const anonymous = await accept(
    api()(artifactSharesContract).resolve({ headers: {}, params: { id } }),
    [401],
  );
  expect(anonymous.headers.get("cache-control")).toBe("private, no-store");
});

test("a deleted original organization makes an existing share unavailable", async () => {
  const { session } = await fixture();
  const target = await file();
  const shared = await accept(
    api()(artifactSharesContract).update({
      headers,
      body: { target, audience: "organization" },
    }),
    [200],
  );
  context.mocks.clerk.organizations.getOrganizationMembershipList.mockRejectedValue(
    new ClerkApiResponseTestError(404),
  );
  session(`user_${randomUUID()}`, `org_${randomUUID()}`);
  const response = await accept(
    api()(artifactSharesContract).resolve({
      headers,
      params: { id: shared.body.shareId! },
    }),
    [404],
  );
  expect(response.body).toStrictEqual({
    error: { code: "NOT_FOUND", message: "Artifact unavailable" },
  });
  expect(response.headers.get("cache-control")).toBe("private, no-store");

  session();
  await accept(
    api()(artifactSharesContract).status({ headers, body: target }),
    [404],
  );
  await accept(
    api()(artifactSharesContract).update({
      headers,
      body: { target, audience: "public" },
    }),
    [404],
  );
});

describe.each([
  ["provider outage", new ClerkApiResponseTestError(503)],
  ["rate limit", new ClerkApiResponseTestError(429)],
  [
    "unclassified failure",
    Object.assign(new Error("Failure"), { status: 404 }),
  ],
])(
  "a membership %s remains an error rather than a missing organization",
  (_name, error) => {
    async function unavailableMembershipFixture() {
      await fixture();
      const target = await file();
      const shared = await accept(
        api()(artifactSharesContract).update({
          headers,
          body: { target, audience: "organization" },
        }),
        [200],
      );
      context.mocks.clerk.organizations.getOrganizationMembershipList.mockRejectedValue(
        error,
      );
      return { target, shareId: shared.body.shareId! };
    }

    it("resolve returns an error without a delivery URL", async () => {
      const { shareId } = await unavailableMembershipFixture();
      const response = await accept(
        api()(artifactSharesContract).resolve({
          headers,
          params: { id: shareId },
        }),
        [500],
      );
      expect(response.body).not.toHaveProperty("url");
    });

    it("status returns an error without a delivery URL", async () => {
      const { target } = await unavailableMembershipFixture();
      const response = await accept(
        api()(artifactSharesContract).status({ headers, body: target }),
        [500],
      );
      expect(response.body).not.toHaveProperty("url");
    });

    it("update returns an error without a delivery URL", async () => {
      const { target } = await unavailableMembershipFixture();
      const response = await accept(
        api()(artifactSharesContract).update({
          headers,
          body: { target, audience: "public" },
        }),
        [500],
      );
      expect(response.body).not.toHaveProperty("url");
    });
  },
);

test("audience changes revoke old public tokens; rollback preserves grants and permits stopping", async () => {
  const { objects } = await fixture();
  const target = await file();
  const publicShare = await accept(
    api()(artifactSharesContract).update({
      headers,
      body: { target, audience: "public" },
    }),
    [200],
  );
  expect(publicShare.body.url).toMatch(
    /^https:\/\/a\.okou\.io\/[a-z0-9]{10}\.pdf$/u,
  );
  const first = publicShare.body;
  const organization = await accept(
    api()(artifactSharesContract).update({
      headers,
      body: { target, audience: "organization" },
    }),
    [200],
  );
  expect(organization.body.shareId).toBe(first.shareId);
  expect(
    JSON.parse(objects.get(`artifact-shares/okou/${first.shareId}.json`)!),
  ).toMatchObject({
    audience: "organization",
    publicToken: null,
  });
  const republished = await accept(
    api()(artifactSharesContract).update({
      headers,
      body: { target, audience: "public" },
    }),
    [200],
  );
  expect(republished.body.url).not.toBe(first.url);
  await flag(false);
  await accept(
    api()(artifactSharesContract).resolve({
      headers,
      params: { id: first.shareId! },
    }),
    [200],
  );
  await accept(
    api()(artifactSharesContract).update({
      headers,
      body: { target, audience: "private" },
    }),
    [200],
  );
  await accept(
    api()(artifactSharesContract).resolve({
      headers,
      params: { id: first.shareId! },
    }),
    [404],
  );
  expect(
    JSON.parse(objects.get(`artifact-shares/okou/${first.shareId}.json`)!),
  ).toMatchObject({
    status: "revoked",
    audience: "private",
    publicToken: null,
  });
});

test("html sharing pins the selected version until an explicit update and resolves to isolated content", async () => {
  const { actor, objects, members, session } = await hostedFixture();
  const host = createHostMapsBddApi(context);
  const body = {
    site: `sharing-${randomUUID().slice(0, 8)}`,
    artifactKind: "hosted-site" as const,
    spaFallback: false,
    files: [hostedTextFile("/index.html", "<h1>Version one</h1>")],
  };
  const first = await host.prepareHostedSite(actor, body);
  await host.completeHostedSite(actor, first.deploymentId);
  const target = { kind: "html" as const, id: first.deploymentId };
  const ownerReference = artifactReferencePath(first.deploymentId, "hint.pdf")
    .split("/")
    .at(-1)!;
  const preview = await accept(
    api()(artifactReferencesContract).resolve({
      headers,
      params: { reference: ownerReference },
    }),
    [200],
  );
  expect(preview.body).toMatchObject({
    target,
    filename: "index.html",
    contentType: "text/html",
  });
  expect(preview.body.url).toMatch(/^https:\/\/pv-[a-f0-9]{48}\.okou\.app\/$/u);
  session(`user_${randomUUID()}`);
  await accept(
    api()(artifactReferencesContract).resolve({
      headers,
      params: { reference: ownerReference },
    }),
    [404],
  );
  session();
  const share = await accept(
    api()(artifactSharesContract).update({
      headers,
      body: { target, audience: "organization" },
    }),
    [200],
  );
  const second = await host.prepareHostedSite(actor, {
    ...body,
    files: [hostedTextFile("/index.html", "<h1>Version two</h1>")],
  });
  await host.completeHostedSite(actor, second.deploymentId);
  const newer = { kind: "html" as const, id: second.deploymentId };
  const before = await accept(
    api()(artifactSharesContract).status({ headers, body: newer }),
    [200],
  );
  expect(before.body).toMatchObject({
    selectedTarget: target,
    selectedVersion: 1,
    candidateVersion: 2,
    url: share.body.url,
  });
  expect(share.body.shortUrl).toBe(`https://app.okou.ai${first.url}`);
  expect(share.body.url).toBe(share.body.shortUrl);
  const recipient = `user_${randomUUID()}`;
  members.add(recipient);
  session(recipient);
  await accept(
    api()(artifactReferencesContract).resolve({
      headers,
      params: { reference: second.url.slice("/artifacts/".length) },
    }),
    [404],
  );
  const resolve = await accept(
    api()(artifactReferencesContract).resolve({
      headers,
      params: {
        reference: new URL(share.body.shortUrl!).pathname.split("/").at(-1)!,
      },
    }),
    [200],
  );
  expect(resolve.body.url).toMatch(/^https:\/\/ps-[a-f0-9]{48}\.okou\.app\/$/u);
  const token = new URL(resolve.body.url).hostname.slice(3).split(".")[0];
  expect(objects.has(`shared-previews/okou/${token}.json`)).toBeTruthy();
  expect(objects.has(`private-previews/okou/${token}.json`)).toBeFalsy();
  expect(
    [...objects.values()].some((value) => {
      return value.includes(`"deploymentId":"${first.deploymentId}"`);
    }),
  ).toBeTruthy();
  session();
  const changed = await accept(
    api()(artifactSharesContract).update({
      headers,
      body: { target: newer, audience: "organization" },
    }),
    [200],
  );
  expect(changed.body).toMatchObject({
    selectedTarget: newer,
    selectedVersion: 2,
    url: `https://app.okou.ai${second.url}`,
  });
  expect(changed.body.shortUrl).toBe(`https://app.okou.ai${second.url}`);
  session(recipient);
  await accept(
    api()(artifactReferencesContract).resolve({
      headers,
      params: { reference: first.url.slice("/artifacts/".length) },
    }),
    [404],
  );
  const current = await accept(
    api()(artifactReferencesContract).resolve({
      headers,
      params: { reference: second.url.slice("/artifacts/".length) },
    }),
    [200],
  );
  expect(current.body.target).toStrictEqual(newer);
});

test("public site names stay on the selected version and rotate after revocation", async () => {
  const { actor } = await hostedFixture();
  const host = createHostMapsBddApi(context);
  const body = {
    site: `named-${randomUUID().slice(0, 8)}`,
    artifactKind: "hosted-site" as const,
    spaFallback: false,
    files: [hostedTextFile("/index.html", "<h1>First</h1>")],
  };
  const first = await host.prepareHostedSite(actor, body);
  await host.completeHostedSite(actor, first.deploymentId);
  const target = { kind: "html" as const, id: first.deploymentId };
  const publish = async (id = target.id) => {
    return (
      await accept(
        api()(artifactSharesContract).update({
          headers,
          body: { target: { kind: "html", id }, audience: "public" },
        }),
        [200],
      )
    ).body;
  };
  const published = await publish();
  expect(published.url).toBe(`https://${first.publicSlug}.okou.app/`);
  expect(published.shortUrl).toBe(published.url);
  const next = await host.prepareHostedSite(actor, {
    ...body,
    files: [hostedTextFile("/index.html", "<h1>Second</h1>")],
  });
  await host.completeHostedSite(actor, next.deploymentId);
  const pending = await accept(
    api()(artifactSharesContract).status({
      headers,
      body: { kind: "html", id: next.deploymentId },
    }),
    [200],
  );
  expect(pending.body).toMatchObject({
    url: published.url,
    selectedVersion: 1,
    candidateVersion: 2,
  });
  await expect(publish(next.deploymentId)).resolves.toMatchObject({
    url: published.url,
    selectedVersion: 2,
  });
  await accept(
    api()(artifactSharesContract).update({
      headers,
      body: { target, audience: "private" },
    }),
    [200],
  );
  const republished = await publish(next.deploymentId);
  expect(new URL(republished.url!).hostname).toMatch(
    new RegExp(`^${first.publicSlug}-[a-z0-9]{4}\\.okou\\.app$`, "u"),
  );
  expect(republished.url).not.toBe(published.url);
});

test.each([false, true])(
  "historical public HTML policies name the site only on explicit sharing (alias retained=%s)",
  async (retainAlias) => {
    const { actor, objects } = await hostedFixture();
    const host = createHostMapsBddApi(context);
    const prepared = await host.prepareHostedSite(actor, {
      site: `historical-${randomUUID().slice(0, 8)}`,
      artifactKind: "hosted-site",
      spaFallback: false,
      files: [hostedTextFile("/index.html", "<h1>Existing report</h1>")],
    });
    await host.completeHostedSite(actor, prepared.deploymentId);
    const target = { kind: "html" as const, id: prepared.deploymentId };
    const published = await accept(
      api()(artifactSharesContract).update({
        headers,
        body: { target, audience: "public" },
      }),
      [200],
    );
    // Current writers always allocate a name. External storage fixtures model
    // an older policy, or an older writer dropping the field after allocation.
    const key = `artifact-shares/okou/${published.body.shareId}.json`;
    const historical = artifactSharePolicySchema.parse(
      JSON.parse(objects.get(key)!),
    );
    if (!retainAlias) {
      objects.delete(
        artifactDeliveryKey("okou", "html", historical.publicSlug!),
      );
    }
    delete historical.publicSlug;
    objects.set(key, JSON.stringify(historical));
    const before = new Map(objects);
    const status = await accept(
      api()(artifactSharesContract).status({ headers, body: target }),
      [200],
    );
    expect(status.body.url).toBe(`https://${historical.publicToken}.okou.app/`);
    expect(status.body.shortUrl).toBeNull();
    expect(objects).toStrictEqual(before);

    const updated = await accept(
      api()(artifactSharesContract).update({
        headers,
        body: { target, audience: "public" },
      }),
      [200],
    );
    expect(updated.body.url).toBe(published.body.url);
    expect(updated.body.shortUrl).toBe(published.body.url);
  },
);

test("a historical public site name receives a short collision suffix without overwriting its alias", async () => {
  const { actor, objects } = await hostedFixture();
  const host = createHostMapsBddApi(context);
  const prepared = await host.prepareHostedSite(actor, {
    site: `occupied-${randomUUID().slice(0, 8)}`,
    artifactKind: "hosted-site",
    spaFallback: false,
    files: [hostedTextFile("/index.html", "<h1>New report</h1>")],
  });
  await host.completeHostedSite(actor, prepared.deploymentId);
  const legacyKey = `sites/brands/okou/${prepared.publicSlug}/active.json`;
  objects.set(legacyKey, JSON.stringify({ version: 1, siteId: "historical" }));
  const target = { kind: "html" as const, id: prepared.deploymentId };
  const published = await accept(
    api()(artifactSharesContract).update({
      headers,
      body: { target, audience: "public" },
    }),
    [200],
  );
  expect(new URL(published.body.url!).hostname).toMatch(
    new RegExp(`^${prepared.publicSlug}-[a-z0-9]{4}\\.okou\\.app$`, "u"),
  );
  const status = await accept(
    api()(artifactSharesContract).status({ headers, body: target }),
    [200],
  );
  expect(status.body.url).toBe(published.body.url);
  expect(objects.get(legacyKey)).toBe(
    JSON.stringify({ version: 1, siteId: "historical" }),
  );
});

test("organization short-reference collisions retry without taking another share's address", async () => {
  const { objects } = await fixture();
  const original = await file();
  const originalShare = await accept(
    api()(artifactSharesContract).update({
      headers,
      body: { target: original, audience: "organization" },
    }),
    [200],
  );
  const storage = context.mocks.s3.send.getMockImplementation()!;
  let collision: string | undefined;
  context.mocks.s3.send.mockImplementation((cmd) => {
    if (
      !collision &&
      cmd instanceof PutObjectCommand &&
      cmd.input.Key?.startsWith("artifact-references/")
    ) {
      collision = cmd.input.Key;
      objects.set(
        collision,
        JSON.stringify({ version: 1, shareId: originalShare.body.shareId }),
      );
    }
    return storage(cmd);
  });
  const target = await file();
  const shared = await accept(
    api()(artifactSharesContract).update({
      headers,
      body: { target, audience: "organization" },
    }),
    [200],
  );
  const reference = new URL(shared.body.shortUrl!).pathname.split("/").at(-1)!;
  expect(reference).toMatch(/^[a-z0-9]{10}\.pdf$/u);
  const resolved = await accept(
    api()(artifactReferencesContract).resolve({
      headers,
      params: { reference },
    }),
    [200],
  );
  expect(resolved.body.target).toStrictEqual(target);
  const occupied = await accept(
    api()(artifactReferencesContract).resolve({
      headers,
      params: {
        reference: collision!.split("/").at(-1)!.replace(".json", ".pdf"),
      },
    }),
    [200],
  );
  expect(occupied.body.target).toStrictEqual(original);
});

test("a failed publication write does not report a narrower audience, and unavailable policy fails closed", async () => {
  await fixture();
  const target = await file();
  const first = await accept(
    api()(artifactSharesContract).update({
      headers,
      body: { target, audience: "public" },
    }),
    [200],
  );
  const storage = context.mocks.s3.send.getMockImplementation()!;
  context.mocks.s3.send.mockImplementation((cmd) => {
    if (
      cmd instanceof PutObjectCommand &&
      cmd.input.Key?.startsWith("artifact-shares/")
    ) {
      return Promise.reject(new Error("Storage write unavailable"));
    }
    return storage(cmd);
  });
  await accept(
    api()(artifactSharesContract).update({
      headers,
      body: { target, audience: "organization" },
    }),
    [500],
  );
  const state = await accept(
    api()(artifactSharesContract).status({ headers, body: target }),
    [200],
  );
  expect(state.body).toMatchObject({ audience: "public", url: first.body.url });
  context.mocks.s3.send.mockRejectedValue(new Error("Storage unavailable"));
  await accept(
    api()(artifactSharesContract).resolve({
      headers,
      params: { id: first.body.shareId! },
    }),
    [500],
  );
});

test("sharing copies file bytes once into private storage without changing the owner reference", async () => {
  await fixture();
  const target = await file();
  await accept(
    api()(artifactSharesContract).update({
      headers,
      body: { target, audience: "organization" },
    }),
    [200],
  );
  const copies = context.mocks.s3.send.mock.calls.filter(([cmd]) => {
    return cmd instanceof CopyObjectCommand;
  });
  expect(copies).toHaveLength(1);
  expect(copies[0]?.[0]).toMatchObject({
    input: {
      Bucket: "test-private-artifacts",
      CopySource: `test-private-artifacts/private-artifacts/${target.id}/report.pdf`,
      Key: expect.stringContaining(`/shares/`),
    },
  });
  await accept(
    api()(artifactSharesContract).update({
      headers,
      body: { target, audience: "public" },
    }),
    [200],
  );
  expect(
    context.mocks.s3.send.mock.calls.filter(([cmd]) => {
      return cmd instanceof CopyObjectCommand;
    }),
  ).toHaveLength(1);
  const ownerPreview = await accept(
    api()(webFilesContract).fileUrl({ headers, query: { file_id: target.id } }),
    [200],
  );
  expect(ownerPreview.body.publicUrl).toBeNull();
});

test("a delayed writer cannot resurrect a public grant after a newer revocation", async () => {
  const { objects } = await fixture();
  const target = await file();
  const shared = await accept(
    api()(artifactSharesContract).update({
      headers,
      body: { target, audience: "public" },
    }),
    [200],
  );
  const key = `artifact-shares/okou/${shared.body.shareId}.json`;
  const storage = context.mocks.s3.send.getMockImplementation()!;
  context.mocks.s3.send.mockImplementation((cmd) => {
    if (cmd instanceof PutObjectCommand && cmd.input.Key === key) {
      // A different writer committed after this request's read. R2 must reject
      // its stale If-Match even if the old process lost its database row lock.
      const previous = JSON.parse(objects.get(key)!);
      objects.set(
        key,
        JSON.stringify({
          ...previous,
          revision: randomUUID(),
          audience: "private",
          status: "revoked",
          publicToken: null,
        }),
      );
    }
    return storage(cmd);
  });
  await accept(
    api()(artifactSharesContract).update({
      headers,
      body: { target, audience: "public" },
    }),
    [500],
  );
  const status = await accept(
    api()(artifactSharesContract).status({ headers, body: target }),
    [200],
  );
  expect(status.body).toMatchObject({ audience: "private", url: null });
  await accept(
    api()(artifactSharesContract).resolve({
      headers,
      params: { id: shared.body.shareId! },
    }),
    [404],
  );
});
