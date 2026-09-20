import { randomUUID } from "node:crypto";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { beforeEach, expect, test } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { createAppWithRoutes } from "../../../app-factory-core";
import { featureSwitchesRoutes } from "../feature-switches";
import { uploadsPrepareRoutes } from "../uploads-prepare";
import { hostRoutes } from "../host";
import { imageIoGenerateRoutes } from "../image-io-generate";
import { videoIoGenerateRoutes } from "../video-io-generate";
import { voiceIoSpeechRoutes } from "../voice-io-speech";
import { avatarVideoRoutes } from "../avatar-video";
import { hostedTextFile } from "./helpers/api-bdd-host-files";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const mocks = createRouteMocks(context);
const headers = Object.freeze({
  authorization: "Bearer clerk-session",
  "content-type": "application/json",
});
const routes = Object.freeze([
  ...featureSwitchesRoutes,
  ...uploadsPrepareRoutes,
  ...hostRoutes,
  ...imageIoGenerateRoutes,
  ...videoIoGenerateRoutes,
  ...voiceIoSpeechRoutes,
  ...avatarVideoRoutes,
]);
const creations = [
  {
    path: "/api/uploads/prepare",
    body: { filename: "report.txt", contentType: "text/plain", size: 6 },
  },
  {
    path: "/api/host/deployments/prepare",
    body: {
      site: "private-report",
      files: [hostedTextFile("/index.html", "<main>Report</main>")],
    },
  },
  {
    path: "/api/image-io/generate",
    body: { prompt: "A private landscape", model: "flux-pro-1.1" },
  },
  {
    path: "/api/video-io/generate",
    body: { prompt: "A private landscape" },
  },
  {
    path: "/api/voice-io/speech",
    body: { text: "A private report" },
  },
  {
    path: "/api/avatar-video/generate",
    body: { avatarId: 81, voiceId: "en-US-ChristopherNeural", script: "Hello" },
  },
] as const;

beforeEach(async () => {
  mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
  await accept(
    setupApp({ context, routes })(featureSwitchesContract).update({
      headers,
      body: { switches: { [FeatureSwitchKey.PrivateArtifacts]: false } },
    }),
    [200],
  );
});

test.each(creations)(
  "rejects $path/private before allocating storage or starting billed generation when disabled",
  async ({ path, body }) => {
    const app = createAppWithRoutes({ signal: context.signal, routes });
    // The path itself enforces privacy even if an old or malformed caller
    // omits the optional request field.
    const response = await app.request(`${path}/private`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toStrictEqual({
      error: {
        code: "FORBIDDEN",
        message: "Artifact visibility requires private artifacts to be enabled",
      },
    });
    expect(context.mocks.s3.getSignedUrl).not.toHaveBeenCalled();
    expect(context.mocks.s3.send).not.toHaveBeenCalled();
  },
);

test.each(["/api/video-io/generate", "/api/avatar-video/generate"])(
  "preserves the existing %s plan error before invalid-body validation",
  async (path) => {
    const app = createAppWithRoutes({ signal: context.signal, routes });
    const response = await app.request(path, {
      method: "POST",
      headers,
      body: "{",
    });
    expect(response.status).toBe(402);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "PRO_REQUIRED" },
    });
  },
);

test("honors an explicit privacy requirement on the existing upload route without changing legacy callers", async () => {
  const app = createAppWithRoutes({ signal: context.signal, routes });
  const response = await app.request("/api/uploads/prepare", {
    method: "POST",
    headers,
    body: JSON.stringify({
      filename: "report.txt",
      contentType: "text/plain",
      size: 6,
      requirePrivateArtifact: true,
    }),
  });
  expect(response.status).toBe(403);
  expect(context.mocks.s3.getSignedUrl).not.toHaveBeenCalled();
});

test("does not let a false request field bypass the private creation route", async () => {
  const app = createAppWithRoutes({ signal: context.signal, routes });
  const response = await app.request("/api/uploads/prepare/private", {
    method: "POST",
    headers,
    body: JSON.stringify({
      filename: "report.txt",
      contentType: "text/plain",
      size: 6,
      requirePrivateArtifact: false,
    }),
  });
  expect(response.status).toBe(403);
  expect(context.mocks.s3.getSignedUrl).not.toHaveBeenCalled();
});
