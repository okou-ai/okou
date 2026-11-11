import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { server } from "../../../mocks/server";
import { createSshRequestAccessCommand } from "../request-access";

const id = "a0000000-0000-4000-8000-000000000001";
const request = {
  id,
  chatThreadId: "b0000000-0000-4000-8000-000000000001",
  connectionId: id,
  requestedByRunId: "c0000000-0000-4000-8000-000000000001",
  displayName: "Work Mac",
  host: "ssh.example.com",
  port: 22,
  username: "deploy",
  reason: "Verify login",
  status: "pending",
  requestExpiresAt: "2026-11-11T12:00:00.000Z",
  enabled: false,
  continuationPending: false,
  approvalBlockedReason: "run_active",
  requiredPermissions: [],
  authorizationUrl: `https://app.okou.ai/ssh/authorize/${id}`,
};
const log = vi.spyOn(console, "log").mockImplementation(() => {});
const error = vi.spyOn(console, "error").mockImplementation(() => {});
vi.spyOn(process, "exit").mockImplementation((): never => {
  throw new Error("CLI exit");
});
beforeEach(() => {
  const payload = Buffer.from(
    JSON.stringify({ scope: "okou", capabilities: ["connector:read"] }),
  ).toString("base64url");
  vi.stubEnv("OKOU_TOKEN", `vm0_sandbox_header.${payload}.signature`);
  vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
});
afterEach(() => {
  vi.unstubAllEnvs();
  log.mockClear();
  error.mockClear();
  process.exitCode = 0;
});
it("requests only the configured host and accompanying permissions and preserves the review URL", async () => {
  let received: unknown;
  server.use(
    http.post(
      "http://localhost:3000/api/ssh/authorizations",
      async ({ request: incoming }) => {
        received = await incoming.json();
        return HttpResponse.json(request);
      },
    ),
  );
  await createSshRequestAccessCommand().parseAsync(
    [
      id,
      "--reason",
      "Verify login",
      "--callback-prompt",
      "Continue SSH setup",
      "--require-permission",
      "cloudflare/dns.write",
      "--require-permission",
      "cloudflare/argotunnel.write",
      "--json",
    ],
    { from: "user" },
  );
  expect(received).toEqual({
    connectionId: id,
    reason: "Verify login",
    callbackPrompt: "Continue SSH setup",
    requiredPermissions: [
      { connectorSlug: "cloudflare", permission: "dns.write" },
      { connectorSlug: "cloudflare", permission: "argotunnel.write" },
    ],
  });
  expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toEqual(request);
});
it("prints a review action and continuation guidance for a host-only request", async () => {
  server.use(
    http.post("http://localhost:3000/api/ssh/authorizations", () => {
      return HttpResponse.json(request);
    }),
  );
  await createSshRequestAccessCommand().parseAsync(
    [id, "--reason", "Verify login"],
    { from: "user" },
  );
  expect(log.mock.calls.flat()).toContain(request.authorizationUrl);
  expect(log.mock.calls.flat().join("\n")).toContain("end this Run");
});
it("reports unavailable approval support without claiming the host is enabled", async () => {
  server.use(
    http.post("http://localhost:3000/api/ssh/authorizations", () => {
      return HttpResponse.json(
        {
          error: { code: "NOT_FOUND", message: "SSH access request not found" },
        },
        { status: 404 },
      );
    }),
  );
  await expect(
    createSshRequestAccessCommand().parseAsync(
      [id, "--reason", "Verify login"],
      { from: "user" },
    ),
  ).rejects.toThrow("CLI exit");
  expect(log).not.toHaveBeenCalled();
});
