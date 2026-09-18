import { artifactReferencePath } from "@okouai/api-contracts/contracts/artifact-references";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import chalk from "chalk";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { server } from "../../../mocks/server";
import { generateCommand } from "../index";
import { imageBatchCommand } from "../image-batch";
import {
  AVAILABILITY_URL,
  serveGenerationVisibility,
} from "./artifact-visibility-fixtures";

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  const { readFileSync, writeFileSync } = await import("node:fs");
  return {
    ...original,
    execFile: vi.fn(
      (
        command: string,
        args: readonly string[],
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        expect(command).toBe("ffmpeg");
        const input = args[args.indexOf("-i") + 1];
        const output = args.at(-1);
        if (!input || !output) throw new Error("Expected local image paths");
        expect(readFileSync(input).toString()).toBe(
          "authenticated private image bytes",
        );
        writeFileSync(output, "optimized private WebP bytes");
        callback(null, "", "");
      },
    ),
  };
});

const IMAGE_URL = "http://localhost:3000/api/image-io/generate";
const IMAGE_GENERATION_ID = "00000000-0000-4000-8000-000000000001";
const IMAGE_STATUS_URL = `http://localhost:3000/api/built-in-generations/${IMAGE_GENERATION_ID}`;

interface CapturedImageRequest {
  readonly prompt: string;
  readonly model: string;
  readonly size: string;
  readonly quality: string;
  readonly background: string;
  readonly outputFormat: string;
  readonly moderation: string;
  readonly safetyTolerance: string;
}

