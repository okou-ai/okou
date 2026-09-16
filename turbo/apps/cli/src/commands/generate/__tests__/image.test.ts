/**
 * Tests for okou generate image command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): backend image route via MSW
 * - Real (internal): All CLI code and fetch
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import chalk from "chalk";
import { server } from "../../../mocks/server";
import { generateCommand } from "../index";
import { imageCommand } from "../image";
import { DEFAULT_IMAGE_MODEL_ENV } from "@okouai/core/image-model-catalog";

const IMAGE_URL = "http://localhost:3000/api/image-io/generate";
const IMAGE_GENERATION_ID = "00000000-0000-4000-8000-000000000001";
const IMAGE_STATUS_URL = `http://localhost:3000/api/built-in-generations/${IMAGE_GENERATION_ID}`;
const IMAGE_RESULT = {
  id: "image-file-id",
  filename: "image-image-fi.png",
  contentType: "image/png",
  size: 19,
  url: "http://localhost:3000/f/user-1/image-file-id/image-image-fi.png",
  creditsCharged: 65,
  model: "gpt-image-1",
  provider: "fal",
  imageSize: "1024x1024",
  quality: "medium",
  background: "opaque",
  outputFormat: "png",
  moderation: "auto",
};

function buildRunToken(): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256" })).toString(
    "base64url",
  );
  const body = Buffer.from(
    JSON.stringify({
      userId: "user-image",
      runId: "run-image",
      orgId: "org-image",
      scope: "okou",
      capabilities: ["file:write"],
      iat: 1000,
      exp: 2000,
    }),
  ).toString("base64url");
  return `vm0_sandbox_${header}.${body}.test-signature`;
}

describe("okou generate image command", () => {
  vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  beforeEach(() => {
    chalk.level = 0;
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("OKOU_TOKEN", "test-token");
  });

  afterEach(() => {
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    vi.unstubAllEnvs();
  });

  it("should generate an image and print the /f file URL", async () => {
    let capturedBody: unknown;
    server.use(
      http.post(IMAGE_URL, async ({ request }) => {
        expect(request.headers.get("authorization")).toBe("Bearer test-token");
        expect(request.headers.get("content-type")).toBe("application/json");
        capturedBody = await request.json();

        return HttpResponse.json({
          ...IMAGE_RESULT,
          imageSize: "1024x1024",
          quality: "auto",
          background: "opaque",
          outputFormat: "webp",
          outputCompression: 50,
          moderation: "low",
        });
      }),
    );

    await generateCommand.parseAsync([
      "node",
      "cli",
      "image",
      "--raw-prompt",
      "A watercolor fox",
      "--quality",
      "auto",
      "--background",
      "opaque",
      "--format",
      "webp",
      "--compression",
      "50",
      "--moderation",
      "low",
    ]);

    expect(capturedBody).toEqual({
      prompt: "A watercolor fox",
      model: "gpt-image-1",
      size: "1024x1024",
      quality: "auto",
      background: "opaque",
      outputFormat: "webp",
      outputCompression: 50,
      moderation: "low",
      safetyTolerance: "4",
    });
    const stdout = mockConsoleLog.mock.calls.flat().join("\n");
    expect(stdout).toContain(`Image generated: ${IMAGE_RESULT.url}`);
    expect(stdout).toContain(`File: ${IMAGE_RESULT.filename}`);
    expect(stdout).toContain("Size: 1024x1024");
    expect(stdout).toContain("Quality: auto");
    expect(stdout).toContain("Format: webp");
    expect(stdout).toContain("Compression: 50");
    expect(stdout).toContain("Moderation: low");
    expect(stdout).toContain("Credits charged: 65");
    expect(stdout).toContain("Model: gpt-image-1");
    expect(stdout).toContain("Provider: fal");
    expect(stdout).toContain(
      `[${IMAGE_RESULT.filename}](<${IMAGE_RESULT.url}>)`,
    );
    expect(stdout).toContain(
      `\n\n![${IMAGE_RESULT.filename}](<${IMAGE_RESULT.url}>)\n\n`,
    );
    expect(stdout).toContain("creates two user-facing references");
  });

  it.each([
    {
      name: "outside a run with an implicit model",
      insideRun: false,
      runDefaultImageModel: undefined,
      modelArguments: [],
      expectedModel: "gpt-image-1",
    },
    {
      name: "outside a run with an explicit model",
      insideRun: false,
      runDefaultImageModel: undefined,
      modelArguments: ["--model", "qwen-image"],
      expectedModel: "qwen-image",
    },
    {
      name: "inside a run with an implicit model",
      insideRun: true,
      runDefaultImageModel: undefined,
      modelArguments: [],
      expectedModel: undefined,
    },
    {
      name: "inside a gated run with an implicit model",
      insideRun: true,
      runDefaultImageModel: "qwen-image",
      modelArguments: [],
      expectedModel: undefined,
    },
    {
      name: "inside a gated run with an explicit model",
      insideRun: true,
      runDefaultImageModel: "seedream4",
      modelArguments: ["--model", "qwen-image"],
      expectedModel: "qwen-image",
    },
    {
      name: "inside a gated run with an explicit value equal to the CLI default",
      insideRun: true,
      runDefaultImageModel: "qwen-image",
      modelArguments: ["--model", "gpt-image-1"],
      expectedModel: "gpt-image-1",
    },
  ])(
    "should serialize image model precedence for $name",
    async ({
      insideRun,
      runDefaultImageModel,
      modelArguments,
      expectedModel,
    }) => {
      vi.stubEnv("OKOU_TOKEN", insideRun ? buildRunToken() : "test-token");
      if (runDefaultImageModel !== undefined) {
        vi.stubEnv(DEFAULT_IMAGE_MODEL_ENV, runDefaultImageModel);
      }
      let capturedBody: unknown;
      server.use(
        http.post(IMAGE_URL, async ({ request }) => {
          capturedBody = await request.json();
          return HttpResponse.json(IMAGE_RESULT);
        }),
      );

      await generateCommand.parseAsync([
        "node",
        "cli",
        "image",
        "--raw-prompt",
        "Model precedence",
        ...modelArguments,
      ]);

      expect(capturedBody).toEqual({
        prompt: "Model precedence",
        ...(expectedModel === undefined ? {} : { model: expectedModel }),
        size: "1024x1024",
        quality: "medium",
        background: "auto",
        outputFormat: "png",
        moderation: "auto",
        safetyTolerance: "4",
      });
    },
  );

  it.each([
    {
      name: "an explicit Lite model with an implicit size",
      runDefaultImageModel: undefined,
      modelArguments: ["--model", "seedream5-lite"],
      sizeArguments: [],
      expectedModel: "seedream5-lite",
      expectedSize: "auto",
    },
    {
      name: "a Lite run default with an implicit size",
      runDefaultImageModel: "seedream5-lite",
      modelArguments: [],
      sizeArguments: [],
      expectedModel: undefined,
      expectedSize: "auto",
    },
    {
      name: "an explicit Lite size",
      runDefaultImageModel: undefined,
      modelArguments: ["--model", "seedream5-lite"],
      sizeArguments: ["--size", "1024x1024"],
      expectedModel: "seedream5-lite",
      expectedSize: "1024x1024",
    },
  ])(
    "should serialize $name without rewriting caller intent",
    async ({
      runDefaultImageModel,
      modelArguments,
      sizeArguments,
      expectedModel,
      expectedSize,
    }) => {
      if (runDefaultImageModel !== undefined) {
        vi.stubEnv(DEFAULT_IMAGE_MODEL_ENV, runDefaultImageModel);
      }
      let capturedBody: unknown;
      server.use(
        http.post(IMAGE_URL, async ({ request }) => {
          capturedBody = await request.json();
          return HttpResponse.json(IMAGE_RESULT);
        }),
      );

      await generateCommand.parseAsync([
        "node",
        "cli",
        "image",
        "--raw-prompt",
        "Lite size precedence",
        ...modelArguments,
        ...sizeArguments,
      ]);

      expect(capturedBody).toEqual({
        prompt: "Lite size precedence",
        ...(expectedModel === undefined ? {} : { model: expectedModel }),
        size: expectedSize,
        quality: "medium",
        background: "auto",
        outputFormat: "png",
        moderation: "auto",
        safetyTolerance: "4",
      });
    },
  );

  it("should surface the CDN embed URL when it differs from the file URL", async () => {
    const embedUrl =
      "https://cdn.vm7.io/cdn-cgi/image/fit=scale-down,format=auto,quality=85,metadata=none/artifacts/abc.png";
    server.use(
      http.post(IMAGE_URL, () => {
        return HttpResponse.json({ ...IMAGE_RESULT, embedUrl });
      }),
    );

    await generateCommand.parseAsync([
      "node",
      "cli",
      "image",
      "--raw-prompt",
      "A watercolor fox",
    ]);

    const stdout = mockConsoleLog.mock.calls.flat().join("\n");
    expect(stdout).toContain(`Image generated: ${IMAGE_RESULT.url}`);
    expect(stdout).toContain(`Embed this URL in HTML: ${embedUrl}`);
    expect(stdout).toContain(
      `[${IMAGE_RESULT.filename}](<${IMAGE_RESULT.url}>)`,
    );
    expect(stdout).toContain(
      `${embedUrl} is for embedding the image in authored HTML`,
    );
  });

  it("should omit the embed line when the API does not return one", async () => {
    server.use(
      http.post(IMAGE_URL, () => {
        return HttpResponse.json(IMAGE_RESULT);
      }),
    );

    await generateCommand.parseAsync([
      "node",
      "cli",
      "image",
      "--raw-prompt",
      "A watercolor fox",
    ]);

    const stdout = mockConsoleLog.mock.calls.flat().join("\n");
    expect(stdout).toContain(`Image generated: ${IMAGE_RESULT.url}`);
    expect(stdout).not.toContain("Embed this URL in HTML");
  });

  it("should print the complete image result as one JSON object", async () => {
    server.use(
      http.post(IMAGE_URL, () => {
        return HttpResponse.json(IMAGE_RESULT);
      }),
    );

    await generateCommand.parseAsync([
      "node",
      "cli",
      "image",
      "--raw-prompt",
      "A watercolor fox",
      "--json",
    ]);

    expect(mockConsoleLog.mock.calls).toHaveLength(1);
    expect(JSON.parse(String(mockConsoleLog.mock.calls[0]?.[0]))).toEqual({
      ...IMAGE_RESULT,
      inlineMarkdownLink: `[${IMAGE_RESULT.filename}](<${IMAGE_RESULT.url}>)`,
      previewMarkdownBlock: `![${IMAGE_RESULT.filename}](<${IMAGE_RESULT.url}>)`,
      artifactPresentationContext: expect.stringContaining(
        "outside code fences",
      ),
    });
  });

  it.each([
    {
      url: "/artifacts/abcxyz1234.png#detail",
      appUrl: "https://app.okou.ai",
      apiUrl: "http://localhost:3000",
      expectedUrl: "https://app.okou.ai/artifacts/abcxyz1234.png#detail",
    },
    {
      url: "/artifacts/00000000000040008000000000000021.png",
      appUrl: "https://pr-123-app.omby.ai/ignored-path",
      apiUrl: "http://localhost:3000",
      expectedUrl:
        "https://pr-123-app.omby.ai/artifacts/00000000000040008000000000000021.png",
    },
    {
      url: "/artifacts/abcxyz1234.png",
      appUrl: undefined,
      apiUrl: undefined,
      expectedUrl: "https://app.okou.ai/artifacts/abcxyz1234.png",
    },
    {
      url: "/artifacts/abcxyz1234.png",
      appUrl: undefined,
      apiUrl: "https://pr-123-api.vm6.ai",
      expectedUrl: "https://pr-123-app.omby.ai/artifacts/abcxyz1234.png",
    },
    {
      url: "https://app.okou.ai/artifacts/abcxyz1234.png",
      appUrl: "https://app.okou.ai",
      apiUrl: "http://localhost:3000",
      expectedUrl: "https://app.okou.ai/artifacts/abcxyz1234.png",
    },
    {
      url: "http://localhost:3000/api/web/download-file?file_id=00000000-0000-4000-8000-000000000021&filename=Launch%20v2.png",
      appUrl: "https://app.okou.ai",
      apiUrl: "http://localhost:3000",
      expectedUrl:
        "http://localhost:3000/api/web/download-file?file_id=00000000-0000-4000-8000-000000000021&filename=Launch%20v2.png",
    },
  ])(
    "prints a complete artifact URL for $url and escapes its label",
    async ({ url, appUrl, apiUrl, expectedUrl }) => {
      vi.stubEnv("OKOU_APP_URL", appUrl);
      vi.stubEnv("OKOU_API_BACKEND_URL", apiUrl);
      const filename = String.raw`Launch [v2]\image.png`;
      const label = String.raw`Launch \[v2\]\\image.png`;
      server.use(
        http.post(
          new URL("/api/image-io/generate", apiUrl ?? "https://api.okou.ai")
            .href,
          () => {
            return HttpResponse.json({ ...IMAGE_RESULT, filename, url });
          },
        ),
      );
      await generateCommand.parseAsync([
        "node",
        "cli",
        "image",
        "--raw-prompt",
        "A product image",
        "--json",
      ]);
      expect(
        JSON.parse(String(mockConsoleLog.mock.calls[0]?.[0])),
      ).toMatchObject({
        filename,
        url: expectedUrl,
        inlineMarkdownLink: `[${label}](<${expectedUrl}>)`,
        previewMarkdownBlock: `![${label}](<${expectedUrl}>)`,
        artifactPresentationContext: expect.stringContaining(
          "own Markdown paragraph",
        ),
      });
    },
  );

  it.each([
    ["provider listing", ["image", "--json"]],
    ["connector guidance", ["image", "--provider", "replicate", "--json"]],
    [
      "prompt compilation",
      [
        "image",
        "--style",
        "image-style:ink-storefront",
        "--prompt",
        "A florist named Luna Floral",
        "--compile",
        "--json",
      ],
    ],
  ])("should reject JSON output for %s", async (_mode, args) => {
    await expect(async () => {
      await generateCommand.parseAsync(["node", "cli", ...args]);
    }).rejects.toThrow("process.exit called");

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining(
        "--json is only available for direct built-in generation",
      ),
    );
    expect(mockConsoleLog).not.toHaveBeenCalled();
  });

  it("should pass fal model controls to the image API", async () => {
    let capturedBody: unknown;
    server.use(
      http.post(IMAGE_URL, async ({ request }) => {
        capturedBody = await request.json();

        return HttpResponse.json({
          ...IMAGE_RESULT,
          model: "fal-ai/flux-pro/v1.1",
          provider: "fal",
          quality: "model-default",
          billingCategory: "output_megapixel",
          billingQuantity: 2,
          safetyTolerance: "5",
          seed: 123,
        });
      }),
    );

    await generateCommand.parseAsync([
      "node",
      "cli",
      "image",
      "--raw-prompt",
      "A product hero shot",
      "--model",
      "flux-pro-1.1",
      "--format",
      "jpeg",
      "--seed",
      "123",
      "--safety-tolerance",
      "5",
      "--enhance-prompt",
    ]);

    expect(capturedBody).toEqual({
      prompt: "A product hero shot",
      model: "flux-pro-1.1",
      size: "1024x1024",
      quality: "medium",
      background: "auto",
      outputFormat: "jpeg",
      moderation: "auto",
      seed: 123,
      safetyTolerance: "5",
      enhancePrompt: true,
    });
    const stdout = mockConsoleLog.mock.calls.flat().join("\n");
    expect(stdout).toContain("Safety tolerance: 5");
    expect(stdout).toContain("Seed: 123");
    expect(stdout).toContain("Model: fal-ai/flux-pro/v1.1");
    expect(stdout).toContain("Provider: fal");
  });

  it("should pass image-to-image controls to the image API", async () => {
    let capturedBody: unknown;
    server.use(
      http.post(IMAGE_URL, async ({ request }) => {
        capturedBody = await request.json();

        return HttpResponse.json({
          ...IMAGE_RESULT,
          model: "fal-ai/flux-pro/v1.1",
          provider: "fal",
          outputFormat: "jpeg",
          sourceImageUrls: ["https://example.com/mockup.png"],
          imagePromptStrength: 0.2,
        });
      }),
    );

    await generateCommand.parseAsync([
      "node",
      "cli",
      "image",
      "--compiled-prompt",
      "Turn this mockup into a polished product shot",
      "--model",
      "flux-pro-1.1",
      "--image-url",
      "https://example.com/mockup.png",
      "--image-prompt-strength",
      "0.2",
      "--format",
      "jpeg",
    ]);

    expect(capturedBody).toEqual({
      prompt: "Turn this mockup into a polished product shot",
      model: "flux-pro-1.1",
      size: "auto",
      quality: "medium",
      background: "auto",
      outputFormat: "jpeg",
      moderation: "auto",
      safetyTolerance: "4",
      imageUrls: ["https://example.com/mockup.png"],
      imagePromptStrength: 0.2,
    });
    const stdout = mockConsoleLog.mock.calls.flat().join("\n");
    expect(stdout).toContain("Model: fal-ai/flux-pro/v1.1");
    expect(stdout).toContain("Provider: fal");
  });

  it("should pass Nano Banana 2 edit controls to the image API", async () => {
    let capturedBody: unknown;
    server.use(
      http.post(IMAGE_URL, async ({ request }) => {
        capturedBody = await request.json();

        return HttpResponse.json({
          ...IMAGE_RESULT,
          model: "fal-ai/nano-banana-2",
          provider: "fal",
          outputFormat: "webp",
          sourceImageUrls: [
            "https://example.com/reference-1.png",
            "https://example.com/reference-2.png",
          ],
        });
      }),
    );

    await generateCommand.parseAsync([
      "node",
      "cli",
      "image",
      "--compiled-prompt",
      "Combine these references into a campaign image",
      "--model",
      "nano-banana-2",
      "--image-url",
      "https://example.com/reference-1.png",
      "--image-url",
      "https://example.com/reference-2.png",
      "--format",
      "webp",
      "--seed",
      "456",
      "--safety-tolerance",
      "5",
    ]);

    expect(capturedBody).toEqual({
      prompt: "Combine these references into a campaign image",
      model: "nano-banana-2",
      size: "auto",
      quality: "medium",
      background: "auto",
      outputFormat: "webp",
      moderation: "auto",
      seed: 456,
      safetyTolerance: "5",
      imageUrls: [
        "https://example.com/reference-1.png",
        "https://example.com/reference-2.png",
      ],
    });
    const stdout = mockConsoleLog.mock.calls.flat().join("\n");
    expect(stdout).toContain("Model: fal-ai/nano-banana-2");
    expect(stdout).toContain("Provider: fal");
  });

  it("should print styled image prompt compilation instructions with --style and --compile", async () => {
    await generateCommand.parseAsync([
      "node",
      "cli",
      "image",
      "--style",
      "image-style:ink-storefront",
      "--prompt",
      "A florist named Luna Floral",
      "--compile",
    ]);

    const stdout = mockConsoleLog.mock.calls.flat().join("\n");
    expect(stdout).toContain(
      "# Okou generate image prompt compile image-style:ink-storefront",
    );
    expect(stdout).toContain("image prompt-compilation packet");
    expect(stdout).toContain("## Selected Image Style");
    expect(stdout).toContain("image-style:ink-storefront");
    expect(stdout).toContain("Single-color hand-drawn ink fineliner");
    expect(stdout).not.toContain("portrait 1024x1536");
    expect(stdout).toContain("## Style Source");
    expect(stdout).toContain("vm0-ai/vm0-skills");
    expect(stdout).toContain("ink-storefront");
    expect(stdout).toContain("## Prompt Compiler Task");
    expect(stdout).toContain("If unavailable, stop without generating");
    expect(stdout).toContain("references, examples, and templates");
    expect(stdout).toContain(
      "Return only the compiled prompt text when preparing the next command",
    );
    expect(stdout).toContain("## Artifact Output Model");
    expect(stdout).toContain("## Requested Parameters");
    expect(stdout.indexOf("## Prompt Compiler Task")).toBeLessThan(
      stdout.indexOf("## Artifact Output Model"),
    );
    expect(stdout.indexOf("## Artifact Output Model")).toBeLessThan(
      stdout.indexOf("## Requested Parameters"),
    );
    expect(stdout).toContain("Requested size: 1024x1024");
    expect(stdout).toContain("Source image URLs: none");
    expect(stdout).toContain("## Image Authoring Rules");
    expect(stdout).not.toContain("## Parameter Precedence");
    expect(stdout).toContain("CLI fallback values last");
    expect(stdout).toContain(
      "`--background` accepts only `auto`, `opaque`, or `transparent`",
    );
    expect(stdout).toContain("--compiled-prompt");
  });

  it("should keep style compilation on the run default unless a model is explicit", async () => {
    vi.stubEnv(DEFAULT_IMAGE_MODEL_ENV, "seedream4");
    await generateCommand.parseAsync([
      "node",
      "cli",
      "image",
      "--style",
      "image-style:ink-storefront",
      "--prompt",
      "A florist named Luna Floral",
      "--compile",
    ]);

    const implicitStdout = mockConsoleLog.mock.calls.flat().join("\n");
    expect(implicitStdout).toContain(
      "Run default model if direct image generation is used: seedream4; omit --model so the server applies it",
    );
    expect(implicitStdout).not.toContain(
      "Model preference if direct image generation is used: gpt-image-1",
    );

    mockConsoleLog.mockClear();
    await generateCommand.parseAsync([
      "node",
      "cli",
      "image",
      "--style",
      "image-style:ink-storefront",
      "--prompt",
      "A florist named Luna Floral",
      "--compile",
      "--model",
      "qwen-image",
    ]);

    const explicitStdout = mockConsoleLog.mock.calls.flat().join("\n");
    expect(explicitStdout).toContain(
      "Explicit model if direct image generation is used: qwen-image",
    );
    expect(explicitStdout).not.toContain(
      "Run default model if direct image generation is used",
    );
  });

  it.each(["ink-storefront", "emboss-deboss"])(
    "prints an R2-backed style packet for %s",
    async (slug) => {
      await generateCommand.parseAsync([
        "node",
        "cli",
        "image",
        "--style",
        `image-style:${slug}`,
        "--style-source",
        "r2",
        "--prompt",
        "A florist named Luna Floral",
        "--compile",
      ]);

      const stdout = mockConsoleLog.mock.calls.flat().join("\n");
      expect(stdout).toContain(`Registry resource: \`image-style:${slug}\``);
      expect(stdout).toContain(
        `okou resource pull image-style:${slug} --dir ./generated/resources`,
      );
      expect(stdout).toContain(
        `./generated/resources/illustration-template/${slug}`,
      );
    },
  );

  it("should fail with mode guidance when no image prompt mode is selected", async () => {
    await expect(async () => {
      await generateCommand.parseAsync([
        "node",
        "cli",
        "image",
        "--prompt",
        "Anything",
      ]);
    }).rejects.toThrow("process.exit called");

    const stderr = mockConsoleError.mock.calls.flat().join("\n");
    expect(stderr).toContain("Choose one image prompt mode");
    expect(stderr).toContain("--compiled-prompt");
    expect(stderr).toContain("--raw-prompt");
    expect(stderr).toContain("image-style:notion-illustration");
    expect(stderr).toContain("image-style:vm0-illustration");
  });

  it("should reject compile mode without a prompt", async () => {
    await expect(async () => {
      await generateCommand.parseAsync([
        "node",
        "cli",
        "image",
        "--style",
        "image-style:notion-illustration",
        "--compile",
      ]);
    }).rejects.toThrow("process.exit called");

    const stderr = mockConsoleError.mock.calls.flat().join("\n");
    expect(stderr).toContain(
      "--compile requires --prompt <text> or piped stdin",
    );
  });

  it("should fail with style listing when --style id is unknown", async () => {
    await expect(async () => {
      await generateCommand.parseAsync([
        "node",
        "cli",
        "image",
        "--style",
        "image-style:does-not-exist",
        "--prompt",
        "Anything",
        "--compile",
      ]);
    }).rejects.toThrow("process.exit called");

    const stderr = mockConsoleError.mock.calls.flat().join("\n");
    expect(stderr).toContain("Unknown image style: image-style:does-not-exist");
    expect(stderr).toContain("image-style:notion-illustration");
  });

  it("should reject --style without --compile", async () => {
    await expect(async () => {
      await generateCommand.parseAsync([
        "node",
        "cli",
        "image",
        "--style",
        "image-style:notion-illustration",
        "--prompt",
        "Anything",
      ]);
    }).rejects.toThrow("process.exit called");

    const stderr = mockConsoleError.mock.calls.flat().join("\n");
    expect(stderr).toContain("--style can only be used with --compile");
  });

  it.each([IMAGE_RESULT.url, "/artifacts/abcxyz1234.png"])(
    "waits for an async generation and prints a complete URL for %s",
    async (url) => {
      vi.stubEnv("OKOU_APP_URL", "https://app.okou.ai");
      const expectedUrl = url.startsWith("/artifacts/")
        ? `https://app.okou.ai${url}`
        : url;
      let statusRequested = false;
      server.use(
        http.post(IMAGE_URL, () => {
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
        http.get(IMAGE_STATUS_URL, ({ request }) => {
          statusRequested = true;
          expect(request.headers.get("authorization")).toBe(
            "Bearer test-token",
          );
          return HttpResponse.json({
            generationId: IMAGE_GENERATION_ID,
            type: "image",
            status: "completed",
            result: { ...IMAGE_RESULT, url },
            createdAt: "2026-05-15T00:00:00.000Z",
            startedAt: "2026-05-15T00:00:01.000Z",
            completedAt: "2026-05-15T00:00:02.000Z",
          });
        }),
      );

      await generateCommand.parseAsync([
        "node",
        "cli",
        "image",
        "--raw-prompt",
        "Async please",
      ]);

      const stdout = mockConsoleLog.mock.calls.flat().join("\n");
      expect(statusRequested).toBe(true);
      expect(stdout).toContain(`Image generated: ${expectedUrl}`);
      expect(stdout).toContain(`![${IMAGE_RESULT.filename}](<${expectedUrl}>)`);
    },
  );

  it("should explain an async output safety block with manual retry guidance", async () => {
    let statusRequested = false;
    server.use(
      http.post(IMAGE_URL, () => {
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
        statusRequested = true;
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

    await expect(async () => {
      await generateCommand.parseAsync([
        "node",
        "cli",
        "image",
        "--raw-prompt",
        "A safe landscape",
      ]);
    }).rejects.toThrow("process.exit called");

    expect(statusRequested).toBe(true);
    const stderr = mockConsoleError.mock.calls.flat().join("\n");
    expect(stderr).toContain("Generated image blocked");
    expect(stderr).toContain(
      "Try again once. If it is blocked again, change the prompt or reference image before retrying.",
    );
    expect(stderr).not.toContain("Generation failed");
    expect(stderr).not.toContain("500");
  });

  it.each([
    {
      caseName: "input safety rejection",
      code: "GENERATION_INPUT_SAFETY_REJECTED",
      message:
        "The prompt or reference image was blocked by the safety filter.",
      title: "Image request blocked",
      guidance:
        "Change the prompt or reference image before trying again. Retrying the unchanged request is unlikely to help.",
    },
    {
      caseName: "unreachable input image",
      code: "GENERATION_INPUT_MEDIA_UNREACHABLE",
      message:
        "An input image could not be downloaded by the generation provider.",
      title: "Input image unavailable",
      guidance:
        "Use a public URL that returns the image directly without authentication or a browser challenge, then try again.",
    },
    {
      caseName: "invalid input image",
      code: "GENERATION_INPUT_MEDIA_INVALID",
      message: "An input image could not be read by the generation provider.",
      title: "Input image invalid",
      guidance:
        "Replace or re-encode the image in a supported format, then try again.",
    },
    {
      caseName: "invalid generation parameters",
      code: "GENERATION_INVALID_PARAMETERS",
      message: "The image generation request contains invalid parameters.",
      title: "Invalid image generation options",
      guidance: "Correct the image generation parameters before trying again.",
    },
    {
      caseName: "unavailable generation provider",
      code: "GENERATION_PROVIDER_UNAVAILABLE",
      message: "The image generation provider is temporarily unavailable.",
      title: "Image provider unavailable",
      guidance:
        "The image generation provider is temporarily unavailable. Please try again shortly.",
    },
  ])(
    "should explain an async $caseName with actionable guidance",
    async ({ code, message, title, guidance }) => {
      server.use(
        http.post(IMAGE_URL, () => {
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

      await expect(async () => {
        await generateCommand.parseAsync([
          "node",
          "cli",
          "image",
          "--raw-prompt",
          "A safe landscape",
        ]);
      }).rejects.toThrow("process.exit called");

      const stderr = mockConsoleError.mock.calls.flat().join("\n");
      expect(stderr).toContain(title);
      expect(stderr).toContain(guidance);
      expect(stderr).not.toContain("Generation failed");
      expect(stderr).not.toContain("Unexpected status code");
    },
  );

  it("should describe image generation model capabilities in help", () => {
    let helpOutput = "";
    imageCommand.configureOutput({
      writeOut: (str: string) => {
        helpOutput += str;
      },
    });

    imageCommand.outputHelp();
    const normalizedHelpOutput = helpOutput.replace(/\s+/g, " ");

    expect(helpOutput).toContain("gpt-image-2");
    expect(helpOutput).toContain("gpt-image-2.5-flare");
    expect(helpOutput).toContain("gpt-image-2.5-sunburst");
    expect(normalizedHelpOutput).toContain("xhigh and max");
    expect(helpOutput).toContain("gpt-image-1 (default)");
    expect(helpOutput).toContain("flux-pro-1.1");
    expect(helpOutput).toContain("qwen-image");
    expect(helpOutput).toContain("nano-banana-2");
    expect(helpOutput).toContain("seedream5-pro");
    expect(helpOutput).toContain("seedream5-lite");
    expect(normalizedHelpOutput).toContain("support varies");
    expect(helpOutput).toContain("3840x2160");
    expect(helpOutput).toContain("edges divisible by 16");
    expect(helpOutput).toContain("--compression <0-100>");
    expect(helpOutput).toContain("Moderation strictness: auto or low");
    expect(helpOutput).toContain(
      "Uses OpenAI, fal.ai, and BytePlus for built-in image model execution",
    );
    expect(helpOutput).toContain("--seed");
    expect(helpOutput).toContain("--safety-tolerance");
    expect(helpOutput).toContain("--image-url");
    expect(helpOutput).toContain("--image-prompt-strength");
    expect(helpOutput).toContain(
      "Nano Banana 2 models and Seedream 5 Lite accept up to 14",
    );
    expect(helpOutput).toContain("qwen-image-3");
    expect(helpOutput).toContain("nano-banana-2-lite");
    expect(helpOutput).toContain("flux-2-pro");
    expect(helpOutput).toContain("ideogram-4");
    expect(helpOutput).toContain("--style <id>");
    expect(helpOutput).toContain("--style-source <source>");
    expect(helpOutput).toContain("--compile");
    expect(helpOutput).toContain("--compiled-prompt");
    expect(helpOutput).toContain("--raw-prompt");

    expect(helpOutput).toContain("--json");

    expect(helpOutput).toContain("provider");
    expect(helpOutput).toContain("default");
    expect(helpOutput).toContain("Provider: 'built-in' to run Okou's pipeline");
    expect(helpOutput).toContain("not support transparent");
    expect(helpOutput).toContain("backgrounds");
    expect(helpOutput).toContain("Image-to-image");
    expect(helpOutput).toContain("Image Styles:");
    expect(helpOutput).toContain("image-style:notion-illustration");
    expect(helpOutput).toContain("Notion-editorial-style hand-drawn");
    expect(helpOutput).toContain("image-style:vm0-illustration");
    expect(helpOutput).toContain("Generate Okou in-app");
    expect(helpOutput).toContain("image-style:flat-poster");
    expect(helpOutput).toContain(
      "an optional short wordmark supplied by the user",
    );
    expect(helpOutput).toContain("omitted when none is supplied");
  });

  it("should surface API errors", async () => {
    server.use(
      http.post(IMAGE_URL, () => {
        return HttpResponse.json(
          {
            error: {
              message: "Not enough credits",
              code: "INSUFFICIENT_CREDITS",
            },
          },
          { status: 402 },
        );
      }),
    );

    await expect(async () => {
      await generateCommand.parseAsync([
        "node",
        "cli",
        "image",
        "--raw-prompt",
        "hello",
      ]);
    }).rejects.toThrow("process.exit called");

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("Credits depleted"),
    );
  });
});
