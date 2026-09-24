import { randomUUID } from "node:crypto";
import { beforeEach, expect, test } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { createAppWithRoutes } from "../../../app-factory-core";
import { avatarVideoRoutes } from "../avatar-video";
import { videoIoGenerateRoutes } from "../video-io-generate";
import { voiceIoSpeechRoutes } from "../voice-io-speech";

const context = testContext();
const endpoints = [
  { path: "/api/video-io/generate", method: "POST" },
  { path: "/api/video-io/generate/private", method: "POST" },
  { path: "/api/voice-io/speech", method: "POST" },
  { path: "/api/voice-io/speech/private", method: "POST" },
  { path: "/api/avatar-video/generate", method: "POST" },
  { path: "/api/avatar-video/generate/private", method: "POST" },
  { path: "/api/avatar-video/avatars", method: "GET" },
  { path: "/api/avatar-video/voices", method: "GET" },
] as const;

function app() {
  return createAppWithRoutes({
    signal: context.signal,
    routes: [
      ...videoIoGenerateRoutes,
      ...voiceIoSpeechRoutes,
      ...avatarVideoRoutes,
    ],
  });
}

beforeEach(() => {
  context.mocks.clerk.authenticateRequest.mockReset();
  context.mocks.clerk.authenticateRequest.mockResolvedValue({
    isAuthenticated: false,
  });
});

test.each(endpoints)(
  "authenticates $method $path before the retirement response",
  async ({ path, method }) => {
    const response = await app().request(path, { method });
    expect(response.status).toBe(401);
  },
);

test.each(endpoints)(
  "tells a stale caller that $method $path is retired before validating generation input",
  async ({ path, method }) => {
    context.mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
    const response = await app().request(path, {
      method,
      headers: {
        authorization: "Bearer clerk-session",
        "content-type": "application/json",
      },
      // An installed old CLI or open browser may still invoke this endpoint.
      // The retirement response owns admission, even before body/plan validation.
      ...(method === "POST" ? { body: "{" } : {}),
    });
    expect(response.status).toBe(410);
    await expect(response.json()).resolves.toStrictEqual({
      error: {
        code: "GENERATION_RETIRED",
        message:
          "Built-in video, voice, and avatar generation is no longer available.",
      },
    });
  },
);
