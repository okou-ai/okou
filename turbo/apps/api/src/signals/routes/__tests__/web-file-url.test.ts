import { randomUUID } from "node:crypto";
import { createStore } from "ccstate";
import { describe, expect, it } from "vitest";
import type { Capability } from "@okouai/api-contracts/contracts/capabilities";
import { webFilesContract } from "@okouai/api-contracts/contracts/web-files";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { mockNow, now } from "../../../lib/time";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { webFileUrlRoutes } from "../web-file-url";
import { expectApiError } from "./helpers/api-bdd";
import { seedOrgMembership$ } from "./helpers/org-membership";

const context = testContext();
const store = createStore();
const BUCKET = "test-user-artifacts";
const PRESIGNED_URL = "https://r2.example.com/artifacts/photo.png?sig=test";

function client() {
  return setupApp({ context, routes: webFileUrlRoutes })(webFilesContract);
}

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

function mintOkouToken(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly capabilities: readonly Capability[];
}): string {
  const seconds = currentSecond();
  return signSandboxJwtForTests({
    scope: "okou",
    userId: args.userId,
    orgId: args.orgId,
    runId: `run_${randomUUID()}`,
    capabilities: args.capabilities,
    iat: seconds,
    exp: seconds + 3600,
  });
}

async function mintFileReadToken(): Promise<{
  readonly orgId: string;
  readonly token: string;
  readonly userId: string;
}> {
  const orgId = `org_${randomUUID()}`;
  const userId = `user_${randomUUID()}`;
  await store.set(seedOrgMembership$, { orgId, userId }, context.signal);
  return {
    orgId,
    userId,
    token: mintOkouToken({
      userId,
      orgId,
      capabilities: ["file:read"],
    }),
  };
}

function authHeaders(token: string) {
  return { authorization: `Bearer ${token}` };
}

function commandInput(command: unknown): Record<string, unknown> {
  if (
    typeof command === "object" &&
    command !== null &&
    "input" in command &&
    typeof command.input === "object" &&
    command.input !== null
  ) {
    return command.input as Record<string, unknown>;
  }
  return {};
}

function signedObjectInputs(): Record<string, unknown>[] {
  return context.mocks.s3.getSignedUrl.mock.calls.map(([, command]) => {
    return commandInput(command);
  });
}

function signedOptions(): unknown[] {
  return context.mocks.s3.getSignedUrl.mock.calls.map((call) => {
    return call[2];
  });
}

function mockS3Objects(keys: readonly string[]): void {
  mockEnv("R2_USER_ARTIFACTS_BUCKET_NAME", BUCKET);
  context.mocks.s3.send.mockImplementation((command: unknown) => {
    const input = commandInput(command);
    const bucket = typeof input.Bucket === "string" ? input.Bucket : "";
    const prefix = typeof input.Prefix === "string" ? input.Prefix : undefined;

    if (prefix !== undefined) {
      return Promise.resolve({
        Contents: keys
          .filter((key) => {
            return key.startsWith(prefix) && bucket === BUCKET;
          })
          .map((key) => {
            return {
              Key: key,
              Size: 4,
              LastModified: new Date("2025-01-01T00:00:00.000Z"),
            };
          }),
      });
    }

    return Promise.resolve({});
  });
}

function artifactKey(userId: string, fileId: string, filename: string): string {
  return `artifacts/${userId}/${fileId}/${filename}`;
}

