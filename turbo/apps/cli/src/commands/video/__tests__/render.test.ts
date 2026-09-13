import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  introVideoRenderRequestSchema,
  type IntroVideoRenderResponse,
} from "@okouai/api-contracts/contracts/intro-video-render";
import { server } from "../../../mocks/server";
import { renderCommand } from "../render";

const ID = "11111111-1111-4111-8111-111111111111";
const FILE_ID = "22222222-2222-4222-8222-222222222222";
const BASE = "http://localhost:3000/api/intro-video/renders";
const input = introVideoRenderRequestSchema.parse({
  requestId: ID,
  projectFileId: FILE_ID,
  composition: "index.html",
  output: {
    format: "mp4",
    resolution: "1080p",
    quality: "standard",
    fps: 30,
    aspectRatio: "16:9",
  },
});
const pending: IntroVideoRenderResponse = {
  generationId: ID,
  type: "video",
  status: "running",
  phase: "queued",
  providerRenderId: "hfr_test",
  input,
  recovery: { action: "poll", retryAfterSeconds: 10 },
  billing: { status: "pending", creditsCharged: null },
  result: null,
  createdAt: "2026-09-12T00:00:00.000Z",
  startedAt: "2026-09-12T00:00:01.000Z",
  completedAt: null,
};

describe("managed video render command", () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation(() => {
    throw new Error("process.exit called");
  });
  let dir: string;
  beforeEach(async () => {
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("OKOU_TOKEN", "test-run-token");
    for (const command of [renderCommand, ...renderCommand.commands]) {
      for (const option of command.options)
        command.setOptionValue(option.attributeName(), undefined);
    }
    dir = await mkdtemp(join(tmpdir(), "video-render-test-"));
    await writeFile(
      join(dir, "index.html"),
      '<html><div data-width="1920" data-height="1080">Original presentation</div></html>',
    );
  });
  afterEach(async () => {
    log.mockClear();
    errors.mockClear();
    await rm(dir, { recursive: true, force: true });
  });

  it("dry-runs without authentication, excluding old renders and honoring project ignore rules", async () => {
    vi.stubEnv("OKOU_TOKEN", "");
    await mkdir(join(dir, "renders"));
    await writeFile(join(dir, "renders", "old.mp4"), "old output");
    await writeFile(join(dir, "unused.bin"), "intermediate frames");
    await writeFile(join(dir, ".hyperframesignore"), "/unused.bin\n");
    await renderCommand.parseAsync([
      "node",
      "okou",
      dir,
      "--dry-run",
      "--json",
    ]);
    const result = JSON.parse(String(log.mock.calls[0]?.[0])) as {
      dryRun: boolean;
      fileCount: number;
      aspectRatio: string;
    };
    expect(result).toMatchObject({
      dryRun: true,
      fileCount: 1,
      aspectRatio: "16:9",
    });
    await expect(
      readFile(join(dir, ".okou", "cloud-render.json")),
    ).rejects.toThrow();
  });

  it("uploads through Okou and persists the original request before a failed submission", async () => {
    const submitted: unknown[] = [];
    server.use(
      http.post("http://localhost:3000/api/uploads/prepare", () => {
        return HttpResponse.json({
          id: FILE_ID,
          filename: "project.zip",
          contentType: "application/zip",
          size: 100,
          uploadUrl: "https://storage.okou.test/project",
          uploadHeaders: {},
          url: "https://a.okou.io/project.zip",
        });
      }),
      http.put("https://storage.okou.test/project", () => {
        return new HttpResponse(null, { status: 200 });
      }),
      http.post("http://localhost:3000/api/uploads/complete", () => {
        return HttpResponse.json({
          id: FILE_ID,
          filename: "project.zip",
          contentType: "application/zip",
          size: 100,
          url: "https://a.okou.io/project.zip",
        });
      }),
      http.post(BASE, async ({ request }) => {
        expect(request.headers.get("authorization")).toBe(
          "Bearer test-run-token",
        );
        expect(request.headers.has("x-api-key")).toBe(false);
        submitted.push(await request.json());
        return HttpResponse.json(
          {
            error: {
              code: "TEMPORARY_ERROR",
              message: "Submission response was interrupted",
            },
          },
          { status: 503 },
        );
      }),
    );
    await expect(
      renderCommand.parseAsync([
        "node",
        "okou",
        dir,
        "--request-id",
        ID,
        "--json",
      ]),
    ).rejects.toThrow();
    const saved = JSON.parse(
      await readFile(join(dir, ".okou", "cloud-render.json"), "utf8"),
    ) as { requestId: string; input: unknown };
    expect(saved.requestId).toBe(ID);
    expect(saved.input).toEqual(submitted[0]);
    expect(errors.mock.calls.flat().join(" ")).toContain(`resume ${ID}`);
  });

  it("status does not submit and resume replays only the original server input", async () => {
    let submissions = 0;
    server.use(
      http.get(`${BASE}/${ID}`, () => {
        return HttpResponse.json({
          ...pending,
          phase: "submission_unknown",
          providerRenderId: null,
          recovery: { action: "replay_submission", retryAfterSeconds: 10 },
        });
      }),
      http.post(BASE, async ({ request }) => {
        expect(await request.json()).toEqual(input);
        submissions += 1;
        return HttpResponse.json(pending, { status: 202 });
      }),
    );
    await renderCommand.parseAsync(["node", "okou", "status", ID, "--json"]);
    expect(submissions).toBe(0);
    await renderCommand.parseAsync(["node", "okou", "resume", ID, "--json"]);
    expect(submissions).toBe(1);
  });

  it("does not resubmit expired tasks and returns the permanent artifact on completion", async () => {
    let done = false;
    server.use(
      http.get(`${BASE}/${ID}`, () => {
        return HttpResponse.json(
          done
            ? {
                ...pending,
                status: "completed",
                phase: "completed",
                recovery: { action: "none" },
                result: {
                  url: "https://a.okou.io/intro.mp4",
                  filename: "intro.mp4",
                  contentType: "video/mp4",
                  size: 1024,
                  durationSeconds: 10,
                },
                billing: { status: "settled", creditsCharged: 12 },
                completedAt: "2026-09-12T00:02:00.000Z",
              }
            : {
                ...pending,
                phase: "needs_attention",
                providerRenderId: null,
                recovery: { action: "manual_check" },
              },
        );
      }),
    );
    await renderCommand.parseAsync(["node", "okou", "resume", ID, "--json"]);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({
      recovery: { action: "manual_check" },
    });
    done = true;
    await renderCommand.parseAsync(["node", "okou", "status", ID, "--json"]);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({
      inlineMarkdownLink: "[intro.mp4](<https://a.okou.io/intro.mp4>)",
    });
  });
});
