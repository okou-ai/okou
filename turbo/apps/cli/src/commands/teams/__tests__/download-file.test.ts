import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { downloadFileCommand } from "../download-file";

const DOWNLOAD_URL =
  "http://localhost:3000/api/integrations/teams/download-file";

describe("okou teams download-file", () => {
  vi.spyOn(process, "exit").mockImplementation(() => {
    throw new Error("process.exit called");
  });
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  let directory: string;
  beforeEach(() => {
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("OKOU_TOKEN", "test-token");
    directory = mkdtempSync(join(tmpdir(), "teams-download-test-"));
  });
  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it.each(["provider bytes", "signed URL"])(
    "saves the API-selected %s transport",
    async (transport) => {
      const outPath = join(directory, "result.txt");
      const target = "https://contoso.sharepoint.com/download?sig=single-file";
      server.use(
        http.get(DOWNLOAD_URL, ({ request }) => {
          expect(new URL(request.url).searchParams.get("file_id")).toBe(
            "teams-file-id",
          );
          expect(request.headers.get("authorization")).toBe(
            "Bearer test-token",
          );
          return transport === "signed URL"
            ? new HttpResponse(null, {
                status: 302,
                headers: { location: target, "x-file-mimetype": "text/plain" },
              })
            : new HttpResponse("hello teams", {
                headers: {
                  "content-type": "text/plain",
                  "content-length": "11",
                },
              });
        }),
        http.get(target, () => {
          return new HttpResponse("hello teams", {
            headers: { "content-type": "text/plain", "content-length": "11" },
          });
        }),
      );
      await downloadFileCommand.parseAsync([
        "node",
        "okou",
        "teams-file-id",
        "-o",
        outPath,
      ]);
      expect(readFileSync(outPath, "utf8")).toBe("hello teams");
      expect(JSON.parse(output.mock.calls.flat().join("\n"))).toEqual({
        path: outPath,
        mimetype: "text/plain",
        size: 11,
      });
    },
  );
});