describe("GET /api/web/file-url", () => {
  it("returns 401 when no auth token is provided", async () => {
    const response = await accept(
      client().fileUrl({ headers: {}, query: { file_id: "abc" } }),
      [401],
    );

    expectApiError(response.body);
    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 403 for an agent token without file:read capability", async () => {
    const token = mintOkouToken({
      userId: `user_${randomUUID()}`,
      orgId: `org_${randomUUID()}`,
      capabilities: ["agent:read"],
    });

    const response = await accept(
      client().fileUrl({
        headers: authHeaders(token),
        query: { file_id: "abc" },
      }),
      [403],
    );

    expectApiError(response.body);
    expect(response.body.error.code).toBe("FORBIDDEN");
  });

  it("returns 400 when file_id query param is empty", async () => {
    const { token } = await mintFileReadToken();

    const response = await accept(
      client().fileUrl({ headers: authHeaders(token), query: { file_id: "" } }),
      [400],
    );

    expectApiError(response.body);
    expect(response.body.error.code).toBe("BAD_REQUEST");
  });

  it("returns 404 without signing anything when the file does not exist", async () => {
    const { token } = await mintFileReadToken();
    mockS3Objects([]);

    const response = await accept(
      client().fileUrl({
        headers: authHeaders(token),
        query: { file_id: "missing" },
      }),
      [404],
    );

    expectApiError(response.body);
    expect(response.body.error.code).toBe("NOT_FOUND");
    expect(signedObjectInputs()).toStrictEqual([]);
  });

  it("signs the resolved object key for the owning user", async () => {
    mockNow(new Date("2026-09-09T12:00:00.123Z"));
    const fileId = randomUUID();
    const { token, userId } = await mintFileReadToken();
    const key = artifactKey(userId, fileId, "photo.png");
    mockS3Objects([key]);
    context.mocks.s3.getSignedUrl.mockResolvedValue(PRESIGNED_URL);

    const response = await accept(
      client().fileUrl({
        headers: authHeaders(token),
        query: { file_id: fileId },
      }),
      [200],
    );

    expect(response.body.url).toBe(PRESIGNED_URL);
    expect(response.body.expiresAt).toBe("2026-09-11T12:00:00.000Z");
    expect(signedObjectInputs()).toStrictEqual([
      expect.objectContaining({ Bucket: BUCKET, Key: key }),
    ]);
    expect(signedOptions()).toStrictEqual([
      { expiresIn: 172_800, signingDate: new Date("2026-09-09T12:00:00.000Z") },
    ]);
  });

  it("reports the public artifacts url for the same object", async () => {
    mockEnv("R2_PRIVATE_ARTIFACTS_ACCESS_KEY_ID", undefined);
    mockEnv("R2_PRIVATE_ARTIFACTS_SECRET_ACCESS_KEY", undefined);
    const fileId = randomUUID();
    const { token, userId } = await mintFileReadToken();
    const key = artifactKey(userId, fileId, "photo.png");
    mockS3Objects([key]);
    context.mocks.s3.getSignedUrl.mockResolvedValue(PRESIGNED_URL);

    const response = await accept(
      client().fileUrl({
        headers: authHeaders(token),
        query: { file_id: fileId },
      }),
      [200],
    );

    // A shared link has to outlive the presigned window and carry no
    // credential, so it addresses the object on the public artifacts domain.
    expect(response.body.publicUrl).toBe(`https://cdn.vm7.io/${key}`);
    expect(response.headers.get("cache-control")).toBeNull();
  });

  it("signs an inline URL without a download disposition", async () => {
    const fileId = randomUUID();
    const { token, userId } = await mintFileReadToken();
    mockS3Objects([artifactKey(userId, fileId, "photo.png")]);

    await accept(
      client().fileUrl({
        headers: authHeaders(token),
        query: { file_id: fileId },
      }),
      [200],
    );

    expect(
      signedObjectInputs().map((input) => {
        return input.ResponseContentDisposition;
      }),
    ).toStrictEqual([undefined]);
  });

  it("does not sign a URL for a file owned by another user", async () => {
    const fileId = randomUUID();
    const owner = await mintFileReadToken();
    mockS3Objects([artifactKey(owner.userId, fileId, "private_notes.md")]);

    await accept(
      client().fileUrl({
        headers: authHeaders(owner.token),
        query: { file_id: fileId },
      }),
      [200],
    );

    const otherUser = await mintFileReadToken();
    const forbidden = await accept(
      client().fileUrl({
        headers: authHeaders(otherUser.token),
        query: { file_id: fileId },
      }),
      [404],
    );

    expectApiError(forbidden.body);
    expect(forbidden.body.error.code).toBe("NOT_FOUND");
    expect(signedObjectInputs()).toHaveLength(1);
  });

  it("scopes file lookup to the authenticated user", async () => {
    const fileId = "scoped-uuid";
    const { token, userId } = await mintFileReadToken();
    mockS3Objects([]);

    await accept(
      client().fileUrl({
        headers: authHeaders(token),
        query: { file_id: fileId },
      }),
      [404],
    );

    const prefixes = context.mocks.s3.send.mock.calls
      .map(([command]) => {
        return commandInput(command).Prefix;
      })
      .filter((prefix): prefix is string => {
        return typeof prefix === "string";
      });
    expect(prefixes).toContain(`artifacts/${userId}/${fileId}/`);
  });
});