describe("okou generate image-batch command", () => {
  vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});
  const temporaryDirectories: string[] = [];

  async function makeTemporaryDirectory(): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), "okou-image-batch-test-"));
    temporaryDirectories.push(path);
    return path;
  }

  beforeEach(() => {
    chalk.level = 0;
    for (const command of imageBatchCommand.commands) {
      command.setOptionValue("visibility", undefined);
    }
    imageBatchCommand.commands
      .find((command) => {
        return command.name() === "wait";
      })
      ?.setOptionValue("json", false);
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("OKOU_TOKEN", "test-token");
  });

  afterEach(async () => {
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    vi.unstubAllEnvs();
    process.exitCode = 0;
    await Promise.all(
      temporaryDirectories.splice(0).map(async (path) => {
        await rm(path, { recursive: true, force: true });
      }),
    );
  });

  it("runs five jobs with at most three in flight, retries once, and preserves manifest order", async () => {
    const root = await makeTemporaryDirectory();
    const manifestPath = join(root, "images.tsv");
    const stateDirectory = join(root, "state");
    await writeFile(
      manifestPath,
      [
        "hero\tHero dog portrait\t1536x1024",
        "detail\tDog collar detail\t1024x1024",
        "retry\tDog running through grass\t1024x1536",
        "team\tFour dogs together",
        "fifth\tDog asleep by a window\t2048x1024",
      ].join("\n"),
      "utf8",
    );
    await mkdir(stateDirectory);

    let activeRequests = 0;
    let maximumActiveRequests = 0;
    const attempts = new Map<string, number>();
    const requests = new Map<string, CapturedImageRequest>();
    server.use(
      http.post(IMAGE_URL, async ({ request }) => {
        const body = (await request.json()) as CapturedImageRequest;
        requests.set(body.prompt, body);
        const attempt = (attempts.get(body.prompt) ?? 0) + 1;
        attempts.set(body.prompt, attempt);
        activeRequests += 1;
        maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests);
        await new Promise((resolvePromise) => {
          setTimeout(resolvePromise, 30);
        });
        activeRequests -= 1;

        if (body.prompt === "Dog running through grass" && attempt === 1) {
          return HttpResponse.json(
            { error: { message: "rate limited", code: "RATE_LIMITED" } },
            { status: 429 },
          );
        }
        const slug = body.prompt.toLowerCase().replaceAll(" ", "-");
        return HttpResponse.json({
          id: `image-${slug}`,
          filename: `${slug}.png`,
          contentType: "image/png",
          size: 19,
          url: `https://cdn.example/${slug}.png`,
          embedUrl: `https://embed.example/${slug}.png`,
          creditsCharged: 1,
          model: "seedream4",
          provider: "fal",
          imageSize: "1536x1024",
          quality: "low",
          background: "opaque",
          outputFormat: "png",
          moderation: "auto",
        });
      }),
    );

    await generateCommand.parseAsync([
      "node",
      "cli",
      "image-batch",
      "__run",
      manifestPath,
      stateDirectory,
    ]);

    expect(maximumActiveRequests).toBe(3);
    expect(attempts.get("Dog running through grass")).toBe(2);
    expect(requests.get("Dog collar detail")).toEqual({
      prompt: "Dog collar detail",
      model: "seedream4",
      size: "1024x1024",
      quality: "low",
      background: "auto",
      outputFormat: "png",
      moderation: "auto",
      safetyTolerance: "4",
    });
    expect(requests.get("Four dogs together")).toEqual({
      prompt: "Four dogs together",
      model: "seedream4",
      size: "816x816",
      quality: "low",
      background: "auto",
      outputFormat: "png",
      moderation: "auto",
      safetyTolerance: "4",
    });
    expect(requests.get("Dog asleep by a window")).toEqual({
      prompt: "Dog asleep by a window",
      model: "seedream4",
      size: "2048x1024",
      quality: "low",
      background: "auto",
      outputFormat: "png",
      moderation: "auto",
      safetyTolerance: "4",
    });
    expect(await readFile(join(stateDirectory, "done"), "utf8")).toBe("0\n");
    expect(await readFile(join(stateDirectory, "results.tsv"), "utf8")).toBe(
      [
        "hero\thttps://embed.example/hero-dog-portrait.png",
        "detail\thttps://embed.example/dog-collar-detail.png",
        "retry\thttps://embed.example/dog-running-through-grass.png",
        "team\thttps://embed.example/four-dogs-together.png",
        "fifth\thttps://embed.example/dog-asleep-by-a-window.png",
        "",
      ].join("\n"),
    );
    const metadata = JSON.parse(
      await readFile(join(stateDirectory, "artifacts.json"), "utf8"),
    );
    expect(metadata).toMatchObject({
      resultsPath: join(stateDirectory, "results.tsv"),
      artifacts: [
        {
          assetId: "hero",
          asset: "https://embed.example/hero-dog-portrait.png",
          url: "https://cdn.example/hero-dog-portrait.png",
          inlineMarkdownLink:
            "[hero](<https://cdn.example/hero-dog-portrait.png>)",
          previewMarkdownBlock:
            "![hero](<https://cdn.example/hero-dog-portrait.png>)",
        },
        { assetId: "detail" },
        { assetId: "retry" },
        { assetId: "team" },
        { assetId: "fifth" },
      ],
      artifactPresentationContext: expect.stringContaining(
        "outside code fences",
      ),
    });
    await writeFile(join(stateDirectory, "pid"), String(process.pid));
    mockConsoleLog.mockClear();
    await generateCommand.parseAsync([
      "node",
      "cli",
      "image-batch",
      "wait",
      stateDirectory,
      "--json",
    ]);
    expect(mockConsoleLog.mock.calls).toHaveLength(1);
    expect(JSON.parse(String(mockConsoleLog.mock.calls[0]?.[0]))).toEqual(
      metadata,
    );
    expect(attempts.get("Hero dog portrait")).toBe(1);
  });

  it.each([undefined, "public"] as const)(
    "bundles private images locally and retains the selected %s chat references",
    async (visibility) => {
      vi.stubEnv("OKOU_APP_URL", "https://app.okou.ai");
      vi.stubEnv("OKOU_CURRENT_INTEGRATION", "slack");
      const root = await makeTemporaryDirectory();
      const manifestPath = join(root, "images.tsv");
      const stateDirectory = join(root, "state");
      await writeFile(manifestPath, "hero\tA private landscape\n", "utf8");
      await mkdir(stateDirectory);
      const reference = artifactReferencePath(IMAGE_GENERATION_ID, "image.png");
      const artifact = visibility
        ? serveGenerationVisibility("image.png", visibility)
        : { url: `https://app.okou.ai${reference}` };
      const sharingUrl =
        "sharingUrl" in artifact ? artifact.sharingUrl : undefined;
      let authorization: string | null = null;
      server.use(
        http.post(
          visibility ? `${IMAGE_URL}/private` : IMAGE_URL,
          async ({ request }) => {
            if (visibility) {
              expect(await request.json()).toMatchObject({
                requirePrivateArtifact: true,
              });
            }
            return HttpResponse.json({
              id: IMAGE_GENERATION_ID,
              filename: "image.png",
              contentType: "image/png",
              size: 33,
              url: reference,
              privateArtifacts: true,
              creditsCharged: 1,
              model: "seedream4",
              provider: "fal",
              imageSize: "816x816",
              quality: "low",
              background: "opaque",
              outputFormat: "png",
              moderation: "auto",
            });
          },
        ),
        http.get(
          "http://localhost:3000/api/web/download-file",
          ({ request }) => {
            authorization = request.headers.get("authorization");
            expect(new URL(request.url).searchParams.get("file_id")).toBe(
              IMAGE_GENERATION_ID,
            );
            return new HttpResponse("authenticated private image bytes", {
              headers: { "content-type": "image/png" },
            });
          },
        ),
      );
      await generateCommand.parseAsync([
        "node",
        "cli",
        "image-batch",
        "__run",
        manifestPath,
        stateDirectory,
        ...(visibility ? ["--visibility", visibility] : []),
      ]);
      expect(await readFile(join(stateDirectory, "done"), "utf8")).toBe("0\n");
      expect(authorization).toBe("Bearer test-token");
      expect(await readFile(join(stateDirectory, "results.tsv"), "utf8")).toBe(
        "hero\tassets/image-hero.webp\n",
      );
      expect(
        await readFile(join(stateDirectory, "assets/image-hero.webp"), "utf8"),
      ).toBe("optimized private WebP bytes");
      await expect(
        readFile(join(stateDirectory, "assets/image-hero.source")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(vi.mocked(execFile).mock.calls.at(-1)?.[1]).toEqual(
        expect.arrayContaining([
          "-protocol_whitelist",
          "file,pipe",
          "-c:v",
          "libwebp",
          "-quality",
          "85",
        ]),
      );
      expect(vi.mocked(execFile).mock.calls.at(-1)?.[1]).not.toContain("-vf");
      expect(
        JSON.parse(
          await readFile(join(stateDirectory, "artifacts.json"), "utf8"),
        ),
      ).toMatchObject({
        artifacts: [
          {
            assetId: "hero",
            asset: "assets/image-hero.webp",
            url: artifact.url,
            ...(visibility
              ? { visibility, ownerUrl: `https://app.okou.ai${reference}` }
              : {}),
            inlineMarkdownLink: `[hero](<${artifact.url}>)`,
            previewMarkdownBlock: `![hero](<${artifact.url}>)`,
            privateArtifacts: true,
          },
        ],
      });
      await writeFile(join(stateDirectory, "pid"), String(process.pid));
      mockConsoleLog.mockClear();
      await generateCommand.parseAsync([
        "node",
        "cli",
        "image-batch",
        "wait",
        stateDirectory,
      ]);
      const stdout = mockConsoleLog.mock.calls.flat().join("\n");
      expect(stdout).toContain("hero\tassets/image-hero.webp");
      expect(stdout).toContain(join(stateDirectory, "artifacts.json"));
      expect(stdout).toContain("only available inside the agent runtime");
      if (visibility === "public") {
        if (sharingUrl === undefined) {
          throw new Error("Public fixture did not provide its delivery alias");
        }
        expect(stdout).not.toContain("upload-file");
        expect(stdout).not.toContain(sharingUrl);
      } else {
        expect(stdout).toContain("okou slack upload-file");
      }
      mockConsoleLog.mockClear();
      vi.stubEnv("OKOU_CURRENT_INTEGRATION", "lark");
      await generateCommand.parseAsync([
        "node",
        "cli",
        "image-batch",
        "wait",
        stateDirectory,
        "--json",
      ]);
      expect(
        JSON.parse(mockConsoleLog.mock.calls.flat().join("\n")),
      ).toMatchObject({
        artifacts: [
          {
            url: artifact.url,
            ...(visibility ? { visibility } : {}),
            artifactPresentationContext:
              visibility === "public"
                ? expect.not.stringContaining("upload-file")
                : expect.stringContaining("okou lark upload-file"),
          },
        ],
      });
      const artifactsJson = await readFile(
        join(stateDirectory, "artifacts.json"),
        "utf8",
      );
      expect(artifactsJson).not.toContain("upload-file");
      if (visibility === "public") {
        if (sharingUrl === undefined) {
          throw new Error("Public fixture did not provide its delivery alias");
        }
        expect(artifactsJson).not.toContain(sharingUrl);
      }
    },
  );

  it("does not regenerate a billed image when sharing fails", async () => {
    vi.stubEnv("OKOU_APP_URL", "https://app.okou.ai");
    const root = await makeTemporaryDirectory();
    const manifestPath = join(root, "images.tsv");
    const stateDirectory = join(root, "state");
    await writeFile(manifestPath, "hero\tA landscape\n", "utf8");
    await mkdir(stateDirectory);
    const artifact = serveGenerationVisibility("image.png", "public");
    let generationCount = 0;
    server.use(
      http.post(`${IMAGE_URL}/private`, () => {
        generationCount += 1;
        return HttpResponse.json({
          id: IMAGE_GENERATION_ID,
          filename: "image.png",
          contentType: "image/png",
          size: 33,
          url: artifact.reference,
          creditsCharged: 1,
          model: "seedream4",
          provider: "fal",
          imageSize: "816x816",
          quality: "low",
          background: "opaque",
          outputFormat: "png",
          moderation: "auto",
        });
      }),
      http.put("http://localhost:3000/api/artifact-shares", () => {
        return HttpResponse.json(
          {
            error: {
              code: "INTERNAL_SERVER_ERROR",
              message: "Sharing temporarily unavailable",
            },
          },
          { status: 500 },
        );
      }),
    );
    await generateCommand.parseAsync([
      "node",
      "cli",
      "image-batch",
      "__run",
      manifestPath,
      stateDirectory,
      "--visibility",
      "public",
    ]);
    expect(generationCount).toBe(1);
    expect(await readFile(join(stateDirectory, "done"), "utf8")).toBe("1\n");
    const stderr = mockConsoleError.mock.calls.flat().join("\n");
    expect(stderr).toContain(artifact.ownerUrl);
    expect(stderr).toContain(
      "Do not repeat the upload, hosting, or generation",
    );
    expect(mockConsoleLog.mock.calls.flat().join("\n")).not.toContain(
      "Retrying image batch",
    );
  });

  it("rejects explicit visibility before launching a batch when the switch is off", async () => {
    const root = await makeTemporaryDirectory();
    const manifestPath = join(root, "images.tsv");
    const stateDirectory = join(root, "state");
    await writeFile(manifestPath, "hero\tA landscape\n", "utf8");
    server.use(
      http.get(AVAILABILITY_URL, () => {
        return HttpResponse.json({ enabled: false });
      }),
    );
    await expect(
      generateCommand.parseAsync([
        "node",
        "cli",
        "image-batch",
        "start",
        manifestPath,
        stateDirectory,
        "--visibility",
        "only-me",
      ]),
    ).rejects.toThrow("process.exit called");
    await expect(readFile(join(stateDirectory, "pid"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(mockConsoleError.mock.calls.flat().join("\n")).toContain(
      "--visibility requires privateArtifacts to be enabled",
    );
  });

  it.each(["https://app.okou.ai", "https://pr-123-app.omby.ai"])(
    "qualifies stored batch references with %s",
    async (appOrigin) => {
      vi.stubEnv("OKOU_APP_URL", appOrigin);
      const stateDirectory = await makeTemporaryDirectory();
      const resultsPath = join(stateDirectory, "results.tsv");
      const metadataPath = join(stateDirectory, "artifacts.json");
      const metadata = {
        resultsPath,
        artifacts: [
          {
            assetId: "hero",
            asset: "assets/image-hero.webp",
            url: "/artifacts/abcxyz1234.png#page=2",
            inlineMarkdownLink: "[hero](</artifacts/abcxyz1234.png#page=2>)",
            previewMarkdownBlock: "![hero](</artifacts/abcxyz1234.png#page=2>)",
          },
          {
            assetId: "shared",
            asset: "assets/image-shared.webp",
            url: "https://cdn.example/shared.png?download=1#preview",
            ownerUrl: "/artifacts/00000000000040008000000000000001.png",
            visibility: "public",
            inlineMarkdownLink:
              "[Shared image](<https://cdn.example/shared.png?download=1#preview>)",
            previewMarkdownBlock:
              "![Shared image](<https://cdn.example/shared.png?download=1#preview>)",
          },
        ],
        artifactPresentationContext: "Stored presentation guidance",
      };
      await writeFile(join(stateDirectory, "pid"), String(process.pid));
      await writeFile(join(stateDirectory, "done"), "0\n");
      await writeFile(resultsPath, "hero\tassets/image-hero.webp\n");
      await writeFile(metadataPath, JSON.stringify(metadata));

      await generateCommand.parseAsync([
        "node",
        "cli",
        "image-batch",
        "wait",
        stateDirectory,
        "--json",
      ]);

      expect(mockConsoleLog.mock.calls).toHaveLength(1);
      expect(JSON.parse(String(mockConsoleLog.mock.calls[0]?.[0]))).toEqual({
        ...metadata,
        artifacts: [
          {
            ...metadata.artifacts[0],
            url: `${appOrigin}/artifacts/abcxyz1234.png#page=2`,
            inlineMarkdownLink: `[hero](<${appOrigin}/artifacts/abcxyz1234.png#page=2>)`,
            previewMarkdownBlock: `![hero](<${appOrigin}/artifacts/abcxyz1234.png#page=2>)`,
          },
          {
            ...metadata.artifacts[1],
            ownerUrl: `${appOrigin}/artifacts/00000000000040008000000000000001.png`,
          },
        ],
      });
      expect(JSON.parse(await readFile(metadataPath, "utf8"))).toEqual(
        metadata,
      );
    },
  );

  it.each([false, true])(
    "reads a stored TSV-only batch with upload guidance (JSON: %s)",
    async (json) => {
      const stateDirectory = await makeTemporaryDirectory();
      await writeFile(join(stateDirectory, "pid"), String(process.pid));
      await writeFile(join(stateDirectory, "done"), "0\n");
      await writeFile(
        join(stateDirectory, "results.tsv"),
        "hero\tassets/image-hero.webp\n",
      );
      await generateCommand.parseAsync([
        "node",
        "cli",
        "image-batch",
        "wait",
        stateDirectory,
        ...(json ? ["--json"] : []),
      ]);
      const stdout = mockConsoleLog.mock.calls.flat().join("\n");
      if (json) {
        expect(JSON.parse(stdout)).toEqual({
          resultsPath: join(stateDirectory, "results.tsv"),
          artifactPresentationContext: expect.stringContaining(
            "okou web upload-file",
          ),
        });
      } else {
        expect(stdout).toContain("hero\tassets/image-hero.webp");
        expect(stdout).toContain("no artifact presentation metadata");
        expect(stdout).toContain("okou web upload-file");
      }
    },
  );

  it("reports malformed presentation metadata instead of accepting it as a TSV-only batch", async () => {
    const stateDirectory = await makeTemporaryDirectory();
    await writeFile(join(stateDirectory, "pid"), String(process.pid));
    await writeFile(join(stateDirectory, "done"), "0\n");
    await writeFile(
      join(stateDirectory, "results.tsv"),
      "hero\tassets/image-hero.webp\n",
    );
    await writeFile(
      join(stateDirectory, "artifacts.json"),
      '{"artifacts": "invalid"}',
    );
    await expect(
      generateCommand.parseAsync([
        "node",
        "cli",
        "image-batch",
        "wait",
        stateDirectory,
        "--json",
      ]),
    ).rejects.toThrow("process.exit called");
    expect(mockConsoleLog.mock.calls).toHaveLength(0);
    expect(mockConsoleError.mock.calls.flat().join("\n")).toContain(
      "artifacts",
    );
  });

  it("does not automatically retry an async output safety block", async () => {
    const root = await makeTemporaryDirectory();
    const manifestPath = join(root, "images.tsv");
    const stateDirectory = join(root, "state");
    await writeFile(manifestPath, "hero\tA safe landscape\n", "utf8");
    await mkdir(stateDirectory);

    let submissionCount = 0;
    server.use(
      http.post(IMAGE_URL, () => {
        submissionCount += 1;
        return HttpResponse.json(
          {
            generationId: IMAGE_GENERATION_ID,
            type: "image",
            status: "queued",
            realtime: {
              channelName: "user:user-1",
              eventName: `built-in-generation:${IMAGE_GENERATION_ID}`,
              tokenRequest: {
                keyName: "test-key",
                timestamp: 1_700_000_000_000,
                capability: '{"user:user-1":["subscribe"]}',
                clientId: "user-1",
                nonce: "test-nonce",
                mac: "test-mac",
              },
            },
          },
          { status: 202 },
        );
      }),
      http.get(IMAGE_STATUS_URL, () => {
        return HttpResponse.json({
          generationId: IMAGE_GENERATION_ID,
          type: "image",
          status: "failed",
          error: {
            message: "The generated image was blocked by the safety filter.",
            code: "GENERATION_OUTPUT_SAFETY_BLOCKED",
          },
          createdAt: "2026-05-15T00:00:00.000Z",
          startedAt: "2026-05-15T00:00:01.000Z",
          completedAt: "2026-05-15T00:00:02.000Z",
        });
      }),
    );

    await generateCommand.parseAsync([
      "node",
      "cli",
      "image-batch",
      "__run",
      manifestPath,
      stateDirectory,
    ]);

    expect(submissionCount).toBe(1);
    expect(await readFile(join(stateDirectory, "done"), "utf8")).toBe("1\n");
    const stdout = mockConsoleLog.mock.calls.flat().join("\n");
    const stderr = mockConsoleError.mock.calls.flat().join("\n");
    expect(stdout).not.toContain("Retrying image batch job hero once");
    expect(stderr).toContain(
      "The generated image was blocked by the safety filter.",
    );
  });

  it.each([
    [
      "input safety rejection",
      "GENERATION_INPUT_SAFETY_REJECTED",
      "The prompt or reference image was blocked by the safety filter.",
    ],
    [
      "unreachable input image",
      "GENERATION_INPUT_MEDIA_UNREACHABLE",
      "An input image could not be downloaded by the generation provider.",
    ],
    [
      "invalid input image",
      "GENERATION_INPUT_MEDIA_INVALID",
      "An input image could not be read by the generation provider.",
    ],
    [
      "invalid generation parameters",
      "GENERATION_INVALID_PARAMETERS",
      "The image generation request contains invalid parameters.",
    ],
  ])(
    "does not automatically retry an async %s",
    async (_caseName, code, message) => {
      const root = await makeTemporaryDirectory();
      const manifestPath = join(root, "images.tsv");
      const stateDirectory = join(root, "state");
      await writeFile(manifestPath, "hero\tA safe landscape\n", "utf8");
      await mkdir(stateDirectory);

      let submissionCount = 0;
      server.use(
        http.post(IMAGE_URL, () => {
          submissionCount += 1;
          return HttpResponse.json(
            {
              generationId: IMAGE_GENERATION_ID,
              type: "image",
              status: "queued",
              realtime: {
                channelName: "user:user-1",
                eventName: `built-in-generation:${IMAGE_GENERATION_ID}`,
                tokenRequest: {
                  keyName: "test-key",
                  timestamp: 1_700_000_000_000,
                  capability: '{"user:user-1":["subscribe"]}',
                  clientId: "user-1",
                  nonce: "test-nonce",
                  mac: "test-mac",
                },
              },
            },
            { status: 202 },
          );
        }),
        http.get(IMAGE_STATUS_URL, () => {
          return HttpResponse.json({
            generationId: IMAGE_GENERATION_ID,
            type: "image",
            status: "failed",
            error: { message, code },
            createdAt: "2026-05-15T00:00:00.000Z",
            startedAt: "2026-05-15T00:00:01.000Z",
            completedAt: "2026-05-15T00:00:02.000Z",
          });
        }),
      );

      await generateCommand.parseAsync([
        "node",
        "cli",
        "image-batch",
        "__run",
        manifestPath,
        stateDirectory,
      ]);

      expect(submissionCount).toBe(1);
      expect(await readFile(join(stateDirectory, "done"), "utf8")).toBe("1\n");
      expect(mockConsoleLog.mock.calls.flat().join("\n")).not.toContain(
        "Retrying image batch job hero once",
      );
      expect(mockConsoleError.mock.calls.flat().join("\n")).toContain(message);
    },
  );

  it("retries an async provider-unavailable failure once", async () => {
    const root = await makeTemporaryDirectory();
    const manifestPath = join(root, "images.tsv");
    const stateDirectory = join(root, "state");
    await writeFile(manifestPath, "hero\tA safe landscape\n", "utf8");
    await mkdir(stateDirectory);

    let submissionCount = 0;
    server.use(
      http.post(IMAGE_URL, () => {
        submissionCount += 1;
        if (submissionCount === 2) {
          return HttpResponse.json({
            id: "image-provider-retry",
            filename: "provider-retry.png",
            contentType: "image/png",
            size: 19,
            url: "https://cdn.example/provider-retry.png",
            embedUrl: "https://embed.example/provider-retry.png",
            creditsCharged: 1,
            model: "seedream4",
            provider: "fal",
            imageSize: "816x816",
            quality: "low",
            background: "opaque",
            outputFormat: "png",
            moderation: "auto",
          });
        }
        return HttpResponse.json(
          {
            generationId: IMAGE_GENERATION_ID,
            type: "image",
            status: "queued",
            realtime: {
              channelName: "user:user-1",
              eventName: `built-in-generation:${IMAGE_GENERATION_ID}`,
              tokenRequest: {
                keyName: "test-key",
                timestamp: 1_700_000_000_000,
                capability: '{"user:user-1":["subscribe"]}',
                clientId: "user-1",
                nonce: "test-nonce",
                mac: "test-mac",
              },
            },
          },
          { status: 202 },
        );
      }),
      http.get(IMAGE_STATUS_URL, () => {
        return HttpResponse.json({
          generationId: IMAGE_GENERATION_ID,
          type: "image",
          status: "failed",
          error: {
            message:
              "The image generation provider is temporarily unavailable.",
            code: "GENERATION_PROVIDER_UNAVAILABLE",
          },
          createdAt: "2026-05-15T00:00:00.000Z",
          startedAt: "2026-05-15T00:00:01.000Z",
          completedAt: "2026-05-15T00:00:02.000Z",
        });
      }),
    );

    await generateCommand.parseAsync([
      "node",
      "cli",
      "image-batch",
      "__run",
      manifestPath,
      stateDirectory,
    ]);

    expect(submissionCount).toBe(2);
    expect(await readFile(join(stateDirectory, "done"), "utf8")).toBe("0\n");
    expect(mockConsoleLog.mock.calls.flat().join("\n")).toContain(
      "Retrying image batch job hero once",
    );
    expect(await readFile(join(stateDirectory, "results.tsv"), "utf8")).toBe(
      "hero\thttps://embed.example/provider-retry.png\n",
    );
  });

  it.each([undefined, "org"] as const)(
    "starts a detached worker with %s visibility and waits for its result",
    async (visibility) => {
      if (visibility) serveGenerationVisibility("image.png", visibility);
      const root = await makeTemporaryDirectory();
      const manifestPath = join(root, "images.tsv");
      const stateDirectory = join(root, "state");
      const fixturePath = join(root, "batch-worker.mjs");
      await writeFile(manifestPath, "hero\tA happy dog\n", "utf8");
      await writeFile(
        fixturePath,
        `import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
const [, , , manifestPath, stateDirectory, ...options] = process.argv.slice(2);
await writeFile(join(stateDirectory, "worker-options.json"), JSON.stringify(options), "utf8");
const manifest = await readFile(manifestPath, "utf8");
const id = manifest.split("\\t", 1)[0];
await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
await writeFile(join(stateDirectory, "results.tsv"), id + "\\thttps://cdn.example/dog.png\\n", "utf8");
await writeFile(join(stateDirectory, "done"), "0\\n", "utf8");
`,
        "utf8",
      );

      const originalEntrypoint = process.argv[1];
      process.argv[1] = fixturePath;
      try {
        await generateCommand.parseAsync([
          "node",
          "cli",
          "image-batch",
          "start",
          manifestPath,
          stateDirectory,
          ...(visibility ? ["--visibility", visibility] : []),
        ]);
      } finally {
        if (originalEntrypoint === undefined) {
          delete process.argv[1];
        } else {
          process.argv[1] = originalEntrypoint;
        }
      }

      await generateCommand.parseAsync([
        "node",
        "cli",
        "image-batch",
        "wait",
        stateDirectory,
        "--timeout",
        "5",
      ]);

      const stdout = mockConsoleLog.mock.calls.flat().join("\n");
      expect(stdout).toContain(`Image batch started: ${stateDirectory}`);
      expect(stdout).toContain(
        `okou generate image-batch wait '${stateDirectory}'`,
      );
      expect(stdout).toContain(
        "reuse this batch instead of starting another one",
      );
      expect(stdout).toContain("hero\thttps://cdn.example/dog.png");
      expect(stdout).toContain(
        `Image batch joined: ${join(stateDirectory, "results.tsv")}`,
      );
      expect(
        JSON.parse(
          await readFile(join(stateDirectory, "worker-options.json"), "utf8"),
        ),
      ).toEqual(visibility ? ["--visibility", visibility] : []);
    },
  );
});
