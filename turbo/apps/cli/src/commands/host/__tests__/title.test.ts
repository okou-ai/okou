import chalk from "chalk";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { server } from "../../../mocks/server";
import { hostCommand } from "../index";

describe("okou host title", () => {
  const logs = vi.spyOn(console, "log").mockImplementation(() => {});

  beforeEach(() => {
    chalk.level = 0;
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("OKOU_TOKEN", "test-token");
    hostCommand.setOptionValue("json", undefined);
    hostCommand.commands
      .find((cmd) => {
        return cmd.name() === "title";
      })
      ?.setOptionValue("json", undefined);
  });

  afterEach(() => {
    logs.mockClear();
    vi.unstubAllEnvs();
  });

  it.each(["demo-site", "https://demo-site.okou.app/"])(
    "renames %s without publishing or changing its address",
    async (site) => {
      server.use(
        http.patch(
          "http://localhost:3000/api/host/sites/demo-site/title",
          async ({ request }) => {
            expect(request.headers.get("authorization")).toBe(
              "Bearer test-token",
            );
            await expect(request.json()).resolves.toStrictEqual({
              title: "季度销售报告",
            });
            return HttpResponse.json({
              siteId: "00000000-0000-4000-8000-000000000001",
              publicSlug: "demo-site",
              title: "季度销售报告",
            });
          },
        ),
      );
      await hostCommand.parseAsync([
        "node",
        "okou",
        "title",
        site,
        "  季度销售报告  ",
        "--json",
      ]);
      expect(JSON.parse(logs.mock.calls.flat().join("\n"))).toMatchObject({
        publicSlug: "demo-site",
        title: "季度销售报告",
      });
    },
  );
});
