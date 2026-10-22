import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostedSitePrepareRequestSchema } from "@okouai/api-contracts/contracts/host";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { server } from "../../../mocks/server";
import { createHostCommand } from "../index";

const SITE_ID = "00000000-0000-4000-8000-000000000001";
const DEPLOYMENT_ID = "00000000-0000-4000-8000-000000000002";
const URL = "https://demo-site.okou.app";
const PREPARE_URL = "http://localhost:3000/api/host/deployments/prepare";

function runToken(enabled: boolean): string {
  const payload = Buffer.from(
    JSON.stringify({
      scope: "okou",
      capabilities: [
        "host:write",
        ...(enabled ? ["host-visibility:write"] : []),
      ],
    }),
  ).toString("base64url");
  return `vm0_sandbox_header.${payload}.signature`;
}

describe("okou host visibility", () => {
  let directory: string;
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);

  beforeEach(() => {
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("OKOU_TOKEN", runToken(true));
    directory = mkdtempSync(join(tmpdir(), "host-visibility-"));
    writeFileSync(join(directory, "index.html"), "<main>Private report</main>");
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
    vi.unstubAllEnvs();
    log.mockClear();
    error.mockClear();
  });

  function args(visibility?: string): string[] {
    return [
      "node",
      "okou",
      directory,
      "--site",
      "demo-site",
      "--title",
      "Demo site",
      "--json",
      ...(visibility === undefined ? [] : ["--visibility", visibility]),
    ];
  }

  it.each([true, false])(
    "shows visibility only with the run capability (enabled=%s)",
    async (enabled) => {
      vi.stubEnv("OKOU_TOKEN", runToken(enabled));
      let output = "";
      const command = createHostCommand()
        .exitOverride()
        .configureOutput({
          writeOut: (text) => {
            output += text;
          },
        });
      await expect(
        command.parseAsync(["node", "okou", "--help"]),
      ).rejects.toMatchObject({ code: "commander.helpDisplayed" });
      expect(output.includes("--visibility")).toBe(enabled);
      expect(output.includes("New hosted sites default to only-me")).toBe(
        enabled,
      );
      expect(output.includes("Hosted sites are public:")).toBe(!enabled);
    },
  );

  it("rejects an explicit visibility while the switch is off", async () => {
    vi.stubEnv("OKOU_TOKEN", runToken(false));
    await expect(
      createHostCommand().parseAsync(args("only-me")),
    ).rejects.toThrow("process.exit called");
    expect(error.mock.calls.flat().join("\n")).toContain(
      "requires hostedSiteVisibility to be enabled",
    );
    expect(log).not.toHaveBeenCalled();
  });

  it.each([
    [undefined, "private", "only-me"],
    ["only-me", "private", "only-me"],
    ["org", "organization", "org"],
    ["public", "public", "public"],
  ] as const)(
    "publishes with %s visibility after the API acknowledges %s",
    async (requested, audience, expected) => {
      const uploaded: string[] = [];
      server.use(
        http.post(PREPARE_URL, async ({ request }) => {
          const body = hostedSitePrepareRequestSchema.parse(
            await request.json(),
          );
          expect(body.visibility).toBe(
            requested === undefined ? undefined : audience,
          );
          return HttpResponse.json({
            siteId: SITE_ID,
            deploymentId: DEPLOYMENT_ID,
            title: "Demo site",
            publicSlug: "demo-site",
            url: URL,
            visibility: audience,
            uploads: body.files.map((file) => {
              return {
                path: file.path,
                uploadUrl: `https://uploads.example.com${file.path}`,
              };
            }),
          });
        }),
        http.put("https://uploads.example.com/*", ({ request }) => {
          uploaded.push(request.url);
          return new HttpResponse(null, { status: 200 });
        }),
        http.post(
          `http://localhost:3000/api/host/deployments/${DEPLOYMENT_ID}/complete`,
          () => {
            return HttpResponse.json({
              siteId: SITE_ID,
              deploymentId: DEPLOYMENT_ID,
              publicSlug: "demo-site",
              url: URL,
              status: "ready",
            });
          },
        ),
      );
      await createHostCommand().parseAsync(args(requested));
      expect(uploaded).toHaveLength(2);
      expect(JSON.parse(log.mock.calls.flat().join("\n"))).toMatchObject({
        url: URL,
        visibility: expected,
      });
    },
  );

  it.each([undefined, "public"])(
    "does not upload when a private request receives %s acknowledgement",
    async (visibility) => {
      let uploaded = false;
      server.use(
        http.post(PREPARE_URL, () => {
          return HttpResponse.json({
            siteId: SITE_ID,
            deploymentId: DEPLOYMENT_ID,
            title: "Demo site",
            publicSlug: "demo-site",
            url: URL,
            ...(visibility === undefined ? {} : { visibility }),
            uploads: [
              {
                path: "/index.html",
                uploadUrl: "https://uploads.example.com/index.html",
              },
            ],
          });
        }),
        http.put("https://uploads.example.com/*", () => {
          uploaded = true;
          return new HttpResponse(null, { status: 200 });
        }),
      );
      await expect(
        createHostCommand().parseAsync(args("only-me")),
      ).rejects.toThrow("process.exit called");
      expect(uploaded).toBe(false);
      expect(error.mock.calls.flat().join("\n")).toContain(
        "API did not acknowledge the site visibility",
      );
    },
  );

  it.each([undefined, "unexpected"])(
    "requires a valid acknowledgement for default-private runs (visibility=%s)",
    async (visibility) => {
      server.use(
        http.post(PREPARE_URL, () => {
          return HttpResponse.json({
            siteId: SITE_ID,
            deploymentId: DEPLOYMENT_ID,
            title: "Demo site",
            publicSlug: "demo-site",
            url: URL,
            uploads: [],
            ...(visibility === undefined ? {} : { visibility }),
          });
        }),
      );
      await expect(createHostCommand().parseAsync(args())).rejects.toThrow(
        "process.exit called",
      );
      expect(error.mock.calls.flat().join("\n")).toContain(
        "API did not acknowledge the site visibility",
      );
    },
  );
});
