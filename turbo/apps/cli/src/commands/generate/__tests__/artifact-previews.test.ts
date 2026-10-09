import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { generateCommand } from "../index";

const variants = [
  ["website", []],
  ["report", []],
  ["poster", []],
  ["dashboard-design", []],
  ["mobile-app-design", []],
  ["docs-design", []],
  ["presentation", []],
  ["presentation", ["--template", "html-ppt-playful-launch"]],
] as const;

describe("artifact preview rollout in generation instructions", () => {
  const logs = vi.spyOn(console, "log").mockImplementation(() => {});
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation(() => {
    throw new Error("process.exit");
  });

  beforeEach(() => {
    vi.stubEnv("OKOU_TOKEN", "test-token");
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    for (const command of generateCommand.commands) {
      for (const option of command.options) {
        command.setOptionValue(option.attributeName(), option.defaultValue);
      }
    }
  });
  afterEach(() => {
    logs.mockClear();
    errors.mockClear();
    vi.unstubAllEnvs();
  });

  it.each(variants)(
    "gates %s capture and publish instructions together (%j)",
    async (kind, args) => {
      for (const enabled of [false, true, false]) {
        server.use(
          http.get("*/api/feature-switches", () => {
            return HttpResponse.json({
              switches: { artifactPreviews: enabled },
              effectiveSwitches: { artifactPreviews: enabled },
            });
          }),
        );
        logs.mockClear();
        await generateCommand.parseAsync([
          "node",
          "okou",
          kind,
          "--prompt",
          "Quarterly plan",
          ...args,
        ]);
        const output = logs.mock.calls.flat().join("\n");
        expect(output.includes("okou host screenshot")).toBe(enabled);
        expect(output.includes(" --preview ")).toBe(enabled);
        expect(output).toContain("okou host ");
      }
    },
  );

  it("surfaces availability failures instead of silently selecting a rollout", async () => {
    server.use(
      http.get("*/api/feature-switches", () => {
        return HttpResponse.json(
          {
            error: {
              code: "UNAVAILABLE",
              message: "Feature state unavailable",
            },
          },
          { status: 500 },
        );
      }),
    );
    await expect(
      generateCommand.parseAsync([
        "node",
        "okou",
        "website",
        "--prompt",
        "Quarterly plan",
      ]),
    ).rejects.toThrow("process.exit");
    expect(errors.mock.calls.flat().join("\n")).toContain(
      "Feature state unavailable",
    );
    expect(logs.mock.calls.flat().join("\n")).not.toContain(
      "okou host screenshot",
    );
  });
});
