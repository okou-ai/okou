import { describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";

import { server } from "../../../mocks/server";
import { singleAgentEnabled } from "../single-agent";

function runToken(singleAgent?: true): string {
  const payload = Buffer.from(
    JSON.stringify({
      scope: "okou",
      userId: "current-member",
      orgId: "current-org",
      runId: "current-run",
      capabilities: [],
      ...(singleAgent === true ? { singleAgent } : {}),
    }),
  ).toString("base64url");
  return `vm0_sandbox_header.${payload}.signature`;
}

describe("My Okou CLI context", () => {
  it.each([true, undefined] as const)(
    "keeps a Run's captured mode %s independent of current member overrides",
    async (captured) => {
      vi.stubEnv("OKOU_TOKEN", runToken(captured));
      vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
      server.use(
        http.get("http://localhost:3000/api/feature-switches", () => {
          return HttpResponse.json({
            switches: { singleAgent: captured !== true },
            effectiveSwitches: { singleAgent: captured !== true },
          });
        }),
      );

      await expect(singleAgentEnabled()).resolves.toBe(captured === true);
    },
  );

  it("resolves non-Run CLI mode through the active member's authenticated API", async () => {
    vi.stubEnv("OKOU_TOKEN", "current-cli-token");
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    server.use(
      http.get("http://localhost:3000/api/feature-switches", ({ request }) => {
        expect(request.headers.get("authorization")).toBe(
          "Bearer current-cli-token",
        );
        return HttpResponse.json({
          switches: { singleAgent: true },
          effectiveSwitches: { singleAgent: true },
        });
      }),
    );

    await expect(singleAgentEnabled()).resolves.toBe(true);
  });

  it("surfaces member-context authorization failures instead of choosing a mode", async () => {
    vi.stubEnv("OKOU_TOKEN", "expired-cli-token");
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    server.use(
      http.get("http://localhost:3000/api/feature-switches", () => {
        return HttpResponse.json(
          { error: { message: "Unauthorized", code: "UNAUTHORIZED" } },
          { status: 401 },
        );
      }),
    );

    await expect(singleAgentEnabled()).rejects.toThrow();
  });
});
