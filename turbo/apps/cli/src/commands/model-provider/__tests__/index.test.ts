import { http, HttpResponse } from "msw";
import { expect, it, vi } from "vitest";
import { server } from "../../../mocks/server";
import { modelProviderCommand } from "../index";

it("lists the current user's personal subscription route and reconnect guidance", async () => {
  vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
  vi.stubEnv("OKOU_TOKEN", "test-token");
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  server.use(
    http.get("http://localhost:3000/api/run-models", () => {
      return HttpResponse.json({
        defaultModel: "okou-1.0",
        models: [
          {
            model: "gpt-6-sol",
            modelLabel: "GPT 6 Sol",
            defaultProviderType: "codex-oauth-token",
            credentialScope: "member",
            modelProviderId: "00000000-0000-4000-8000-000000000102",
            routeStatus: "valid",
            routeStatusReason: null,
            memberEffective: {
              providerType: "codex-oauth-token",
              runtimeProviderType: "codex-oauth-token",
              credentialScope: "member",
              availability: "reconnect_required",
              accountSelection: "capture_required",
            },
          },
        ],
      });
    }),
  );
  try {
    await modelProviderCommand.parseAsync(["node", "cli", "ls"]);
    const output = log.mock.calls.flat().join("\n");
    expect(output).toContain("GPT 6 Sol");
    expect(output).toContain("provider: subscription");
    expect(output).toContain("reconnect_required");
  } finally {
    log.mockRestore();
    vi.unstubAllEnvs();
  }
});
