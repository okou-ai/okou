import chalk from "chalk";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { server } from "../../../mocks/server";
import { createHostCommand } from "../index";

const siteId = "00000000-0000-4000-8000-000000000001";
const deploymentId = "00000000-0000-4000-8000-000000000002";
const base = "http://localhost:3000/api/host";
const brandingUrl = `${base}/sites/${siteId}/branding`;

function runToken(enabled: boolean) {
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

describe("okou host banner", () => {
  const logs = vi.spyOn(console, "log").mockImplementation(() => {});
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation(() => {
    throw new Error("process.exit called");
  });

  beforeEach(() => {
    chalk.level = 0;
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("OKOU_TOKEN", runToken(true));
    server.use(
      http.get(`${base}/aliases/demo-site`, ({ request }) => {
        expect(new URL(request.url).searchParams.get("publicBrand")).toBe(
          "okou",
        );
        return HttpResponse.json({
          pointer: {
            version: 1,
            publicBrand: "okou",
            publicSlug: "demo-site",
            siteId,
            deploymentId,
            prefix: `sites/brands/okou/publications/${deploymentId}`,
            manifestKey: `sites/brands/okou/publications/${deploymentId}/manifest.json`,
            spaFallback: false,
            updatedAt: "2026-10-23T00:00:00Z",
          },
        });
      }),
    );
  });

  afterEach(() => {
    logs.mockClear();
    errors.mockClear();
    vi.unstubAllEnvs();
  });

  it.each([true, false])(
    "exposes banner help only to enabled runs (enabled=%s)",
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
      expect(output.includes("banner")).toBe(enabled);
    },
  );

  it("keeps direct subcommand help free of banner features when disabled", async () => {
    vi.stubEnv("OKOU_TOKEN", runToken(false));
    let output = "";
    const command = createHostCommand()
      .exitOverride()
      .configureOutput({
        writeOut: (text) => {
          output += text;
        },
      });
    await expect(
      command.parseAsync(["node", "okou", "banner", "--help"]),
    ).rejects.toMatchObject({ code: "commander.helpDisplayed" });
    expect(output).toContain("Publish, redeploy");
    expect(output).not.toContain("banner");
  });

  it("does not register banner changes in disabled runs", async () => {
    vi.stubEnv("OKOU_TOKEN", runToken(false));
    let output = "";
    const command = createHostCommand()
      .exitOverride()
      .configureOutput({
        writeErr: (text) => {
          output += text;
        },
      });
    await expect(
      command.parseAsync(["node", "okou", "banner", "demo-site", "off"]),
    ).rejects.toMatchObject({ code: "commander.excessArguments" });
    expect(output).toContain("too many arguments");
    expect(logs.mock.calls).toHaveLength(0);
  });

  it("reads the default-on setting and prints the next action", async () => {
    server.use(
      http.get(brandingUrl, () => {
        return HttpResponse.json({ siteId, showBanner: true, revision: null });
      }),
    );
    await createHostCommand().parseAsync([
      "node",
      "okou",
      "banner",
      "demo-site",
    ]);
    const output = logs.mock.calls.flat().join("\n");
    expect(output).toContain("Okou banner: shown");
    expect(output).toContain("okou host banner demo-site off");
  });

  it.each(["on", "off"] as const)(
    "saves %s by Site revision and reads the persisted setting by URL",
    async (state) => {
      let saved = {
        siteId,
        showBanner: state !== "on",
        revision: null as string | null,
      };
      server.use(
        http.get(brandingUrl, ({ request }) => {
          expect(request.headers.get("authorization")).toBe(
            `Bearer ${runToken(true)}`,
          );
          return HttpResponse.json(saved);
        }),
        http.patch(brandingUrl, async ({ request }) => {
          await expect(request.json()).resolves.toStrictEqual({
            showBanner: state === "on",
            expectedRevision: saved.revision,
          });
          saved = {
            siteId,
            showBanner: state === "on",
            revision: crypto.randomUUID(),
          };
          return HttpResponse.json(saved);
        }),
      );
      await createHostCommand().parseAsync([
        "node",
        "okou",
        "--json",
        "banner",
        "demo-site",
        state,
      ]);
      expect(JSON.parse(logs.mock.calls.at(-1)![0] as string)).toStrictEqual({
        publicSlug: "demo-site",
        ...saved,
      });
      await createHostCommand().parseAsync([
        "node",
        "okou",
        "banner",
        "https://demo-site.okou.app/",
        "--json",
      ]);
      expect(JSON.parse(logs.mock.calls.at(-1)![0] as string)).toStrictEqual({
        publicSlug: "demo-site",
        siteId,
        showBanner: state === "on",
        revision: saved.revision,
      });
    },
  );

  it.each([
    {
      status: 403,
      code: "RESOURCE_UNAVAILABLE",
      message: "Website visibility management is not available",
      change: false,
    },
    {
      status: 404,
      code: "NOT_FOUND",
      message: "Published website not found",
      change: false,
    },
    {
      status: 409,
      code: "CONFLICT",
      message: "Website banner changed; reload before editing",
      change: true,
    },
  ])(
    "reports $status without claiming that a setting was saved",
    async ({ status, code, message, change }) => {
      server.use(
        http.get(brandingUrl, () => {
          return change
            ? HttpResponse.json({ siteId, showBanner: true, revision: null })
            : HttpResponse.json({ error: { code, message } }, { status });
        }),
        http.patch(brandingUrl, () => {
          return HttpResponse.json({ error: { code, message } }, { status });
        }),
      );
      await expect(
        createHostCommand().parseAsync([
          "node",
          "okou",
          "banner",
          "demo-site",
          "off",
          "--json",
        ]),
      ).rejects.toThrow("process.exit called");
      expect(errors.mock.calls.flat().join("\n")).toContain(message);
      expect(logs.mock.calls).toHaveLength(0);
    },
  );
});
