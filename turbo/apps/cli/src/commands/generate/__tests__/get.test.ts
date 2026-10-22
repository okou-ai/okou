import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { generateCommand } from "../index";
import { getGenerationCommand } from "../get";

const generationId = "00000000-0000-4000-8000-000000000001";
const statusUrl = `http://localhost:3000/api/built-in-generations/${generationId}`;

describe("okou generate get", () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "okou-generation-"));
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("OKOU_TOKEN", "test-token");
    getGenerationCommand.setOptionValue("out", undefined);
    getGenerationCommand.setOptionValue("json", undefined);
  });
  afterEach(() => {
    log.mockClear();
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  it.each(["queued", "running", "failed"])(
    "queries a %s job without needing the submitting process",
    async (status) => {
      const job = {
        generationId,
        type: "image",
        status,
        createdAt: "2026-05-15T00:00:00Z",
        startedAt: null,
        completedAt: null,
        ...(status === "failed"
          ? { error: { code: "GENERATION_FAILED", message: "Provider failed" } }
          : {}),
      };
      server.use(
        http.get(statusUrl, ({ request }) => {
          expect(request.headers.get("authorization")).toBe(
            "Bearer test-token",
          );
          return HttpResponse.json(job);
        }),
      );
      const out = join(dir, "image.png");
      await generateCommand.parseAsync([
        "node",
        "okou",
        "get",
        generationId,
        "--json",
        "--out",
        out,
      ]);
      expect(JSON.parse(log.mock.calls.flat().join("\n"))).toEqual(job);
      expect(existsSync(out)).toBe(false);
    },
  );

  it("downloads a completed image to the requested path", async () => {
    const job = {
      generationId,
      type: "image",
      status: "completed",
      result: { id: "image-file-id", url: "https://example.com/image.png" },
      createdAt: "2026-05-15T00:00:00Z",
      startedAt: "2026-05-15T00:00:01Z",
      completedAt: "2026-05-15T00:00:02Z",
    };
    server.use(
      http.get(statusUrl, () => {
        return HttpResponse.json(job);
      }),
      http.get("http://localhost:3000/api/web/download-file", ({ request }) => {
        expect(new URL(request.url).searchParams.get("file_id")).toBe(
          "image-file-id",
        );
        expect(request.headers.get("authorization")).toBe("Bearer test-token");
        return new HttpResponse("image bytes", {
          headers: { "Content-Type": "image/png" },
        });
      }),
    );
    const out = join(dir, "image.png");
    await generateCommand.parseAsync([
      "node",
      "okou",
      "get",
      generationId,
      "--json",
      "--out",
      out,
    ]);
    expect(readFileSync(out, "utf8")).toBe("image bytes");
    expect(JSON.parse(log.mock.calls.flat().join("\n"))).toMatchObject({
      ...job,
      download: { path: out, size: 11 },
    });
  });
});
