import { randomBytes, randomUUID } from "node:crypto";
import { runnerFileDownloadsContract } from "@okouai/api-contracts/contracts/runner-file-downloads";
import { describe, expect, it } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { runnerFileDownloadRoutes } from "../runner-file-downloads";
import { createRouteMocks } from "./helpers/route-test";

describe("file download authority-store outage", () => {
  const context = testContext();
  const mocks = createRouteMocks(context);
  it("cannot issue or consume when database authority is unavailable", async () => {
    mockEnv("DATABASE_URL", "postgresql://postgres@127.0.0.1:1/unavailable");
    mockEnv("DB_POOL_CONNECT_TIMEOUT_MS", 200);
    mocks.clerk.session("user_download_outage", "org_download_outage");
    const client = setupApp({
      context,
      routes: runnerFileDownloadRoutes,
      rethrowErrors: true,
    })(runnerFileDownloadsContract);
    await expect(
      client.bootstrap({
        params: { runId: randomUUID() },
        headers: { authorization: "Bearer clerk-session" },
        body: { path: ["ZmlsZQ"] },
      }),
    ).rejects.toThrow(/ECONNREFUSED/);
    await expect(
      client.consume({
        headers: {
          authorization:
            "Bearer vm0_official_abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
        },
        body: {
          runId: randomUUID(),
          runnerId: randomUUID(),
          origin: "https://runner.example.com:443",
          ticket: randomBytes(32).toString("base64url"),
        },
      }),
    ).rejects.toMatchObject({
      cause: expect.objectContaining({ code: "ECONNREFUSED" }),
    });
  });
});
