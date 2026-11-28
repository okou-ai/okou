import { randomUUID } from "node:crypto";
import { webFilesContract } from "@okouai/api-contracts/contracts/web-files";
import { beforeAll, describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE } from "../../../__tests__/test-timeouts";
import { mockOptionalEnv } from "../../../lib/env";
import { buildArtifactKey } from "../../../lib/file-url";
import { mockNow } from "../../../lib/time";
import { webFileUrlRoutes } from "../web-file-url";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createRouteMocks } from "./helpers/route-test";
import { createRunExecutionCredentials } from "./helpers/run-execution-credentials";

const context = testContext();
const bdd = createBddApi(context);
const credentials = createRunExecutionCredentials(context, {
  preferences: false,
});
const webFiles = setupApp({ context, routes: webFileUrlRoutes })(
  webFilesContract,
);

const ARTIFACTS_BUCKET = "test-user-artifacts";
const PRESIGNED_URL =
  "https://r2.signed.example.test/presigned-object?X-Amz-Signature=ok";

function disableClerkFallback(): void {
  context.mocks.clerk.authenticateRequest.mockResolvedValue({
    isAuthenticated: false,
  });
}

function mockMemberships(actors: readonly ApiTestUser[]): void {
  context.mocks.clerk.users.getOrganizationMembershipList.mockImplementation(
    (request: unknown) => {
      const userId =
        typeof request === "object" &&
        request !== null &&
        "userId" in request &&
        typeof request.userId === "string"
          ? request.userId
          : undefined;
      const actor = actors.find((candidate) => {
        return candidate.userId === userId;
      });
      return Promise.resolve({
        data: actor?.orgId
          ? [
              {
                role: actor.orgRole ?? "org:member",
                organization: { id: actor.orgId },
              },
            ]
          : [],
      });
    },
  );
}

function readSignedCall(index: number): {
  readonly input: Record<string, unknown>;
  readonly options: Record<string, unknown>;
} {
  const call = context.mocks.s3.getSignedUrl.mock.calls[index];
  if (!call) {
    throw new Error(`Expected getSignedUrl call at index ${String(index)}`);
  }
  const command: unknown = call[1];
  const options: unknown = call[2];
  const input =
    typeof command === "object" &&
    command !== null &&
    "input" in command &&
    typeof command.input === "object" &&
    command.input !== null
      ? (command.input as Record<string, unknown>)
      : {};
  return {
    input,
    options:
      typeof options === "object" && options !== null
        ? (options as Record<string, unknown>)
        : {},
  };
}

describe("GET /api/web/file-url", () => {
  beforeAll(async () => {
    await createRunsApi(context).configureRunnerGroup();
  });

  it(
    "web-file-url-004 signs the resolved object key for the owning user",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      mockNow(Date.parse("2026-09-09T12:00:00.123Z"));
      const member = bdd.user({ orgRole: "org:member" });
      const token = await credentials.okouToken(member);
      const fileId = randomUUID();
      const key = buildArtifactKey(member.userId, fileId, "photo.png");

      createRouteMocks(context).s3.listObjects([
        { bucket: ARTIFACTS_BUCKET, key, size: 128 },
      ]);
      context.mocks.s3.getSignedUrl.mockReset();
      context.mocks.s3.getSignedUrl.mockResolvedValue(PRESIGNED_URL);
      disableClerkFallback();
      mockMemberships([member]);

      const response = await accept(
        webFiles.fileUrl({
          headers: { authorization: `Bearer ${token}` },
          query: { file_id: fileId },
        }),
        [200],
      );

      expect(response.body).toMatchObject({
        url: PRESIGNED_URL,
        downloadUrl: PRESIGNED_URL,
        expiresAt: "2026-09-11T12:00:00.000Z",
        previewImageUrl: null,
      });
      expect(context.mocks.s3.getSignedUrl).toHaveBeenCalledTimes(2);

      const previewCall = readSignedCall(0);
      expect(previewCall.input).toMatchObject({
        Bucket: ARTIFACTS_BUCKET,
        Key: key,
      });
      expect(previewCall.input.ResponseContentDisposition).toBeUndefined();
      expect(previewCall.options).toStrictEqual({
        expiresIn: 172_800,
        signingDate: new Date("2026-09-09T12:00:00.000Z"),
      });

      const downloadCall = readSignedCall(1);
      expect(downloadCall.input).toMatchObject({
        Bucket: ARTIFACTS_BUCKET,
        Key: key,
        ResponseCacheControl: "private, no-store",
        ResponseContentDisposition: "attachment; filename*=UTF-8''photo.png",
      });
      expect(downloadCall.options).toStrictEqual({
        expiresIn: 172_800,
        signingDate: new Date("2026-09-09T12:00:00.123Z"),
      });
    },
  );

  it(
    "web-file-url-005 reports the public artifacts url for the same object",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const member = bdd.user({ orgRole: "org:member" });
      const token = await credentials.okouToken(member);
      const fileId = randomUUID();
      const key = buildArtifactKey(member.userId, fileId, "photo.png");

      mockOptionalEnv("R2_PRIVATE_ARTIFACTS_ACCESS_KEY_ID", undefined);
      mockOptionalEnv("R2_PRIVATE_ARTIFACTS_SECRET_ACCESS_KEY", undefined);
      createRouteMocks(context).s3.listObjects([
        { bucket: ARTIFACTS_BUCKET, key, size: 128 },
      ]);
      context.mocks.s3.getSignedUrl.mockReset();
      context.mocks.s3.getSignedUrl.mockResolvedValue(PRESIGNED_URL);
      disableClerkFallback();
      mockMemberships([member]);

      const response = await accept(
        webFiles.fileUrl({
          headers: { authorization: `Bearer ${token}` },
          query: { file_id: fileId },
        }),
        [200],
      );

      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(response.body.publicUrl).toBe(`https://cdn.vm7.io/${key}`);
    },
  );
});
