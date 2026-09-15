import { randomUUID } from "node:crypto";
import { createStore } from "ccstate";
import { describe, expect, it } from "vitest";
import type { Capability } from "@okouai/api-contracts/contracts/capabilities";

import { createAppWithRoutes } from "../../../app-factory-core";
import { mockEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { testContext } from "../../../__tests__/test-context";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { webDownloadRoutes } from "../web-download";
import { seedOrgMembership$ } from "./helpers/org-membership";

const context = testContext();
const store = createStore();
const BUCKET = "test-user-artifacts";
const ROUTE = "/api/web/download-file";

interface S3FixtureObject {
  readonly key: string;
  readonly size: number;
  readonly body: Buffer | AsyncIterable<Uint8Array>;
  readonly downloadError?: Error;
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

function bodyStream(buffer: Buffer): AsyncIterable<Uint8Array> {
  return (async function* stream(): AsyncIterable<Uint8Array> {
    yield buffer;
  })();
}

function mockS3Objects(objects: readonly S3FixtureObject[]): void {
  mockEnv("R2_USER_ARTIFACTS_BUCKET_NAME", BUCKET);
  context.mocks.s3.send.mockImplementation((command: unknown) => {
    const input = commandInput(command);
    const bucket = typeof input.Bucket === "string" ? input.Bucket : "";
    const prefix = typeof input.Prefix === "string" ? input.Prefix : undefined;
    const key = typeof input.Key === "string" ? input.Key : undefined;

    if (prefix !== undefined) {
      return Promise.resolve({
        Contents: objects
          .filter((object) => {
            return object.key.startsWith(prefix) && bucket === BUCKET;
          })
          .map((object) => {
            return {
              Key: object.key,
              Size: object.size,
              LastModified: new Date("2025-01-01T00:00:00.000Z"),
            };
          }),
      });
    }

    if (key !== undefined) {
      const object = objects.find((candidate) => {
        return candidate.key === key && bucket === BUCKET;
      });
      if (object?.downloadError) {
        return Promise.reject(object.downloadError);
      }
      return Promise.resolve({
        Body: object
          ? Buffer.isBuffer(object.body)
            ? bodyStream(object.body)
            : object.body
          : bodyStream(Buffer.alloc(0)),
        ContentLength: object?.size,
        $metadata: {
          httpStatusCode: 200,
          requestId: randomUUID(),
          attempts: 1,
        },
      });
    }

    return Promise.resolve({});
  });
}

function requestDownload(args: {
  readonly fileId?: string;
  readonly token?: string;
}): Promise<Response> {
  const search =
    args.fileId === undefined
      ? ""
      : `?file_id=${encodeURIComponent(args.fileId)}`;
  const headers: Record<string, string> = args.token
    ? { authorization: `Bearer ${args.token}` }
    : {};
  const app = createAppWithRoutes({
    signal: context.signal,
    routes: webDownloadRoutes,
  });
  return Promise.resolve(
    app.request(`${ROUTE}${search}`, { method: "GET", headers }),
  );
}

function artifactKey(userId: string, fileId: string, filename: string): string {
  return `artifacts/${userId}/${fileId}/${filename}`;
}

async function expectErrorResponse(
  response: Response,
  status: number,
  code: string,
): Promise<void> {
  expect(response.status).toBe(status);
  const body = (await response.json()) as {
    readonly error?: { readonly code?: string };
  };
  expect(body.error?.code).toBe(code);
}

describe("GET /api/web/download-file", () => {
  it("returns 401 when no auth token is provided", async () => {
    expect.hasAssertions();
    const response = await requestDownload({ fileId: "abc" });

    await expectErrorResponse(response, 401, "UNAUTHORIZED");
  });

  it("returns 403 for an agent token without file:read capability", async () => {
    expect.hasAssertions();
    const token = mintOkouToken({
      userId: `user_${randomUUID()}`,
      orgId: `org_${randomUUID()}`,
      capabilities: ["agent:read"],
    });

    const response = await requestDownload({ fileId: "abc", token });

    await expectErrorResponse(response, 403, "FORBIDDEN");
  });

  it("returns 400 when file_id query param is missing", async () => {
    expect.hasAssertions();
    const { token } = await mintFileReadToken();

    const response = await requestDownload({ token });

    await expectErrorResponse(response, 400, "BAD_REQUEST");
  });

  it("returns 400 when file_id query param is empty", async () => {
    expect.hasAssertions();
    const { token } = await mintFileReadToken();

    const response = await requestDownload({ fileId: "", token });

    await expectErrorResponse(response, 400, "BAD_REQUEST");
  });

  it("returns 404 when the file is not found in S3", async () => {
    expect.hasAssertions();
    const { token } = await mintFileReadToken();
    mockS3Objects([]);

    const response = await requestDownload({ fileId: "missing", token });

    await expectErrorResponse(response, 404, "NOT_FOUND");
  });

  it("downloads a text file and returns matching headers", async () => {
    const fileId = "test-file-uuid";
    const fileContent = Buffer.from("hello world");
    const { token, userId } = await mintFileReadToken();
    mockS3Objects([
      {
        key: artifactKey(userId, fileId, "test_file.txt"),
        size: fileContent.length,
        body: fileContent,
      },
    ]);

    const response = await requestDownload({ fileId, token });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain");
    expect(response.headers.get("x-file-name")).toBe("test_file.txt");
    expect(response.headers.get("x-file-mimetype")).toBe("text/plain");
    expect(response.headers.get("content-length")).toBe(
      String(fileContent.length),
    );
    const receivedBytes = Buffer.from(await response.arrayBuffer());
    expect(receivedBytes.equals(fileContent)).toBeTruthy();
  });

  it("returns a generic failure when the storage download request fails", async () => {
    const fileId = randomUUID();
    const { token, userId } = await mintFileReadToken();
    mockS3Objects([
      {
        key: artifactKey(userId, fileId, "report.zip"),
        size: 128,
        body: Buffer.alloc(0),
        downloadError: new Error("Storage request failed"),
      },
    ]);

    const response = await requestDownload({ fileId, token });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toStrictEqual({
      error: "Internal server error",
    });
    expect(response.headers.get("x-file-name")).toBeNull();
  });

  it("does not serve partial bytes when the storage body is interrupted", async () => {
    const fileId = randomUUID();
    const { token, userId } = await mintFileReadToken();
    const filename = "private-financial-export.zip";
    const key = artifactKey(userId, fileId, filename);
    const privateContent = Buffer.from("private file contents");
    const storageUrl = "https://storage.example/private.zip?signature=secret";
    const reset = Object.assign(new Error("aborted"), {
      code: "ECONNRESET",
      storageUrl,
    });
    mockS3Objects([
      {
        key,
        size: privateContent.length + 100,
        body: (async function* interruptedBody(): AsyncIterable<Uint8Array> {
          yield privateContent;
          throw reset;
        })(),
      },
    ]);

    const response = await requestDownload({ fileId, token });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toStrictEqual({
      error: "Internal server error",
    });
    expect(response.headers.get("x-file-name")).toBeNull();
  });

  it("downloads a canonical Slack input only for its owning user", async () => {
    const assetId = randomUUID();
    const fileContent = Buffer.from("private Slack attachment");
    const owner = await mintFileReadToken();
    const storageKey = artifactKey(owner.userId, assetId, "private_notes.md");
    mockS3Objects([
      {
        key: storageKey,
        size: fileContent.length,
        body: fileContent,
      },
    ]);

    const response = await requestDownload({
      fileId: assetId,
      token: owner.token,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/markdown");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(Buffer.from(await response.arrayBuffer())).toStrictEqual(
      fileContent,
    );

    const otherUser = await mintFileReadToken();
    const forbiddenResponse = await requestDownload({
      fileId: assetId,
      token: otherUser.token,
    });
    await expectErrorResponse(forbiddenResponse, 404, "NOT_FOUND");
  });

  it("encodes the file name header while preserving the binary body", async () => {
    const fileId = "encoded-name-uuid";
    const fileContent = Buffer.from([0, 1, 2, 3, 255]);
    const { token, userId } = await mintFileReadToken();
    const filename = "report 2026 #final.bin";
    mockS3Objects([
      {
        key: artifactKey(userId, fileId, filename),
        size: fileContent.length,
        body: fileContent,
      },
    ]);

    const response = await requestDownload({ fileId, token });

    expect(response.status).toBe(200);
    expect(response.headers.get("x-file-name")).toBe(
      encodeURIComponent(filename),
    );
    expect(response.headers.get("content-length")).toBe(
      String(fileContent.length),
    );
    const receivedBytes = Buffer.from(await response.arrayBuffer());
    expect(receivedBytes.equals(fileContent)).toBeTruthy();
  });

  it("downloads an image file with the image MIME type", async () => {
    const fileId = "img-uuid";
    const fileContent = Buffer.from("fake-png-data");
    const { token, userId } = await mintFileReadToken();
    mockS3Objects([
      {
        key: artifactKey(userId, fileId, "photo.png"),
        size: fileContent.length,
        body: fileContent,
      },
    ]);

    const response = await requestDownload({ fileId, token });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("x-file-mimetype")).toBe("image/png");
  });

  it("downloads an office file with the office MIME type", async () => {
    const fileId = "sheet-uuid";
    const fileContent = Buffer.from("fake-xlsx-data");
    const { token, userId } = await mintFileReadToken();
    mockS3Objects([
      {
        key: artifactKey(userId, fileId, "budget.xlsx"),
        size: fileContent.length,
        body: fileContent,
      },
    ]);

    const response = await requestDownload({ fileId, token });

    const expected =
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(expected);
    expect(response.headers.get("x-file-mimetype")).toBe(expected);
  });

  it("returns application/octet-stream for unknown extensions", async () => {
    const fileId = "bin-uuid";
    const fileContent = Buffer.from("binary-data");
    const { token, userId } = await mintFileReadToken();
    mockS3Objects([
      {
        key: artifactKey(userId, fileId, "data.xyz"),
        size: fileContent.length,
        body: fileContent,
      },
    ]);

    const response = await requestDownload({ fileId, token });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "application/octet-stream",
    );
  });

  it("scopes file lookup to the authenticated user", async () => {
    const fileId = "scoped-uuid";
    const { token, userId } = await mintFileReadToken();
    mockS3Objects([]);

    await requestDownload({ fileId, token });

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
