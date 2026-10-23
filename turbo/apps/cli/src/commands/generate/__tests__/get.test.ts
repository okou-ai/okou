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
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const exit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "okou-generation-"));
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("OKOU_TOKEN", "test-token");
    getGenerationCommand.setOptionValue("out", undefined);
    getGenerationCommand.setOptionValue("json", undefined);
    getGenerationCommand.setOptionValue("refresh", undefined);
  });
  afterEach(() => {
    log.mockClear();
    error.mockClear();
    exit.mockClear();
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
      let refreshes = 0;
      server.use(
        http.post(`${statusUrl}/reconcile`, () => {
          refreshes++;
          return HttpResponse.json(job);
        }),
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
      expect(refreshes).toBe(0);
    },
  );

  it.each(["queued", "running", "completed", "failed"])(
    "refreshes a %s job once before querying, without resubmission",
    async (status) => {
      const calls: string[] = [];
      const job = { generationId, type: "image", status };
      server.use(
        http.post(`${statusUrl}/reconcile`, async ({ request }) => {
          expect(request.headers.get("authorization")).toBe(
            "Bearer test-token",
          );
          expect(await request.json()).toEqual({});
          calls.push("refresh");
          return HttpResponse.json(job);
        }),
        http.get(statusUrl, () => {
          calls.push("get");
          return HttpResponse.json(job);
        }),
      );
      await generateCommand.parseAsync([
        "node",
        "okou",
        "get",
        generationId,
        "--refresh",
        "--json",
      ]);
      expect(calls).toEqual(["refresh", "get"]);
      expect(JSON.parse(log.mock.calls.flat().join("\n"))).toEqual(job);
    },
  );

  it.each([404, 503])(
    "does not retry or query after a refresh %s failure",
    async (status) => {
      let refreshes = 0;
      let queries = 0;
      server.use(
        http.post(`${statusUrl}/reconcile`, () => {
          refreshes++;
          return HttpResponse.json(
            { error: { code: "UNAVAILABLE", message: "Refresh unavailable" } },
            { status },
          );
        }),
        http.get(statusUrl, () => {
          queries++;
          return HttpResponse.json({});
        }),
      );
      await expect(
        generateCommand.parseAsync([
          "node",
          "okou",
          "get",
          generationId,
          "--refresh",
          "--json",
        ]),
      ).rejects.toThrow("process.exit called");
      expect(refreshes).toBe(1);
      expect(queries).toBe(0);
      expect(error.mock.calls.flat().join("\n")).toContain(
        "Refresh unavailable",
      );
    },
  );

  it("preserves a completed image artifact reference through authorization and direct delivery", async () => {
    vi.stubEnv("OKOU_APP_URL", "https://app.okou.ai");
    const job = {
      generationId,
      type: "image",
      status: "completed",
      result: { id: "image-file-id", url: "/artifacts/imagehash1.png" },
    };
    server.use(
      http.get(statusUrl, () => {
        return HttpResponse.json(job);
      }),
      http.get(
        "http://localhost:3000/api/artifact-references/imagehash1.png/download",
        ({ request }) => {
          expect(request.headers.get("authorization")).toBe(
            "Bearer test-token",
          );
          return HttpResponse.json({
            kind: "file",
            url: "https://delivery.example.com/generated.png?sig=private",
            filename: "image.png",
            contentType: "image/png",
          });
        },
      ),
      http.get("https://delivery.example.com/generated.png", ({ request }) => {
        expect(request.headers.get("authorization")).toBeNull();
        return new HttpResponse("image bytes", {
          headers: { "content-type": "image/png", "content-length": "11" },
        });
      }),
    );
    const out = join(dir, "artifact.png");
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
      http.get("http://localhost:3000/api/web/file-url", () => {
        return HttpResponse.json({ error: "Not found" }, { status: 404 });
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
