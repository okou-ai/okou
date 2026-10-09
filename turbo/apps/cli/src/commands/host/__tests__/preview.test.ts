import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { http, HttpResponse } from "msw";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hostedSitePrepareRequestSchema } from "@okouai/api-contracts/contracts/host";

import { server } from "../../../mocks/server";
import { hostCommand } from "../index";
import { screenshotHostedSiteCommand } from "../screenshot";
import { completeHostedSiteCommand } from "../complete";

const deploymentId = "00000000-0000-4000-8000-000000000002";
const previewImageUrl = "https://app.okou.ai/artifacts/abc123abcd.png";
const completed = {
  siteId: "00000000-0000-4000-8000-000000000001",
  deploymentId,
  publicSlug: "preview-demo",
  url: "https://preview-demo.okou.app",
  status: "ready",
  previewImageUrl,
};
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRZkAAAAASUVORK5CYII=",
  "base64",
);

describe("hosted artifact previews", () => {
  let root: string;
  let site: string;
  let cover: string;
  const logs = vi.spyOn(console, "log").mockImplementation(() => {});
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation(() => {
    throw new Error("process.exit");
  });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "host-preview-"));
    site = join(root, "site");
    cover = join(root, "cover.png");
    mkdirSync(site);
    copyFileSync(
      new URL("./fixtures/preview.html", import.meta.url),
      join(site, "index.html"),
    );
    writeFileSync(join(site, "app-12345678.js"), 'console.log("bundle asset")');
    writeFileSync(cover, png);
    for (const command of [
      hostCommand,
      screenshotHostedSiteCommand,
      completeHostedSiteCommand,
    ]) {
      for (const option of command.options)
        command.setOptionValue(option.attributeName(), undefined);
    }
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("OKOU_TOKEN", "test-token");
    server.use(
      http.get("*/api/feature-switches", () => {
        return HttpResponse.json({
          switches: {},
          effectiveSwitches: { artifactPreviews: true },
        });
      }),
    );
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    logs.mockClear();
    errors.mockClear();
    vi.unstubAllEnvs();
  });

  function publish() {
    return hostCommand.parseAsync([
      "node",
      "okou",
      site,
      "--site",
      "preview-demo",
      "--preview",
      cover,
      "--json",
    ]);
  }

  it("silently skips capture and ignores the cover when previews are disabled", async () => {
    server.use(
      http.get("*/api/feature-switches", () => {
        return HttpResponse.json({
          switches: {},
          effectiveSwitches: { artifactPreviews: false },
        });
      }),
    );
    const original = readFileSync(cover);
    await screenshotHostedSiteCommand.parseAsync([
      "node",
      "okou",
      join(root, "missing-site"),
      "--out",
      cover,
    ]);
    expect(logs.mock.calls).toHaveLength(0);
    expect(readFileSync(cover)).toEqual(original);
    expect(existsSync(`${cover}.okou-preview.json`)).toBe(false);
    cover = join(root, "missing-cover.png");
    server.use(
      http.post("*/api/host/deployments/prepare", async ({ request }) => {
        const body = hostedSitePrepareRequestSchema.parse(await request.json());
        expect(body.preview).toBeUndefined();
        return HttpResponse.json({
          ...completed,
          uploads: body.files.map((file) => {
            return {
              path: file.path,
              uploadUrl: `https://upload.example${file.path}`,
            };
          }),
        });
      }),
      http.put("https://upload.example/*", () => {
        return new HttpResponse(null, { status: 200 });
      }),
      http.post(`*/api/host/deployments/${deploymentId}/complete`, () => {
        return HttpResponse.json({ ...completed, previewImageUrl: undefined });
      }),
    );
    await publish();
    expect(JSON.parse(logs.mock.calls.flat().join("\n"))).toMatchObject({
      deploymentId,
    });
    expect(errors.mock.calls).toHaveLength(0);
  });

  it.each(["prepare", "complete"])(
    "publishes without a cover when the switch is disabled before %s",
    async (phase) => {
      let uploadedPreview = false;
      server.use(
        http.post("*/api/host/deployments/prepare", async ({ request }) => {
          const body = hostedSitePrepareRequestSchema.parse(
            await request.json(),
          );
          expect(body.preview).toBeDefined();
          return HttpResponse.json({
            ...completed,
            uploads: body.files.map((file) => {
              return {
                path: file.path,
                uploadUrl: `https://upload.example${file.path}`,
              };
            }),
            ...(phase === "prepare"
              ? { previewSkipped: true }
              : {
                  preview: {
                    uploadUrl: "https://private-upload.example/cover",
                    sha256: body.preview?.sha256,
                  },
                }),
          });
        }),
        http.put("https://upload.example/*", () => {
          return new HttpResponse(null, { status: 200 });
        }),
        http.put("https://private-upload.example/cover", () => {
          uploadedPreview = true;
          return new HttpResponse(null, { status: 200 });
        }),
        http.post(`*/api/host/deployments/${deploymentId}/complete`, () => {
          expect(uploadedPreview).toBe(phase === "complete");
          return HttpResponse.json({
            ...completed,
            previewImageUrl: undefined,
            ...(phase === "complete" ? { previewSkipped: true } : {}),
          });
        }),
      );
      await publish();
      const result: unknown = JSON.parse(logs.mock.calls.flat().join("\n"));
      expect(result).toMatchObject({ deploymentId });
      expect(result).not.toHaveProperty("previewImageUrl");
      expect(errors.mock.calls).toHaveLength(0);
    },
  );

  it("uploads a cover separately from public files and exposes the registered image", async () => {
    let uploadedPreview = false;
    server.use(
      http.post(
        "http://localhost:3000/api/host/deployments/prepare",
        async ({ request }) => {
          const body = hostedSitePrepareRequestSchema.parse(
            await request.json(),
          );
          expect(body.preview).toEqual({
            size: png.length,
            contentType: "image/png",
            sha256: createHash("sha256").update(png).digest("hex"),
          });
          expect(
            body.files.map((file) => {
              return file.path;
            }),
          ).not.toContain("/cover.png");
          return HttpResponse.json({
            ...completed,
            uploads: body.files.map((file) => {
              return {
                path: file.path,
                uploadUrl: `https://upload.example${file.path}`,
              };
            }),
            preview: {
              uploadUrl: "https://private-upload.example/cover",
              sha256: body.preview?.sha256,
            },
          });
        },
      ),
      http.put("https://upload.example/*", () => {
        return new HttpResponse(null, { status: 200 });
      }),
      http.put("https://private-upload.example/cover", async ({ request }) => {
        expect(Buffer.from(await request.arrayBuffer())).toEqual(png);
        uploadedPreview = true;
        return new HttpResponse(null, { status: 200 });
      }),
      http.post(
        `http://localhost:3000/api/host/deployments/${deploymentId}/complete`,
        () => {
          expect(uploadedPreview).toBe(true);
          return HttpResponse.json(completed);
        },
      ),
    );
    await publish();
    expect(JSON.parse(logs.mock.calls.flat().join("\n"))).toMatchObject({
      deploymentId,
      previewImageUrl,
    });
  });

  it("fails before upload when an old API ignores the preview request", async () => {
    server.use(
      http.post("http://localhost:3000/api/host/deployments/prepare", () => {
        return HttpResponse.json({ ...completed, uploads: [] });
      }),
    );
    await expect(publish()).rejects.toThrow("process.exit");
    expect(errors.mock.calls.flat().join("\n")).toContain(
      "did not acknowledge",
    );
    expect(logs.mock.calls).toHaveLength(0);
  });

  it("keeps a cover inside the public bundle from being accidentally published", async () => {
    cover = join(site, "cover-12345678.png");
    writeFileSync(cover, png);
    await expect(publish()).rejects.toThrow("process.exit");
    expect(errors.mock.calls.flat().join("\n")).toContain(
      "outside the hosted directory",
    );
  });

  it("retries completion using the same deployment identity", async () => {
    server.use(
      http.post(
        `http://localhost:3000/api/host/deployments/${deploymentId}/complete`,
        () => {
          return HttpResponse.json(completed);
        },
      ),
    );
    await new Command("okou")
      .addCommand(hostCommand)
      .parseAsync(["node", "okou", "host", "complete", deploymentId, "--json"]);
    expect(JSON.parse(logs.mock.calls.flat().join("\n"))).toMatchObject({
      deploymentId,
      previewImageUrl,
    });
  });

  function installBrowser() {
    const binary = join(root, "agent-browser");
    // The browser is the external process boundary; command, server and files stay real.
    writeFileSync(
      binary,
      `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(4);
(async () => {
  if (!process.env.AGENT_BROWSER_CONFIG || fs.readFileSync(process.env.AGENT_BROWSER_CONFIG, "utf8") !== "{}") throw new Error("Capture must ignore owner browser configuration");
  if (process.env.AGENT_BROWSER_PROFILE || process.env.AGENT_BROWSER_CDP || process.env.AGENT_BROWSER_STATE) throw new Error("Capture inherited browser authentication");
  if (args[0] === "set" && args[1] === "viewport") {
    fs.writeFileSync(path.join(process.env.OKOU_TEST_PREVIEW_DIR, "viewport.json"), JSON.stringify(args.slice(2).map(Number)));
  }
  if (args[0] === "open") {
    const url = new URL(args[1]);
    const html = await (await fetch(url)).text();
    const asset = await (await fetch(new URL("/app-12345678.js", url))).text();
    fs.writeFileSync(path.join(process.env.OKOU_TEST_PREVIEW_DIR, "observed.json"), JSON.stringify({ html, asset, protocol: url.protocol }));
  }
  if (args[0] === "eval" && process.env.OKOU_TEST_PREVIEW_FAIL === "1") throw new Error("Image did not become ready");
  if (args[0] === "screenshot") {
    const [width, height] = JSON.parse(fs.readFileSync(path.join(process.env.OKOU_TEST_PREVIEW_DIR, "viewport.json"), "utf8"));
    const image = Buffer.alloc(32); Buffer.from([137,80,78,71,13,10,26,10]).copy(image); image.writeUInt32BE(width, 16); image.writeUInt32BE(height, 20); fs.writeFileSync(args[1], image);
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
`,
    );
    chmodSync(binary, 0o755);
    vi.stubEnv("PATH", `${root}:${process.env.PATH}`);
    vi.stubEnv("OKOU_TEST_PREVIEW_DIR", root);
  }

  it("captures served bundle bytes and refuses publishing a stale screenshot", async () => {
    installBrowser();
    vi.stubEnv("AGENT_BROWSER_PROFILE", "/owner/browser-profile");
    vi.stubEnv("AGENT_BROWSER_CDP", "http://owner-browser.invalid");
    vi.stubEnv("AGENT_BROWSER_STATE", "/owner/browser-state.json");
    await new Command("okou")
      .addCommand(hostCommand)
      .parseAsync([
        "node",
        "okou",
        "host",
        "screenshot",
        site,
        "--out",
        cover,
        "--json",
      ]);
    expect(
      JSON.parse(readFileSync(join(root, "observed.json"), "utf8")),
    ).toMatchObject({
      protocol: "http:",
      html: expect.stringContaining("Final bundle"),
      asset: 'console.log("bundle asset")',
    });
    expect(existsSync(`${cover}.okou-preview.json`)).toBe(true);
    expect(JSON.parse(logs.mock.calls.flat().join("\n"))).toMatchObject({
      path: cover,
      width: 1280,
      height: 800,
    });
    writeFileSync(
      join(site, "index.html"),
      "<main>Changed after capture</main>",
    );
    await expect(publish()).rejects.toThrow("process.exit");
    expect(errors.mock.calls.flat().join("\n")).toContain(
      "changed after capture",
    );
  });

  it("reports capture failure and leaves no usable screenshot or receipt", async () => {
    installBrowser();
    vi.stubEnv("OKOU_TEST_PREVIEW_FAIL", "1");
    await expect(
      screenshotHostedSiteCommand.parseAsync([
        "node",
        "okou",
        site,
        "--out",
        cover,
      ]),
    ).rejects.toThrow("process.exit");
    expect(existsSync(cover)).toBe(false);
    expect(existsSync(`${cover}.okou-preview.json`)).toBe(false);
    expect(errors.mock.calls.flat().join("\n")).toContain(
      "Image did not become ready",
    );
  });
});
