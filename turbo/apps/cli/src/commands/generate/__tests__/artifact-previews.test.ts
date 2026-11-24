import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { server } from "../../../mocks/server";
import { createGenerateCommand } from "../index";

const generateCommand = createGenerateCommand();

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

describe("artifact cover guidance in generation instructions", () => {
  const logs = vi.spyOn(console, "log").mockImplementation(() => {});

  beforeEach(() => {
    vi.stubEnv("OKOU_TOKEN", "test-token");
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    server.use(
      http.get("http://localhost:3000/api/feature-switches", ({ request }) => {
        expect(request.headers.get("authorization")).toBe("Bearer test-token");
        return HttpResponse.json({
          switches: {},
          effectiveSwitches: {
            [FeatureSwitchKey.PresentationOutputFormat]: false,
          },
        });
      }),
    );
    for (const command of generateCommand.commands) {
      for (const option of command.options) {
        command.setOptionValue(option.attributeName(), option.defaultValue);
      }
    }
  });
  afterEach(() => {
    logs.mockClear();
    vi.unstubAllEnvs();
  });

  it.each(variants)(
    "includes %s capture and publish instructions (%j)",
    async (kind, args) => {
      await generateCommand.parseAsync([
        "node",
        "okou",
        kind,
        "--prompt",
        "Quarterly plan",
        ...args,
      ]);
      const output = logs.mock.calls.flat().join("\n");
      expect(output).toContain("okou host screenshot");
      expect(output).toContain(" --preview ");
      expect(output).toContain("previewImageUrl");
      expect(output).toContain("file-only deliverable");
      expect(output).toContain("okou host ");
    },
  );
});
