import { http, HttpResponse } from "msw";
import { afterEach, expect, it, vi } from "vitest";
import { server } from "../../mocks/server";
import { remoteCommand } from "../remote";

const chatThreadId = "a0000000-0000-4000-8000-000000000001";
const deviceId = "b0000000-0000-4000-8000-000000000001";
const channelId = "c0000000-0000-4000-8000-000000000001";
const devices = [
  {
    id: deviceId,
    displayName: "Work Mac",
    accessAllowed: false,
    accessExpiresAt: null,
    channels: [
      {
        kind: "ssh",
        id: channelId,
        displayName: "Build login",
        lastSeenAt: null,
        sshDependencyIds: [],
      },
    ],
  },
];

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it("prints exact channel IDs and builds a Chat-scoped approval link from the Run directory", async () => {
  vi.stubEnv("OKOU_TOKEN", "remote-device-run-token");
  vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
  vi.stubEnv("OKOU_APP_URL", "https://app.okou.ai");
  server.use(
    http.get("http://localhost:3000/api/run/remote-devices", () => {
      return HttpResponse.json({ chatThreadId, devices });
    }),
  );
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  await remoteCommand.parseAsync(["list", "--json"], { from: "user" });
  expect(JSON.parse(String(log.mock.lastCall?.[0]))).toEqual({ devices });

  await remoteCommand.parseAsync(
    [
      "request-access",
      deviceId,
      "--reason",
      "Check build + test logs",
      "--callback-prompt",
      "Continue checking logs",
      "--json",
    ],
    { from: "user" },
  );
  const action = JSON.parse(String(log.mock.lastCall?.[0])) as {
    authorizationUrl: string;
  };
  const url = new URL(action.authorizationUrl);
  expect(url.origin).toBe("https://app.okou.ai");
  expect(url.pathname).toBe(`/chats/${chatThreadId}`);
  expect(url.searchParams.get("remoteDeviceApproval")).toBe(deviceId);
  expect(url.searchParams.get("reason")).toBe("Check build + test logs");
  expect(url.searchParams.get("callbackPrompt")).toBe("Continue checking logs");
  expect(url.searchParams.get("threadId")).toBe(chatThreadId);
});
