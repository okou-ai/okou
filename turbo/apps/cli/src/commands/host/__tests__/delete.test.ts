import chalk from "chalk";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { server } from "../../../mocks/server";
import { hostCommand } from "../index";

const SITE_URL = "http://localhost:3000/api/host/sites/:publicSlug";
const ALIAS_URL = "https://demo-site.sites.example.com";
const VERSION_URL =
  "https://dpl-00000000-0000-4000-8000-000000000002.sites.example.com";

describe("okou host delete command", () => {
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});
  const mockExit = vi.spyOn(process, "exit").mockImplementation(() => {
    throw new Error("process.exit called");
  });
  const deletedSlugs: string[] = [];

  beforeEach(() => {
    chalk.level = 0;
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("OKOU_TOKEN", "test-token");
    deletedSlugs.length = 0;
    server.use(
      http.delete(SITE_URL, ({ params, request }) => {
        expect(request.headers.get("authorization")).toBe("Bearer test-token");
        deletedSlugs.push(String(params.publicSlug));
        return HttpResponse.json({
          siteId: "00000000-0000-4000-8000-000000000001",
          site: "demo-site",
          publicSlug: "demo-site",
          aliasUrl: ALIAS_URL,
          offlineUrls: [ALIAS_URL, VERSION_URL],
        });
      }),
    );
  });

  afterEach(() => {
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    mockExit.mockClear();
    vi.unstubAllEnvs();
  });

  it.each([
    ["demo-site", "demo-site"],
    ["https://demo-site.sites.example.com/", "demo-site"],
    // Only dpl-<uuid> is a version address; other dpl- names are sites.
    ["dpl-report", "dpl-report"],
  ])("deletes the site named by %s", async (input, slug) => {
    await hostCommand.parseAsync(["node", "cli", "delete", input, "--json"]);

    expect(deletedSlugs).toStrictEqual([slug]);
    const stdout = mockConsoleLog.mock.calls.flat().join("\n");
    expect(JSON.parse(stdout)).toMatchObject({
      publicSlug: "demo-site",
      offlineUrls: [ALIAS_URL, VERSION_URL],
    });
  });

  it("lists the offline URLs and how to restore the site", async () => {
    await hostCommand.parseAsync(["node", "cli", "delete", "demo-site"]);

    const stdout = mockConsoleLog.mock.calls.flat().join("\n");
    expect(stdout).toContain("Hosted site deleted: demo-site");
    expect(stdout).toContain(`Offline: ${ALIAS_URL}`);
    expect(stdout).toContain(`Offline: ${VERSION_URL}`);
    expect(stdout).toContain("okou host <dir> --site demo-site");
  });

  it("rejects a version URL instead of deleting its whole site", async () => {
    await expect(
      hostCommand.parseAsync(["node", "cli", "delete", VERSION_URL]),
    ).rejects.toThrow("process.exit called");

    expect(deletedSlugs).toStrictEqual([]);
    expect(mockConsoleError.mock.calls.flat().join("\n")).toContain(
      "not a version URL",
    );
  });
});
