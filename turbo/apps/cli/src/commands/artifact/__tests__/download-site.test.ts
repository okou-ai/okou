import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import chalk from "chalk";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { server } from "../../../mocks/server";
import { downloadFileCommand } from "../../web/download-file";
import { hostCommand } from "../../host";
import { artifactCommand } from "..";

const API = "http://localhost:3000";
const STORAGE_URL = "https://storage.example.com/shared-snapshot";
const REFERENCE = "/artifacts/abcxyz1234.html";
const CONTENTS = [
  {
    path: "/index.html",
    contentType: "text/html",
    bytes: Buffer.from(
      '<link rel="stylesheet" href="assets/site.css"><a href="pages/about.html">About</a>',
    ),
  },
  {
    path: "/pages/about.html",
    contentType: "text/html",
    bytes: Buffer.from('<script src="../assets/app.js"></script>About'),
  },
  {
    path: "/assets/site.css",
    contentType: "text/css",
    bytes: Buffer.from("body { color: navy; }"),
  },
  {
    path: "/assets/app.js",
    contentType: "application/javascript",
    bytes: Buffer.from("console.log('shared version');"),
  },
  {
    path: "/assets/logo.png",
    contentType: "image/png",
    bytes: Buffer.from([137, 80, 78, 71, 0, 255]),
  },
];

function siteResponse() {
  return {
    kind: "html" as const,
    site: {
      siteId: "00000000-0000-4000-8000-000000000001",
      deploymentId: "00000000-0000-4000-8000-000000000002",
      publicSlug: "shared-site-demo",
      url: "https://shared-site-demo.sites.example.com",
      artifactUrl: REFERENCE,
      deploymentVersion: 2,
      fileCount: CONTENTS.length,
      size: CONTENTS.reduce((total, file) => {
        return total + file.bytes.length;
      }, 0),
      files: CONTENTS.map((file) => {
        return {
          path: file.path,
          contentType: file.contentType,
          size: file.bytes.length,
          sha256: createHash("sha256").update(file.bytes).digest("hex"),
          downloadUrl: `${STORAGE_URL}${file.path}?signature=temporary`,
        };
      }),
    },
  };
}

describe.each([
  {
    name: "artifact download",
    command: artifactCommand,
    prefix: ["download"],
    clone: false,
  },
  {
    name: "web download-file",
    command: downloadFileCommand,
    prefix: [],
    clone: false,
  },
  { name: "host clone", command: hostCommand, prefix: ["clone"], clone: true },
])("okou $name hosted sites", ({ command, prefix, clone }) => {
  const downloadUrl = `${API}/api/artifact-references/:reference/${clone ? "files" : "download"}`;
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const exit = vi.spyOn(process, "exit").mockImplementation(() => {
    throw new Error("process.exit called");
  });
  let directory: string;
  let destination: string;

  const invoke = (source = REFERENCE) => {
    return command.parseAsync([
      "node",
      "okou",
      ...prefix,
      source,
      ...(clone ? [destination, "--json"] : ["--out", destination]),
    ]);
  };

  beforeEach(() => {
    chalk.level = 0;
    vi.stubEnv("OKOU_API_BACKEND_URL", API);
    vi.stubEnv("OKOU_APP_URL", "https://app.okou.ai");
    vi.stubEnv("OKOU_TOKEN", "viewer-token");
    directory = mkdtempSync(join(tmpdir(), "artifact-site-download-"));
    destination = join(directory, "site");
    server.use(
      http.get(downloadUrl, ({ request }) => {
        expect(request.headers.get("authorization")).toBe(
          "Bearer viewer-token",
        );
        const body = siteResponse();
        return HttpResponse.json(clone ? body.site : body);
      }),
      ...CONTENTS.map((file) => {
        return http.get(`${STORAGE_URL}${file.path}`, ({ request }) => {
          expect(request.headers.get("authorization")).toBeNull();
          return new HttpResponse(file.bytes);
        });
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    output.mockClear();
    errors.mockClear();
    exit.mockClear();
    rmSync(directory, { recursive: true, force: true });
  });

  it.each([REFERENCE, `https://app.okou.ai${REFERENCE}#page-2`])(
    "downloads all visible pages and binary assets from %s with their directory structure",
    async (source) => {
      await invoke(source);
      for (const file of CONTENTS) {
        expect(readFileSync(join(destination, file.path.slice(1)))).toEqual(
          file.bytes,
        );
      }
      const result: unknown = JSON.parse(output.mock.calls.flat().join("\n"));
      expect(result).toMatchObject({
        [clone ? "destination" : "path"]: destination,
        fileCount: CONTENTS.length,
        size: siteResponse().site.size,
        ...(clone
          ? { deploymentId: siteResponse().site.deploymentId }
          : { entrypoint: join(destination, "index.html") }),
      });
    },
  );

  it("preserves an existing destination instead of overwriting its files", async () => {
    mkdirSync(destination);
    writeFileSync(join(destination, "index.html"), "existing work");
    await expect(invoke()).rejects.toThrow("process.exit called");
    expect(errors).toHaveBeenCalledWith(
      expect.stringContaining("is not empty"),
    );
    expect(readFileSync(join(destination, "index.html"), "utf8")).toBe(
      "existing work",
    );
    expect(output).not.toHaveBeenCalled();
  });

  it.each([
    "/../outside.txt",
    "/assets/../../outside.txt",
    "//outside.txt",
    "/assets\\outside.txt",
  ])(
    "rejects an unsafe manifest path %s before writing site files",
    async (path) => {
      server.use(
        http.get(downloadUrl, () => {
          const body = siteResponse();
          body.site.files[1]!.path = path;
          return HttpResponse.json(clone ? body.site : body);
        }),
      );
      await expect(invoke()).rejects.toThrow("process.exit called");
      expect(errors).toHaveBeenCalledWith(
        expect.stringContaining("Invalid hosted-site path"),
      );
      expect(existsSync(destination)).toBe(false);
      expect(existsSync(join(directory, "outside.txt"))).toBe(false);
    },
  );

  it.each([
    { name: "size", body: "truncated", message: "Downloaded size mismatch" },
    {
      name: "hash",
      body: Buffer.alloc(CONTENTS[0]!.bytes.length, 120),
      message: "Downloaded hash mismatch",
    },
  ])(
    "rejects corrupt site files with a $name mismatch",
    async ({ body, message }) => {
      server.use(
        http.get(`${STORAGE_URL}/index.html`, () => {
          return new HttpResponse(body);
        }),
      );
      await expect(invoke()).rejects.toThrow("process.exit called");
      expect(errors).toHaveBeenCalledWith(expect.stringContaining(message));
      expect(existsSync(join(destination, "index.html"))).toBe(false);
      expect(output).not.toHaveBeenCalled();
    },
  );
});
