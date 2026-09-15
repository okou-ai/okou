import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HttpResponse, http } from "msw";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";

import { server } from "../../../mocks/server";
import { socialCommand } from "../index";

type Collection =
  | null
  | {
      readonly state: "complete";
      readonly itemsReturned: number;
      readonly reportedTotal?: number;
    }
  | {
      readonly state: "provider_limited";
      readonly itemsReturned: number;
      readonly reason?: string;
      readonly uncertainty?: { readonly reason: "unreliable_empty_result" };
      readonly reportedTotal?: number;
    }
  | {
      readonly state: "more";
      readonly itemsReturned: number;
      readonly reportedTotal?: number;
      readonly nextInput:
        | { readonly cursor: string }
        | { readonly page: number };
    };

function socialResponse(
  tool: string,
  collection: Collection,
  result: Readonly<Record<string, unknown>>,
  billingQuantity = 1,
) {
  return {
    provider: "socialkit",
    tool,
    billingCategory: "request",
    billingQuantity,
    creditsCharged: billingQuantity * 3,
    collection,
    result,
  };
}

function collectionResult(tool: string): Readonly<Record<string, unknown>> {
  switch (tool) {
    case "linkedin_company_posts": {
      return { posts: [] };
    }
    case "twitter_tweets": {
      return { tweets: [], nextCursor: null };
    }
    case "instagram_channel_posts":
    case "instagram_channel_reels":
    case "instagram_reels_search": {
      return { items: [], hasMore: false };
    }
    case "facebook_comments":
    case "instagram_comments":
    case "tiktok_comments":
    case "youtube_comments": {
      return { comments: [], hasMore: false };
    }
    case "tiktok_channel_videos":
    case "tiktok_hashtag_search":
    case "tiktok_search":
    case "youtube_search":
    case "youtube_videos": {
      return { results: [], hasMore: false };
    }
    default: {
      throw new Error(`Unexpected collection tool ${tool}`);
    }
  }
}

function completedDownload() {
  return {
    downloadId: "6bdc3449-41ef-4624-a525-45bce09c67f0",
    status: "completed",
    platform: "youtube",
    quality: "720p",
    format: "mp4",
    maxDuration: 600,
    billingCategory: "request",
    provider: {
      durationSeconds: 61,
      fileSizeMB: 2,
      creditsCost: 2,
      title: "Example",
    },
    billing: { quantity: 2, creditsCharged: 6 },
    artifact: {
      id: "e5932cce-3ec7-45ef-a96d-2e4c5dcb4cd4",
      url: "https://artifacts.example/video.mp4",
      filename: "example.mp4",
      contentType: "video/mp4",
      sizeBytes: 2048,
    },
    error: null,
    createdAt: "2026-08-27T00:00:00.000Z",
    completedAt: "2026-08-27T00:01:00.000Z",
  };
}

function failedDownload(status: "artifact_failed" | "provider_failed") {
  const billed = status === "artifact_failed";
  return {
    ...completedDownload(),
    status,
    provider: billed
      ? { durationSeconds: 61, fileSizeMB: 2, creditsCost: 2 }
      : null,
    billing: billed ? { quantity: 2, creditsCharged: 6 } : null,
    artifact: null,
    error: {
      code: billed
        ? "ARTIFACT_MATERIALIZATION_FAILED"
        : "SOCIALKIT_DOWNLOAD_FAILED",
      message: billed
        ? "The artifact could not be materialized"
        : "SocialKit could not prepare the download",
      retryable: billed,
      billed,
    },
    completedAt: billed ? null : "2026-08-27T00:01:00.000Z",
  };
}

describe("okou social command", () => {
  const originalExitCode = process.exitCode;
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});
  const mockStderrWrite = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((() => {
      return true;
    }) as never);
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);

  beforeEach(() => {
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("OKOU_TOKEN", "test-okou-token");
    for (const command of socialCommand.commands) {
      command.setOptionValue("json", undefined);
      command.setOptionValue("output", undefined);
      command.setOptionValue("select", undefined);
      command.setOptionValue("overwrite", undefined);
      command.setOptionValue("thread", undefined);
      command.setOptionValue("fullDetails", undefined);
      command.setOptionValue("requireViews", undefined);
      command.setOptionValue("kind", undefined);
      command.setOptionValue("limit", 10);
      command.setOptionValue("stream", undefined);
      command.setOptionValue("checkpoint", undefined);
      command.setOptionValue("platform", undefined);
      command.setOptionValue("hashtag", undefined);
      command.setOptionValue("sort", undefined);
      command.setOptionValue("date", undefined);
      command.setOptionValue("type", undefined);
      command.setOptionValue("prompt", undefined);
      command.setOptionValue("refresh", undefined);
      command.setOptionValue("fields", undefined);
      command.setOptionValue("fieldsFile", undefined);
      command.setOptionValue("maxDuration", undefined);
      command.setOptionValue("quality", undefined);
      command.setOptionValue("format", undefined);
      command.setOptionValue("resume", undefined);
      command.setOptionValue("cursor", undefined);
      command.setOptionValue("status", undefined);
      if (command.name() === "downloads") {
        command.setOptionValue("limit", 20);
      }
    }
  });

  afterEach(() => {
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    mockStderrWrite.mockClear();
    mockExit.mockClear();
    process.exitCode = originalExitCode;
    vi.unstubAllEnvs();
  });

  afterAll(() => {
    mockConsoleLog.mockRestore();
    mockConsoleError.mockRestore();
    mockStderrWrite.mockRestore();
    mockExit.mockRestore();
  });

  function output(): string {
    return mockConsoleLog.mock.calls.flat().join("\n");
  }

  describe("research export", () => {
    let directory: string;

    beforeEach(async () => {
      directory = await mkdtemp(join(tmpdir(), "okou-social-export-"));
    });

    afterEach(async () => {
      await rm(directory, { recursive: true, force: true });
    });

    const commentsArgs = [
      "node",
      "okou",
      "comments",
      "https://instagram.com/p/example",
    ];

    function serveRows(rows: readonly unknown[], collection?: Collection) {
      const requests: unknown[] = [];
      server.use(
        http.post(
          "http://localhost:3000/api/social/request",
          async ({ request }) => {
            requests.push(await request.json());
            return HttpResponse.json(
              socialResponse(
                "instagram_comments",
                collection ?? {
                  state: "complete",
                  itemsReturned: rows.length,
                },
                { comments: rows, commentCount: rows.length },
              ),
            );
          },
        ),
      );
      return requests;
    }

    function serveTranscript(
      data: Readonly<Record<string, unknown>>,
      creditsCharged = 0,
    ) {
      const requests: unknown[] = [];
      server.use(
        http.post(
          "http://localhost:3000/api/social/request",
          async ({ request }) => {
            requests.push(await request.json());
            return HttpResponse.json({
              ...socialResponse("youtube_transcript", null, data),
              creditsCharged,
            });
          },
        ),
      );
      return requests;
    }

    const transcriptArgs = [
      "node",
      "okou",
      "transcript",
      "https://youtu.be/example",
    ];

    it.each([
      {
        name: "full text without duplicating segments",
        data: {
          transcript: "你好 & <b>世界</b>\r\nA second line.\n",
          transcriptSegments: [
            { text: "Duplicated segment", start: 0, duration: 2 },
          ],
          language: "zh",
        },
        expected: "你好 & <b>世界</b>\r\nA second line.\n",
      },
      {
        name: "untimed segment text when the full transcript is absent",
        data: {
          transcriptSegments: [
            { text: "你好 🌍" },
            { text: "Une autre ligne\nAnd another" },
          ],
          language: "zh",
        },
        expected: "你好 🌍\nUne autre ligne\nAnd another\n",
      },
      {
        name: "segment text when the full transcript is blank",
        data: {
          transcript: " \n",
          transcriptSegments: [{ text: "Available text" }],
          language: "zh",
        },
        expected: "Available text\n",
      },
    ])(
      "exports $name as plain text with a separate receipt",
      async ({ data, expected }) => {
        const requests = serveTranscript(data);
        const path = join(directory, "transcript.txt");
        await socialCommand.parseAsync([
          ...transcriptArgs,
          "--format",
          "text",
          "--output",
          path,
          "--json",
        ]);
        expect(await readFile(path, "utf8")).toBe(expected);
        expect(JSON.parse(output()) as unknown).toMatchObject({
          kind: "export",
          status: "complete",
          operation: "transcript",
          collection: null,
          billing: { quantity: 1, creditsCharged: 0 },
          warnings: [],
          export: { path, format: "text", language: "zh", visibility: "local" },
        });
        expect(JSON.parse(output()) as unknown).not.toHaveProperty("data");
        expect(requests).toEqual([
          {
            tool: "youtube_transcript",
            input: { url: "https://youtu.be/example" },
          },
        ]);
        expect(await readdir(directory)).toEqual(["transcript.txt"]);
      },
    );

    it.each([
      {
        format: "srt",
        expected:
          "1\n00:00:00,000 --> 00:00:01,235\n你好 & <b>世界</b>\nLine --> next\n\n2\n00:00:01,000 --> 00:00:02,000\nOverlap 🌍\n\n3\n00:01:00,000 --> 00:01:00,500\nMinute carry\n\n4\n25:01:01,234 --> 25:01:03,579\nLong video\n\n",
      },
      {
        format: "vtt",
        expected:
          "WEBVTT\n\n1\n00:00:00.000 --> 00:00:01.235\n你好 &amp; &lt;b&gt;世界&lt;/b&gt;\nLine --&gt; next\n\n2\n00:00:01.000 --> 00:00:02.000\nOverlap 🌍\n\n3\n00:01:00.000 --> 00:01:00.500\nMinute carry\n\n4\n25:01:01.234 --> 25:01:03.579\nLong video\n\n",
      },
    ])(
      "exports valid $format cues with precise timing and format-specific multiline text",
      async ({ format, expected }) => {
        const requests = serveTranscript({
          transcript: "Full text must not be duplicated in subtitles",
          language: "zh",
          transcriptSegments: [
            {
              text: "你好 & <b>世界</b>\r\n \r\nLine --> next\r",
              start: 0,
              duration: 1.23456,
            },
            { text: "Overlap 🌍", start: 1.0004, duration: 0.9996 },
            { text: "Minute carry", start: 59.9996, duration: 0.5 },
            { text: "Long video", start: 90061.234, duration: 2.345 },
          ],
        });
        const path = join(directory, `captions.${format}`);
        await socialCommand.parseAsync([
          ...transcriptArgs,
          "--format",
          format,
          "--output",
          path,
        ]);
        expect(await readFile(path, "utf8")).toBe(expected);
        expect(JSON.parse(output()) as unknown).toMatchObject({
          kind: "export",
          status: "complete",
          warnings: [],
          billing: { quantity: 1, creditsCharged: 0 },
          export: { format, language: "zh" },
        });
        expect(output()).not.toContain("Full text must not");
        expect(requests).toHaveLength(1);
        expect(await readdir(directory)).toEqual([`captions.${format}`]);
      },
    );

    it("keeps quotes and entity-looking source text literal in WebVTT", async () => {
      const requests = serveTranscript({
        transcriptSegments: [
          {
            text: `"你好" &amp; <b>world</b>\u00a0's 🌍`,
            start: 0,
            duration: 1,
          },
        ],
      });
      const path = join(directory, "captions.vtt");
      await socialCommand.parseAsync([
        ...transcriptArgs,
        "--format",
        "vtt",
        "--output",
        path,
        "--json",
      ]);
      expect(await readFile(path, "utf8")).toBe(
        `WEBVTT\n\n1\n00:00:00.000 --> 00:00:01.000\n"你好" &amp;amp; &lt;b&gt;world&lt;/b&gt;&nbsp;'s 🌍\n\n`,
      );
      expect(JSON.parse(output()) as unknown).toMatchObject({
        kind: "export",
        export: { format: "vtt" },
      });
      expect(requests).toHaveLength(1);
      expect(await readdir(directory)).toEqual(["captions.vtt"]);
    });

    it.each([
      "00:00:10,000 --> 00:00:11,000",
      "00:00:10.000 --> 00:00:11.000",
      "\t0:0:10,0-->0:0:11,0",
    ])(
      "rejects ambiguous SRT cue text without replacing the file or repeating extraction: %s",
      async (timingLine) => {
        const data = {
          transcriptSegments: [
            {
              text: `Before\r\n${timingLine}\r\nAfter`,
              start: 1,
              duration: 4,
            },
          ],
        };
        const requests = serveTranscript(data, 3);
        const path = join(directory, "captions.srt");
        await writeFile(path, "original");
        await socialCommand.parseAsync([
          ...transcriptArgs,
          "--format",
          "srt",
          "--output",
          path,
          "--overwrite",
          "--json",
        ]);
        expect(process.exitCode).toBe(1);
        expect(await readFile(path, "utf8")).toBe("original");
        expect(JSON.parse(output()) as unknown).toMatchObject({
          kind: "result",
          data,
          billing: { quantity: 1, creditsCharged: 3 },
        });
        expect(errorOutput()).toContain(
          "SRT readers can interpret as another cue",
        );
        expect(errorOutput()).toContain("--format vtt");
        expect(errorOutput()).toContain("without repeating the Social request");
        expect(requests).toHaveLength(1);
        expect(await readdir(directory)).toEqual(["captions.srt"]);
      },
    );

    it.each([
      {
        format: "text",
        expected: "Before\n00:00:10,000 --> 00:00:11,000\nAfter\n",
      },
      {
        format: "vtt",
        expected:
          "WEBVTT\n\n1\n00:00:01.000 --> 00:00:05.000\nBefore\n00:00:10,000 --&gt; 00:00:11,000\nAfter\n\n",
      },
    ])(
      "preserves literal timing lines when exporting $format",
      async ({ format, expected }) => {
        const requests = serveTranscript({
          transcriptSegments: [
            {
              text: "Before\n00:00:10,000 --> 00:00:11,000\nAfter",
              start: 1,
              duration: 4,
            },
          ],
        });
        const path = join(directory, `transcript.${format}`);
        await socialCommand.parseAsync([
          ...transcriptArgs,
          "--format",
          format,
          "--output",
          path,
          "--json",
        ]);
        expect(await readFile(path, "utf8")).toBe(expected);
        expect(JSON.parse(output()) as unknown).toMatchObject({
          kind: "export",
          export: { format },
        });
        expect(requests).toHaveLength(1);
        expect(await readdir(directory)).toEqual([`transcript.${format}`]);
      },
    );

    it.each([
      { name: "missing segments", segments: undefined },
      { name: "empty segments", segments: [] },
      {
        name: "display timestamp without timing",
        segments: [{ text: "One", timestamp: "00:00:01" }],
      },
      { name: "missing start", segments: [{ text: "One", duration: 1 }] },
      {
        name: "missing duration",
        segments: [
          { text: "One", start: 0 },
          { text: "Two", start: 2, duration: 1 },
        ],
      },
      {
        name: "zero duration",
        segments: [{ text: "One", start: 0, duration: 0 }],
      },
      {
        name: "unsafe start",
        segments: [
          { text: "One", start: Number.MAX_SAFE_INTEGER, duration: 1 },
        ],
      },
      {
        name: "overflowed end",
        segments: [{ text: "One", start: 1, duration: Number.MAX_VALUE }],
      },
      {
        name: "rounded zero interval",
        segments: [{ text: "One", start: 0, duration: 0.0001 }],
      },
      {
        name: "decreasing source starts within the same millisecond",
        segments: [
          { text: "One", start: 1.0004, duration: 1 },
          { text: "Two", start: 1.0003, duration: 1 },
        ],
      },
      { name: "missing text", segments: [{ start: 0, duration: 1 }] },
      {
        name: "blank text",
        segments: [{ text: " \n\t", start: 0, duration: 1 }],
      },
      {
        name: "NUL cue text",
        segments: [{ text: "One\0Two", start: 0, duration: 1 }],
      },
    ])(
      "recovers the billed result after rejecting $name without publishing subtitles",
      async ({ segments }) => {
        const data = {
          transcript: "Save this existing text",
          transcriptSegments: segments,
        };
        const requests = serveTranscript(data);
        await socialCommand.parseAsync([
          ...transcriptArgs,
          "--format",
          "srt",
          "--output",
          join(directory, "captions.srt"),
          "--json",
        ]);
        expect(process.exitCode).toBe(1);
        expect(JSON.parse(output()) as unknown).toMatchObject({
          kind: "result",
          data: { transcript: "Save this existing text" },
          billing: { quantity: 1, creditsCharged: 0 },
        });
        const error = errorOutput();
        expect(error).toContain("--format text");
        expect(error).toContain(
          "recovered stdout JSON without repeating the Social request",
        );
        expect(requests).toHaveLength(1);
        expect(await readdir(directory)).toEqual([]);
      },
    );

    it.each([
      { text: "One", start: -1, duration: 1 },
      { text: "One", start: 0, duration: -1 },
      { text: "One", start: null, duration: 1 },
      { text: "One", start: 0, duration: "1" },
    ])(
      "rejects an invalid API transcript before subtitle publication: %j",
      async (segment) => {
        const requests = serveTranscript({ transcriptSegments: [segment] });
        await expect(
          socialCommand.parseAsync([
            ...transcriptArgs,
            "--format",
            "srt",
            "--output",
            join(directory, "captions.srt"),
            "--json",
          ]),
        ).rejects.toThrow("process.exit called");
        expect(mockExit).toHaveBeenCalledWith(1);
        expect(JSON.parse(errorOutput()) as unknown).toMatchObject({
          status: "error",
          error: {
            message: "Okou Social returned an inconsistent result",
            retryable: false,
          },
        });
        expect(output()).toBe("");
        expect(requests).toHaveLength(1);
        expect(await readdir(directory)).toEqual([]);
      },
    );

    it.each([
      {},
      { transcript: " \n", transcriptSegments: [] },
      { transcriptSegments: [{ text: " \n" }] },
      { transcriptSegments: [{ text: "One" }, {}] },
    ])(
      "rejects unusable plain text without publishing an empty or incomplete file: %j",
      async (data) => {
        const requests = serveTranscript(data);
        await socialCommand.parseAsync([
          ...transcriptArgs,
          "--format",
          "text",
          "--output",
          join(directory, "transcript.txt"),
          "--json",
        ]);
        expect(process.exitCode).toBe(1);
        expect(JSON.parse(output()) as unknown).toMatchObject({
          kind: "result",
          data,
        });
        expect(errorOutput()).toContain("Retrieved results are on stdout");
        expect(requests).toHaveLength(1);
        expect(await readdir(directory)).toEqual([]);
      },
    );

    it.each([
      ["transcript", "text", "missing-output"],
      ["transcript", "srt", "selection"],
      ["transcript", "vtt", "blank-output"],
      ["inspect", "text", "unsupported"],
      ["comments", "srt", "unsupported"],
      ["summarize", "vtt", "unsupported"],
    ])(
      "rejects %s %s with %s before files or requests",
      async (command, format, combination) => {
        const requests = serveTranscript({ transcript: "One" });
        const args = [
          "node",
          "okou",
          command,
          "https://youtu.be/example",
          "--format",
          format,
          "--json",
        ];
        if (combination !== "missing-output")
          args.push(
            "--output",
            combination === "blank-output" ? " " : join(directory, "file"),
          );
        if (combination === "selection") args.push("--select", "transcript");
        await expect(socialCommand.parseAsync(args)).rejects.toThrow(
          "process.exit called",
        );
        expect(JSON.parse(errorOutput()) as unknown).toMatchObject({
          status: "error",
          error: { kind: "invalid_input" },
        });
        expect(requests).toHaveLength(0);
        expect(await readdir(directory)).toEqual([]);
      },
    );

    it("requires explicit overwrite for an existing subtitle file before requesting a transcript", async () => {
      const requests = serveTranscript({
        transcriptSegments: [{ text: "One", start: 0, duration: 1 }],
      });
      const path = join(directory, "captions.vtt");
      await writeFile(path, "original");
      await expect(
        socialCommand.parseAsync([
          ...transcriptArgs,
          "--format",
          "vtt",
          "--output",
          path,
          "--json",
        ]),
      ).rejects.toThrow("process.exit called");
      expect(errorOutput()).toContain("--overwrite");
      expect(await readFile(path, "utf8")).toBe("original");
      expect(requests).toHaveLength(0);
      expect(await readdir(directory)).toEqual(["captions.vtt"]);
    });

    it("preserves an existing subtitle file when replacement timing is unavailable", async () => {
      const requests = serveTranscript({ transcript: "Text only" });
      const path = join(directory, "captions.vtt");
      await writeFile(path, "original");
      await socialCommand.parseAsync([
        ...transcriptArgs,
        "--format",
        "vtt",
        "--output",
        path,
        "--overwrite",
        "--json",
      ]);
      expect(process.exitCode).toBe(1);
      expect(await readFile(path, "utf8")).toBe("original");
      expect(JSON.parse(output()) as unknown).toMatchObject({
        data: { transcript: "Text only" },
      });
      expect(errorOutput()).toContain("--format text");
      expect(requests).toHaveLength(1);
      expect(await readdir(directory)).toEqual(["captions.vtt"]);
    });

    it("atomically replaces an existing subtitle file with explicit overwrite", async () => {
      const requests = serveTranscript({
        transcriptSegments: [{ text: "One", start: 0, duration: 1 }],
      });
      const path = join(directory, "captions.srt");
      await writeFile(path, "original");
      await socialCommand.parseAsync([
        ...transcriptArgs,
        "--format",
        "srt",
        "--output",
        path,
        "--overwrite",
        "--json",
      ]);
      expect(await readFile(path, "utf8")).toBe(
        "1\n00:00:00,000 --> 00:00:01,000\nOne\n\n",
      );
      expect(requests).toHaveLength(1);
      expect(await readdir(directory)).toEqual(["captions.srt"]);
    });

    it("exports ordered JSON fields while preserving context, metadata, null, false, and zero", async () => {
      const requests = serveRows([
        {
          id: "one",
          author: { name: "作者" },
          views: null,
          liked: false,
          likes: 0,
          tags: ["a", "b"],
          extra: "omit",
        },
        { id: "two", likes: 1 },
      ]);
      const path = join(directory, "results.json");
      await socialCommand.parseAsync([
        ...commentsArgs,
        "--output",
        path,
        "--select",
        "author.name,id,views,liked,likes,tags,missing",
        "--json",
      ]);
      const saved = await readFile(path, "utf8");
      expect(saved.split("\n")).toHaveLength(2);
      expect(JSON.parse(saved) as unknown).toMatchObject({
        kind: "result",
        status: "complete",
        operation: "comments",
        platform: "instagram",
        data: {
          items: [
            {
              "author.name": "作者",
              id: "one",
              views: null,
              liked: false,
              likes: 0,
              tags: ["a", "b"],
            },
            { id: "two", likes: 1 },
          ],
          context: { commentCount: 2 },
        },
        billing: { creditsCharged: 3 },
        warnings: [],
      });
      expect(saved).not.toContain('"extra"');
      expect(saved).not.toContain('"missing"');
      expect(JSON.parse(output()) as unknown).toMatchObject({
        kind: "export",
        status: "complete",
        billing: { creditsCharged: 3 },
        export: {
          path,
          format: "json",
          visibility: "local",
          guidance: expect.stringContaining("web upload-file"),
        },
      });
      expect(JSON.parse(output()) as unknown).not.toHaveProperty("data");
      expect(requests).toHaveLength(1);
      expect(await readdir(directory)).toEqual(["results.json"]);
      if (process.platform !== "win32")
        expect((await stat(path)).mode & 0o777).toBe(0o600);
    });

    it("writes CSV with ordered columns, quoted Unicode/newlines, nested JSON, and formula protection", async () => {
      serveRows([
        {
          text: '你好,"world"\r\nnext',
          nested: { ok: true },
          tags: ["一", "二"],
          value: null,
          count: 0,
          active: false,
          formula: "=1+1",
        },
        {
          text: "",
          nested: [1, 2],
          tags: [],
          count: -2,
          active: true,
          formula: " \t@SUM(A1)",
        },
      ]);
      const path = join(directory, "research.csv");
      await socialCommand.parseAsync([
        ...commentsArgs,
        "--format",
        "csv",
        "--output",
        path,
        "--select",
        "text,nested,tags,value,missing,count,active,formula",
      ]);
      expect(await readFile(path, "utf8")).toBe(
        '"text","nested","tags","value","missing","count","active","formula"\r\n' +
          '"你好,""world""\r\nnext","{""ok"":true}","[""一"",""二""]",null,,0,false,"\'=1+1"\r\n' +
          '"","[1,2]","[]",,,-2,true,"\' \t@SUM(A1)"\r\n',
      );
      expect(JSON.parse(output()) as unknown).toMatchObject({
        kind: "export",
        billing: { creditsCharged: 3 },
      });
    });

    it("exports only own properties when a selected name also exists on the prototype", async () => {
      serveRows([
        { id: "inherited" },
        { id: "own", toString: "provider value" },
      ]);
      const path = join(directory, "properties.csv");
      await socialCommand.parseAsync([
        ...commentsArgs,
        "--output",
        path,
        "--format",
        "csv",
        "--select",
        "toString,id",
        "--json",
      ]);
      expect(await readFile(path, "utf8")).toBe(
        '"toString","id"\r\n,"inherited"\r\n"provider value","own"\r\n',
      );
      expect(JSON.parse(output()) as unknown).toMatchObject({
        kind: "export",
        status: "complete",
      });
      expect(errorOutput()).toBe("");
    });

    it.each(["json", "csv"])(
      "exports accepted results and accounting after a later page fails (%s)",
      async (format) => {
        const requests: unknown[] = [];
        server.use(
          http.post(
            "http://localhost:3000/api/social/request",
            async ({ request }) => {
              requests.push(await request.json());
              if (requests.length === 1)
                return HttpResponse.json(
                  socialResponse(
                    "instagram_comments",
                    {
                      state: "more",
                      itemsReturned: 1,
                      nextInput: { cursor: "next" },
                      reportedTotal: 20,
                    },
                    {
                      comments: [
                        { id: "accepted", text: "saved", extra: "unselected" },
                      ],
                    },
                    2,
                  ),
                );
              return HttpResponse.json(
                {
                  error: {
                    code: "SOCIALKIT_UPSTREAM_ERROR",
                    message: "Page failed",
                    reason: "upstream_failure",
                    retryable: false,
                  },
                },
                { status: 502 },
              );
            },
          ),
        );
        const path = join(directory, `partial.${format}`);
        await socialCommand.parseAsync([
          ...commentsArgs,
          "--output",
          path,
          "--format",
          format,
          "--select",
          "text,id",
          "--json",
        ]);
        const receipt: unknown = JSON.parse(output());
        expect(receipt).toMatchObject({
          kind: "export",
          status: "partial",
          collection: {
            state: "failed",
            itemsReturned: 1,
            nextInput: { cursor: "next" },
          },
          billing: { quantity: 2, creditsCharged: 6 },
          progress: { pages: 1, itemsReturned: 1, creditsCharged: 6 },
          error: { message: "Page failed", retryable: false },
        });
        const saved = await readFile(path, "utf8");
        if (format === "json") {
          expect(JSON.parse(saved) as unknown).toMatchObject({
            status: "partial",
            data: { items: [{ text: "saved", id: "accepted" }] },
            error: { message: "Page failed" },
          });
        } else expect(saved).toBe('"text","id"\r\n"saved","accepted"\r\n');
        expect(errorOutput()).toContain("Page failed");
        expect(process.exitCode).toBe(1);
        expect(mockExit).not.toHaveBeenCalled();
        expect(requests).toHaveLength(2);
        expect(mockConsoleLog).toHaveBeenCalledTimes(1);
      },
    );

    it("exports empty CSV headers while retaining source limitations and exit 2", async () => {
      serveRows([], {
        state: "provider_limited",
        itemsReturned: 0,
        reason: "provider_ceiling",
      });
      const path = join(directory, "empty.csv");
      await socialCommand.parseAsync([
        ...commentsArgs,
        "--format",
        "csv",
        "--output",
        path,
        "--select",
        "id,text",
        "--json",
      ]);
      expect(await readFile(path, "utf8")).toBe('"id","text"\r\n');
      expect(JSON.parse(output()) as unknown).toMatchObject({
        status: "partial",
        collection: { state: "provider_limited", itemsReturned: 0 },
        warnings: [expect.objectContaining({ code: expect.any(String) })],
        billing: { creditsCharged: 3 },
      });
      expect(process.exitCode).toBe(2);
    });

    it.each([
      ["inspect", "https://instagram.com/p/example", "instagram_stats"],
      ["transcript", "https://youtu.be/example", "youtube_transcript"],
      ["summarize", "https://youtu.be/example", "youtube_summarize"],
    ])(
      "saves single-result %s JSON without another provider request",
      async (command, url, tool) => {
        const requests: unknown[] = [];
        server.use(
          http.post(
            "http://localhost:3000/api/social/request",
            async ({ request }) => {
              requests.push(await request.json());
              return HttpResponse.json({
                ...socialResponse(tool, null, {
                  title: "Example",
                  nested: { value: 0 },
                  optional: null,
                }),
                creditsCharged: 0,
              });
            },
          ),
        );
        const path = join(directory, "single.json");
        await socialCommand.parseAsync([
          "node",
          "okou",
          command,
          url,
          "--output",
          path,
          "--select",
          "title,nested.value,optional,missing",
          ...(command === "summarize"
            ? ["--fields", '{"title":"Describe the subject"}']
            : []),
        ]);
        expect(
          JSON.parse(await readFile(path, "utf8")) as unknown,
        ).toMatchObject({
          data: { title: "Example", "nested.value": 0, optional: null },
          collection: null,
          billing: { quantity: 1, creditsCharged: 0 },
        });
        expect(requests).toHaveLength(1);
        if (command === "summarize")
          expect(requests[0]).toHaveProperty("input.custom_response", {
            title: "Describe the subject",
          });
      },
    );

    it("projects stdout JSON without losing metadata or creating a file", async () => {
      serveRows([{ id: "one", text: "omit" }]);
      await socialCommand.parseAsync([
        ...commentsArgs,
        "--select",
        "id",
        "--json",
      ]);
      expect(JSON.parse(output()) as unknown).toMatchObject({
        kind: "result",
        data: { items: [{ id: "one" }] },
        billing: { creditsCharged: 3 },
      });
      expect(output()).not.toContain("omit");
      expect(await readdir(directory)).toEqual([]);
    });

    it.each([
      ["posts", "https://www.youtube.com/@example", "youtube_videos"],
      ["search", "small business", "youtube_search"],
    ])(
      "exports normalized %s rows without sending export flags to the API",
      async (command, target, tool) => {
        const requests: unknown[] = [];
        server.use(
          http.post(
            "http://localhost:3000/api/social/request",
            async ({ request }) => {
              requests.push(await request.json());
              return HttpResponse.json(
                socialResponse(
                  tool,
                  { state: "complete", itemsReturned: 1 },
                  {
                    results: [
                      { title: "Example", url: "https://youtu.be/example" },
                    ],
                    hasMore: false,
                  },
                ),
              );
            },
          ),
        );
        const path = join(directory, "research.csv");
        await socialCommand.parseAsync([
          "node",
          "okou",
          command,
          target,
          ...(command === "search" ? ["--platform", "youtube"] : []),
          "--limit",
          "20",
          "--select",
          "title,url",
          "--format",
          "csv",
          "--output",
          path,
        ]);
        expect(await readFile(path, "utf8")).toBe(
          '"title","url"\r\n"Example","https://youtu.be/example"\r\n',
        );
        expect(requests).toEqual([
          {
            tool,
            input:
              command === "search"
                ? { query: target, limit: 20 }
                : { url: target, limit: 20 },
          },
        ]);
      },
    );

    it("writes a first-page failure envelope with no accepted billing", async () => {
      server.use(
        http.post("http://localhost:3000/api/social/request", () => {
          return HttpResponse.json(
            {
              error: {
                code: "SOCIALKIT_UPSTREAM_ERROR",
                message: "Unavailable",
              },
            },
            { status: 502 },
          );
        }),
      );
      const path = join(directory, "failure.json");
      await socialCommand.parseAsync([
        ...commentsArgs,
        "--output",
        path,
        "--select",
        "id",
        "--json",
      ]);
      expect(JSON.parse(await readFile(path, "utf8")) as unknown).toMatchObject(
        {
          status: "error",
          data: { items: [] },
          billing: null,
          progress: { pages: 0, creditsCharged: 0 },
          error: { message: "Unavailable" },
        },
      );
      expect(JSON.parse(output()) as unknown).toMatchObject({
        kind: "export",
        status: "error",
        billing: null,
      });
      expect(process.exitCode).toBe(1);
      expect(mockExit).not.toHaveBeenCalled();
      expect(await readdir(directory)).toEqual(["failure.json"]);
    });

    it("cleans staging files and keeps an overwrite target after a single-result request failure", async () => {
      const path = join(directory, "keep.json");
      await writeFile(path, "original");
      server.use(
        http.post("http://localhost:3000/api/social/request", () => {
          return HttpResponse.json(
            {
              error: {
                code: "SOCIALKIT_UPSTREAM_ERROR",
                message: "Unavailable",
              },
            },
            { status: 502 },
          );
        }),
      );
      await expect(
        socialCommand.parseAsync([
          "node",
          "okou",
          "inspect",
          "https://instagram.com/p/example",
          "--output",
          path,
          "--overwrite",
          "--json",
        ]),
      ).rejects.toThrow("process.exit called");
      expect(await readFile(path, "utf8")).toBe("original");
      expect(await readdir(directory)).toEqual(["keep.json"]);
      expect(errorOutput()).toContain("Unavailable");
      expect(output()).toBe("");
    });

    it("keeps the original default stdout envelope and formatting", async () => {
      serveRows([{ id: "one", text: "retained" }]);
      await socialCommand.parseAsync(commentsArgs);
      const result: unknown = JSON.parse(output());
      expect(result).toMatchObject({
        kind: "result",
        data: {
          items: [{ id: "one", text: "retained" }],
          context: { commentCount: 1 },
        },
        billing: { creditsCharged: 3 },
      });
      expect(output()).toBe(JSON.stringify(result, null, 2));
      expect(await readdir(directory)).toEqual([]);
    });

    it.each([
      ["--format", "yaml"],
      ["--format", "csv"],
      ["--overwrite"],
      ["--select", ""],
      ["--select", "id,id"],
      ["--select", "author..name"],
      ["--select", "items[0]"],
      ["--select", "__proto__.x"],
      ["--select", "constructor"],
      ["--select", "a.b.c.d.e.f.g.h.i"],
      ["--select", "a".repeat(129)],
      [
        "--select",
        Array.from({ length: 33 }, (_, i) => {
          return `field${i}`;
        }).join(","),
      ],
      ["--stream", "--format", "json"],
      ["--stream", "--select", "id"],
      ["--stream", "--overwrite"],
    ])(
      "rejects incompatible/invalid options before provider work: %j",
      async (...flags) => {
        const requests = serveRows([]);
        await expect(
          socialCommand.parseAsync([...commentsArgs, ...flags, "--json"]),
        ).rejects.toThrow("process.exit called");
        expect(JSON.parse(errorOutput()) as unknown).toMatchObject({
          status: "error",
          error: { kind: "invalid_input" },
        });
        expect(requests).toEqual([]);
        expect(await readdir(directory)).toEqual([]);
      },
    );

    it.each(["stream", "missing-columns", "single-csv"])(
      "rejects file export combination %s before requests or files",
      async (combination) => {
        const requests = serveRows([]);
        const path = join(directory, "results.csv");
        const args =
          combination === "single-csv"
            ? [
                "node",
                "okou",
                "inspect",
                "https://instagram.com/p/example",
                "--format",
                "csv",
                "--select",
                "id",
              ]
            : [
                ...commentsArgs,
                ...(combination === "stream"
                  ? ["--stream"]
                  : ["--format", "csv"]),
              ];
        await expect(
          socialCommand.parseAsync([...args, "--output", path, "--json"]),
        ).rejects.toThrow("process.exit called");
        expect(requests).toEqual([]);
        expect(await readdir(directory)).toEqual([]);
      },
    );

    it.each(["existing", "directory", "symlink", "missing-parent"])(
      "rejects %s destinations before billing",
      async (kind) => {
        const requests = serveRows([]);
        const target = join(directory, "target");
        const path =
          kind === "missing-parent"
            ? join(directory, "missing", "out.json")
            : join(directory, "out.json");
        if (kind === "existing") await writeFile(path, "keep");
        if (kind === "directory") await mkdir(path);
        if (kind === "symlink") {
          await writeFile(target, "keep");
          await symlink(target, path);
        }
        await expect(
          socialCommand.parseAsync([
            ...commentsArgs,
            "--output",
            path,
            ...(kind === "symlink" || kind === "directory"
              ? ["--overwrite"]
              : []),
            "--json",
          ]),
        ).rejects.toThrow("process.exit called");
        expect(errorOutput()).toContain("Cannot prepare --output");
        expect(requests).toEqual([]);
        expect(
          (await readdir(directory)).some((name) => {
            return name.endsWith(".tmp");
          }),
        ).toBe(false);
        if (kind === "existing" || kind === "symlink")
          expect(await readFile(path, "utf8")).toBe("keep");
      },
    );

    it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
      "rejects an unwritable parent before billing",
      async () => {
        const requests = serveRows([]);
        await chmod(directory, 0o500);
        try {
          await expect(
            socialCommand.parseAsync([
              ...commentsArgs,
              "--output",
              join(directory, "out.json"),
              "--json",
            ]),
          ).rejects.toThrow("process.exit called");
          expect(errorOutput()).toContain("writable parent");
          expect(requests).toEqual([]);
        } finally {
          await chmod(directory, 0o700);
        }
      },
    );

    it("preserves the existing file until an explicit overwrite is ready", async () => {
      const path = join(directory, "out.json");
      await writeFile(path, "old content");
      server.use(
        http.post("http://localhost:3000/api/social/request", async () => {
          expect(await readFile(path, "utf8")).toBe("old content");
          return HttpResponse.json(
            socialResponse(
              "instagram_comments",
              { state: "complete", itemsReturned: 1 },
              { comments: [{ id: "new" }] },
            ),
          );
        }),
      );
      await socialCommand.parseAsync([
        ...commentsArgs,
        "--output",
        path,
        "--overwrite",
        "--json",
      ]);
      expect(
        JSON.parse(await readFile(path, "utf8")) as unknown,
      ).toHaveProperty("data.items", [{ id: "new" }]);
      expect(await readdir(directory)).toEqual(["out.json"]);
    });

    it("recovers the full result and billing when another writer claims the destination", async () => {
      const path = join(directory, "out.csv");
      const requests: unknown[] = [];
      server.use(
        http.post(
          "http://localhost:3000/api/social/request",
          async ({ request }) => {
            requests.push(await request.json());
            await writeFile(path, "concurrent writer");
            return HttpResponse.json(
              socialResponse(
                "instagram_comments",
                { state: "complete", itemsReturned: 1 },
                { comments: [{ id: "one", text: "recover me" }] },
              ),
            );
          },
        ),
      );
      await socialCommand.parseAsync([
        ...commentsArgs,
        "--output",
        path,
        "--format",
        "csv",
        "--select",
        "id",
        "--json",
      ]);
      expect(await readFile(path, "utf8")).toBe("concurrent writer");
      expect(JSON.parse(output()) as unknown).toMatchObject({
        kind: "result",
        data: { items: [{ id: "one", text: "recover me" }] },
        billing: { creditsCharged: 3 },
      });
      expect(errorOutput()).toContain("without repeating the Social request");
      expect(process.exitCode).toBe(1);
      expect(mockExit).not.toHaveBeenCalled();
      expect(requests).toHaveLength(1);
      expect(await readdir(directory)).toEqual(["out.csv"]);
    });

    it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
      "retains recovered results and both diagnostics when directory access prevents publication and cleanup",
      async () => {
        const path = join(directory, "blocked.json");
        const requests: unknown[] = [];
        server.use(
          http.post(
            "http://localhost:3000/api/social/request",
            async ({ request }) => {
              requests.push(await request.json());
              await chmod(directory, 0o500);
              return HttpResponse.json(
                socialResponse(
                  "instagram_comments",
                  { state: "complete", itemsReturned: 1 },
                  { comments: [{ id: "one", text: "retain me" }] },
                ),
              );
            },
          ),
        );
        try {
          await socialCommand.parseAsync([
            ...commentsArgs,
            "--output",
            path,
            "--select",
            "id",
            "--json",
          ]);
          expect(JSON.parse(output()) as unknown).toMatchObject({
            kind: "result",
            data: { items: [{ id: "one", text: "retain me" }] },
            billing: { creditsCharged: 3 },
          });
          expect(
            mockConsoleError.mock.calls.map(([value]) => {
              return JSON.parse(String(value)) as unknown;
            }),
          ).toEqual([
            {
              status: "error",
              error: {
                kind: "export_cleanup",
                code: "EXPORT_CLEANUP_FAILED",
                message: expect.stringContaining(".tmp"),
                retryable: false,
              },
            },
            expect.objectContaining({
              error: expect.objectContaining({
                message: expect.stringContaining(
                  "without repeating the Social request",
                ),
              }),
            }),
          ]);
          expect(process.exitCode).toBe(1);
          expect(mockExit).not.toHaveBeenCalled();
          expect(requests).toHaveLength(1);
          await expect(readFile(path, "utf8")).rejects.toMatchObject({
            code: "ENOENT",
          });
          expect(await readdir(directory)).toEqual([
            expect.stringMatching(/^\.okou-social-.+\.tmp$/u),
          ]);
        } finally {
          await chmod(directory, 0o700);
        }
      },
    );
  });

  it("discovers a lost task ID and retrieves its artifact through existing resume", async () => {
    const task = completedDownload();
    server.use(
      http.get("http://localhost:3000/api/social/downloads", ({ request }) => {
        expect(new URL(request.url).searchParams.get("limit")).toBe("20");
        return HttpResponse.json({
          downloads: [
            {
              ...task,
              providerName: "SocialKit",
              request: {
                platform: "youtube",
                url: "https://youtu.be/video123",
                maxDuration: 600,
                quality: "720p",
                format: "mp4",
              },
              resumeCommand: `okou social download --resume ${task.downloadId}`,
            },
          ],
          nextCursor: null,
        });
      }),
      http.get(
        "http://localhost:3000/api/social/downloads/:downloadId",
        ({ params }) => {
          expect(params.downloadId).toBe(task.downloadId);
          return HttpResponse.json(task);
        },
      ),
    );
    await socialCommand.parseAsync(["node", "okou", "downloads", "--json"]);
    expect(JSON.parse(output()) as unknown).toMatchObject({
      downloads: [
        {
          downloadId: task.downloadId,
          request: { url: "https://youtu.be/video123" },
          artifact: task.artifact,
        },
      ],
      nextCommand: null,
    });
    expect(output()).not.toContain("providerName");
    mockConsoleLog.mockClear();
    await socialCommand.parseAsync([
      "node",
      "okou",
      "download",
      "--resume",
      task.downloadId,
      "--json",
    ]);
    expect(output()).toContain(task.artifact.url);
  });

  it("lists only one requested page and preserves filter and cursor in continuation guidance", async () => {
    const task = failedDownload("artifact_failed");
    const cursor = "fc168c40-dd27-4e4a-b588-628bac29070b";
    server.use(
      http.get("http://localhost:3000/api/social/downloads", ({ request }) => {
        const params = new URL(request.url).searchParams;
        expect(Object.fromEntries(params)).toStrictEqual({
          limit: "1",
          cursor,
          status: "active",
        });
        return HttpResponse.json({
          downloads: [
            {
              ...task,
              request: {
                platform: "youtube",
                url: "https://youtu.be/video123",
                maxDuration: 600,
                quality: "720p",
                format: "mp4",
              },
              resumeCommand: `okou social download --resume ${task.downloadId}`,
            },
          ],
          nextCursor: task.downloadId,
        });
      }),
    );
    await socialCommand.parseAsync([
      "node",
      "okou",
      "downloads",
      "--limit",
      "1",
      "--cursor",
      cursor,
      "--status",
      "active",
      "--json",
    ]);
    expect(JSON.parse(output()) as unknown).toMatchObject({
      downloads: [
        { status: "artifact_failed", error: { billed: true, retryable: true } },
      ],
      nextCommand: `okou social downloads --limit 1 --cursor ${task.downloadId} --status active --json`,
    });
  });

  it("prints empty discovery guidance without starting a download", async () => {
    server.use(
      http.get("http://localhost:3000/api/social/downloads", () => {
        return HttpResponse.json({ downloads: [], nextCursor: null });
      }),
    );
    await socialCommand.parseAsync(["node", "okou", "downloads", "--json"]);
    expect(JSON.parse(output()) as unknown).toMatchObject({
      downloads: [],
      nextCursor: null,
      nextCommand: null,
      message: expect.stringContaining("okou social download --help"),
    });
  });

  it.each([
    ["--limit", "101"],
    ["--status", "unknown"],
  ])(
    "rejects invalid discovery input %s %s before HTTP",
    async (flag, value) => {
      await expect(
        socialCommand.parseAsync([
          "node",
          "okou",
          "downloads",
          flag,
          value,
          "--json",
        ]),
      ).rejects.toThrow("process.exit called");
      expect(JSON.parse(errorOutput()) as unknown).toMatchObject({
        error: { code: "INVALID_INPUT" },
      });
    },
  );

  it.each([false, true])(
    "preserves actionable download conflicts with json=%s without resuming automatically",
    async (json) => {
      const recovery = {
        downloadId: completedDownload().downloadId,
        resumeCommand: `okou social download --resume ${completedDownload().downloadId}`,
      };
      server.use(
        http.post("http://localhost:3000/api/social/downloads", () => {
          return HttpResponse.json(
            {
              error: {
                code: "DOWNLOAD_IN_PROGRESS",
                message: "Another social media download is already in progress",
                recovery,
              },
            },
            { status: 409 },
          );
        }),
      );
      await expect(
        socialCommand.parseAsync([
          "node",
          "okou",
          "download",
          "https://youtu.be/video123",
          "--max-duration",
          "60",
          ...(json ? ["--json"] : []),
        ]),
      ).rejects.toThrow("process.exit called");
      if (json) {
        expect(JSON.parse(errorOutput()) as unknown).toMatchObject({
          error: {
            code: "DOWNLOAD_IN_PROGRESS",
            httpStatus: 409,
            retryable: false,
          },
          recovery,
        });
      } else {
        expect(errorOutput()).toContain(recovery.downloadId);
        expect(errorOutput()).toContain(recovery.resumeCommand);
      }
    },
  );

  it("accepts a generic create conflict without inventing recovery details", async () => {
    server.use(
      http.post("http://localhost:3000/api/social/downloads", () => {
        return HttpResponse.json(
          {
            error: {
              code: "DOWNLOAD_IN_PROGRESS",
              message: "Another social media download is already in progress",
            },
          },
          { status: 409 },
        );
      }),
    );
    await expect(
      socialCommand.parseAsync([
        "node",
        "okou",
        "download",
        "https://youtu.be/video123",
        "--max-duration",
        "60",
        "--json",
      ]),
    ).rejects.toThrow("process.exit called");
    expect(JSON.parse(errorOutput()) as unknown).toStrictEqual({
      status: "error",
      error: {
        kind: "request_failed",
        code: "DOWNLOAD_IN_PROGRESS",
        message: "Another social media download is already in progress",
        httpStatus: 409,
        retryable: false,
      },
    });
  });

  it.each([403, 404, 503])(
    "reports discovery HTTP %s without substituting another operation",
    async (status) => {
      server.use(
        http.get("http://localhost:3000/api/social/downloads", () => {
          return HttpResponse.json(
            {
              error: { code: "UNAVAILABLE", message: "Discovery unavailable" },
            },
            { status },
          );
        }),
      );
      await expect(
        socialCommand.parseAsync(["node", "okou", "downloads", "--json"]),
      ).rejects.toThrow("process.exit called");
      expect(JSON.parse(errorOutput()) as unknown).toMatchObject({
        error: { httpStatus: status, message: "Discovery unavailable" },
      });
    },
  );

  function errorOutput(): string {
    return mockConsoleError.mock.calls.flat().map(String).join("\n");
  }

  function outputRequest(): unknown {
    return (JSON.parse(output()) as { readonly request: unknown }).request;
  }

  function parserErrorOutput(): string {
    return mockStderrWrite.mock.calls.flat().map(String).join("");
  }

  async function fieldsFile(contents: string): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "okou-summary-fields-"));
    onTestFinished(async () => {
      await rm(directory, { recursive: true, force: true });
    });
    const path = join(directory, "summary fields.json");
    await writeFile(path, contents);
    return path;
  }

  it("discovers concise capabilities locally", async () => {
    vi.stubEnv("OKOU_TOKEN", undefined);
    let apiRequests = 0;
    server.use(
      http.all("*", () => {
        apiRequests += 1;
        return HttpResponse.json(socialResponse("youtube_stats", null, {}));
      }),
    );

    await socialCommand.parseAsync([
      "node",
      "okou",
      "capabilities",
      "instagram",
      "--json",
    ]);

    const result = JSON.parse(output()) as {
      readonly capabilities: readonly {
        readonly platform: string;
        readonly operations: readonly string[];
      }[];
    };
    expect(result).toMatchObject({
      capabilities: [
        {
          platform: "instagram",
          operations: expect.arrayContaining([
            "inspect",
            "posts",
            "search",
            "comments",
          ]),
        },
      ],
    });
    expect(output()).not.toContain("inputSchema");
    expect(output()).not.toContain("instagram_channel_posts");
    expect(output()).toContain("up to 100 trimmed characters");
    expect(output()).toContain("one anonymous batch of up to 12 reels");
    expect(output()).toContain("--require-views");
    expect(output()).toContain("null, distinct from zero");
    expect(apiRequests).toBe(0);
  });

  it("discovers YouTube refresh and its cache boundary", async () => {
    await socialCommand.parseAsync([
      "node",
      "okou",
      "capabilities",
      "youtube",
      "--json",
    ]);

    expect(JSON.parse(output()) as unknown).toMatchObject({
      capabilities: [
        {
          platform: "youtube",
          notes: expect.arrayContaining([
            expect.stringContaining("--refresh"),
            expect.stringContaining("captions may still be unavailable"),
            expect.stringContaining("Summary-result caching is separate"),
          ]),
        },
      ],
    });
  });

  it("discovers transcript formats separately from source timing availability without HTTP", async () => {
    vi.stubEnv("OKOU_TOKEN", undefined);
    let requests = 0;
    server.use(
      http.all("*", () => {
        requests += 1;
        return HttpResponse.error();
      }),
    );
    await socialCommand.parseAsync([
      "node",
      "okou",
      "capabilities",
      "youtube",
      "--json",
    ]);
    expect(JSON.parse(output()) as unknown).toMatchObject({
      capabilities: [
        {
          platform: "youtube",
          details: expect.arrayContaining([
            expect.objectContaining({
              operation: "transcript",
              export: expect.objectContaining({
                formats: ["json", "text", "srt", "vtt"],
                selection: expect.objectContaining({ formats: ["json"] }),
                transcript: expect.objectContaining({
                  timing: expect.stringContaining(
                    "Extraction does not guarantee timestamped output",
                  ),
                  recovery: expect.stringContaining("without retrying"),
                }),
              }),
            }),
            expect.objectContaining({
              operation: "summarize",
              export: expect.objectContaining({ formats: ["json"] }),
            }),
          ]),
        },
      ],
    });
    expect(requests).toBe(0);
  });

  it("discovers source limits and only supported advanced inputs without HTTP", async () => {
    vi.stubEnv("OKOU_TOKEN", undefined);
    let requests = 0;
    server.use(
      http.all("*", () => {
        requests += 1;
        return HttpResponse.error();
      }),
    );
    await socialCommand.parseAsync(["node", "okou", "capabilities", "--json"]);
    const capabilities = (
      JSON.parse(output()) as {
        capabilities: { platform: string; details: unknown[] }[];
      }
    ).capabilities;
    expect(
      capabilities.find((entry) => {
        return entry.platform === "tiktok";
      })?.details,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operation: "posts",
          collection: expect.objectContaining({
            effectivePageLimit: 30,
            maxPages: 100,
          }),
        }),
        expect.objectContaining({
          operation: "search",
          variant: "keyword",
          inputs: expect.objectContaining({
            "--sort": expect.objectContaining({
              choices: ["relevance", "likes", "date"],
            }),
          }),
          collection: expect.objectContaining({
            effectivePageLimit: 10,
            pageSize: "provider_controlled",
          }),
        }),
        expect.objectContaining({
          operation: "search",
          variant: "hashtag",
          inputs: { "--hashtag": { value: true } },
          collection: expect.objectContaining({ effectivePageLimit: 20 }),
        }),
      ]),
    );
    expect(
      capabilities.find((entry) => {
        return entry.platform === "instagram";
      })?.details,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operation: "inspect",
          variant: "post",
          inputs: {
            "--require-views": { type: "boolean", required: false },
          },
        }),
        expect.objectContaining({
          operation: "search",
          inputs: {
            "<query>": {
              type: "string",
              minLength: 1,
              maxLength: 100,
              required: true,
            },
            "--hashtag": { type: "boolean", required: false },
          },
          collection: expect.objectContaining({
            pagination: "none",
            maxPages: 1,
            requestPageLimit: null,
            sourceLimit: { kind: "single_batch", maxItems: 12 },
          }),
        }),
        expect.objectContaining({
          operation: "posts",
          inputs: {
            "--kind": {
              choices: ["posts", "reels"],
              value: "reels",
              default: "posts",
            },
          },
        }),
      ]),
    );
    expect(
      capabilities.find((entry) => {
        return entry.platform === "youtube";
      })?.details,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operation: "posts",
          inputs: {
            "--full-details": { type: "boolean", required: false },
          },
          collection: expect.objectContaining({
            totalLimit: {
              default: 10,
              minimum: 1,
              maximum: Number.MAX_SAFE_INTEGER,
            },
            pagination: "none",
            maxPages: 1,
            requestPageLimit: 100,
          }),
        }),
        expect.objectContaining({
          operation: "transcript",
          inputs: {
            "--refresh": { type: "boolean", required: false },
          },
        }),
        expect.objectContaining({
          operation: "summarize",
          inputs: {
            "--prompt": expect.objectContaining({
              type: "string",
              maxLength: 4096,
            }),
            "--refresh": { type: "boolean", required: false },
            "--fields": expect.objectContaining({
              format: "json_object",
              fieldNameMaxLength: 64,
              maxSerializedLength: 4096,
              conflictsWith: "--fields-file",
            }),
            "--fields-file": expect.objectContaining({
              format: "path",
              conflictsWith: "--fields",
            }),
          },
        }),
        expect.objectContaining({
          operation: "download",
          inputs: expect.objectContaining({
            "--format": expect.objectContaining({
              choices: ["mp4", "m4a", "mp3"],
              default: "mp4",
              required: false,
            }),
            "--quality": expect.objectContaining({
              default: "720p",
              required: false,
            }),
            "--max-duration": expect.objectContaining({
              maximum: 86400,
              required: true,
            }),
            "--resume": expect.objectContaining({ format: "uuid" }),
          }),
        }),
      ]),
    );
    expect(requests).toBe(0);
  });

  it.each(["healthy", "degraded", "unavailable", "unknown"])(
    "prints %s live status and normalizes the X platform alias",
    async (status) => {
      const body = {
        observedAt: "2026-09-14T09:00:00.000Z",
        staleAfterSeconds: 300,
        overall: {
          status,
          updatedAt: status === "unknown" ? null : "2026-09-14T09:00:00.000Z",
          reason: status === "unknown" ? "status_unavailable" : null,
        },
        operations: [
          {
            platform: "twitter",
            operation: "inspect",
            variant: "profile",
            status,
            updatedAt: null,
            reason: null,
          },
        ],
      };
      server.use(
        http.get("http://localhost:3000/api/social/status", ({ request }) => {
          expect(new URL(request.url).searchParams.get("platform")).toBe(
            "twitter",
          );
          expect(request.headers.get("authorization")).toBe(
            "Bearer test-okou-token",
          );
          return HttpResponse.json(body);
        }),
      );
      await socialCommand.parseAsync(["node", "okou", "status", "x", "--json"]);
      expect(JSON.parse(output())).toEqual(body);
      expect(mockExit).not.toHaveBeenCalled();
    },
  );

  it("reports status API errors without inventing healthy observations", async () => {
    server.use(
      http.get("http://localhost:3000/api/social/status", () => {
        return HttpResponse.json(
          {
            error: {
              code: "FORBIDDEN",
              message: "Social status is not enabled",
            },
          },
          { status: 403 },
        );
      }),
    );
    await expect(
      socialCommand.parseAsync(["node", "okou", "status", "--json"]),
    ).rejects.toThrow("process.exit called");
    expect(errorOutput()).toContain("Social status is not enabled");
    expect(mockExit).toHaveBeenCalledWith(1);
    expect(output()).toBe("");
  });

  it.each(["relevance", "likes", "date"])(
    "accepts the advertised TikTok sort %s through the real command",
    async (sort) => {
      server.use(
        http.post(
          "http://localhost:3000/api/social/request",
          async ({ request }) => {
            expect(await request.json()).toMatchObject({
              tool: "tiktok_search",
              input: { sortBy: sort, datePosted: "week", limit: 10 },
            });
            return HttpResponse.json(
              socialResponse(
                "tiktok_search",
                { state: "complete", itemsReturned: 0 },
                collectionResult("tiktok_search"),
              ),
            );
          },
        ),
      );
      await socialCommand.parseAsync([
        "node",
        "okou",
        "search",
        "example",
        "--platform",
        "tiktok",
        "--sort",
        sort,
        "--date",
        "week",
        "--json",
      ]);
      expect(mockExit).not.toHaveBeenCalled();
      expect(output()).toContain('"operation":"search"');
    },
  );

  it.each([
    ["https://linkedin.com/in/example", "linkedin_profile"],
    ["https://linkedin.com/company/example", "linkedin_company"],
    ["https://linkedin.com/posts/example", "linkedin_post"],
    ["https://twitter.com/example", "twitter_profile"],
    ["https://x.com/example/status/1", "twitter_tweet"],
    ["https://facebook.com/example", "facebook_channel_stats"],
    ["https://facebook.com/example/posts/1", "facebook_stats"],
    ["https://fb.watch/example", "facebook_stats"],
    ["https://facebook.com/watch?v=example", "facebook_stats"],
    ["https://facebook.com/video.php?v=example", "facebook_stats"],
    [
      "https://facebook.com/permalink.php?story_fbid=example&id=page",
      "facebook_stats",
    ],
    ["https://facebook.com/photo.php?fbid=example", "facebook_stats"],
    [
      "https://facebook.com/story.php?story_fbid=example&id=page",
      "facebook_stats",
    ],
    ["https://instagram.com/example", "instagram_channel_stats"],
    ["https://instagram.com/reel/example", "instagram_stats"],
    ["https://www.instagram.com/example.user/p/ABC123/", "instagram_stats"],
    ["https://instagram.com/example_user/reel/ABC123", "instagram_stats"],
    ["https://tiktok.com/@example", "tiktok_channel_stats"],
    ["https://tiktok.com/@example/video/1", "tiktok_stats"],
    ["https://tiktok.com/t/example", "tiktok_stats"],
    ["https://vm.tiktok.com/example", "tiktok_stats"],
    ["https://vt.tiktok.com/example", "tiktok_stats"],
    ["https://youtube.com/@example", "youtube_channel_stats"],
    ["https://youtube.com/watch?v=example", "youtube_stats"],
  ])("routes inspect %s to %s", async (url, expectedTool) => {
    let requestBody: unknown;
    server.use(
      http.post(
        "http://localhost:3000/api/social/request",
        async ({ request }) => {
          requestBody = await request.json();
          return HttpResponse.json(socialResponse(expectedTool, null, {}));
        },
      ),
    );

    await socialCommand.parseAsync(["node", "okou", "inspect", url, "--json"]);

    expect(requestBody).toMatchObject({ tool: expectedTool });
    expect(JSON.parse(output()) as unknown).toMatchObject({
      status: "complete",
      operation: "inspect",
    });
    expect(outputRequest()).toStrictEqual({
      thread: false,
      ...(expectedTool === "instagram_stats" ? { requireViews: false } : {}),
    });
  });

  it.each([null, undefined, 0, 12])(
    "preserves Instagram views %s through the real reader and output",
    async (views) => {
      const data = {
        ...(views === undefined ? {} : { views }),
        likes: 4,
        author: "example",
      };
      const requests: unknown[] = [];
      server.use(
        http.post(
          "http://localhost:3000/api/social/request",
          async ({ request }) => {
            expect(request.headers.get("x-okou-instagram-views")).toBe(
              "nullable",
            );
            requests.push(await request.json());
            return HttpResponse.json(
              socialResponse("instagram_stats", null, data),
            );
          },
        ),
      );

      await socialCommand.parseAsync([
        "node",
        "okou",
        "inspect",
        "https://instagram.com/reel/example",
        "--json",
      ]);

      expect(requests).toStrictEqual([
        {
          tool: "instagram_stats",
          input: { url: "https://www.instagram.com/reel/example" },
        },
      ]);
      expect(JSON.parse(output()) as unknown).toMatchObject({
        status: "complete",
        request: { requireViews: false },
        data,
      });
      expect((JSON.parse(output()) as { data: unknown }).data).toStrictEqual(
        data,
      );
    },
  );

  it("forwards strict Instagram lookup and preserves verified zero", async () => {
    const requests: unknown[] = [];
    server.use(
      http.post(
        "http://localhost:3000/api/social/request",
        async ({ request }) => {
          requests.push(await request.json());
          return HttpResponse.json(
            socialResponse("instagram_stats", null, { views: 0 }),
          );
        },
      ),
    );

    await socialCommand.parseAsync([
      "node",
      "okou",
      "inspect",
      "https://instagram.com/p/example",
      "--require-views",
      "--json",
    ]);

    expect(requests).toStrictEqual([
      {
        tool: "instagram_stats",
        input: {
          url: "https://www.instagram.com/p/example",
          requireViews: true,
        },
      },
    ]);
    expect(JSON.parse(output()) as unknown).toMatchObject({
      status: "complete",
      request: { requireViews: true },
      data: { views: 0 },
    });
  });

  it.each([
    "https://instagram.com/example",
    "https://youtube.com/watch?v=example",
    "https://x.com/example/status/1",
    "https://facebook.com/example/posts/1",
    "https://tiktok.com/@example/video/1",
    "https://linkedin.com/posts/example",
  ])("rejects --require-views for %s before HTTP", async (url) => {
    let requests = 0;
    server.use(
      http.post("http://localhost:3000/api/social/request", () => {
        requests += 1;
        return HttpResponse.json({});
      }),
    );

    await expect(
      socialCommand.parseAsync([
        "node",
        "okou",
        "inspect",
        url,
        "--require-views",
        "--json",
      ]),
    ).rejects.toThrow("process.exit called");

    expect(requests).toBe(0);
    expect(errorOutput()).toContain(
      "--require-views is supported only for Instagram post or video URLs",
    );
  });

  it("reports strict Instagram 503 without retrying optional lookup", async () => {
    const requests: unknown[] = [];
    server.use(
      http.post(
        "http://localhost:3000/api/social/request",
        async ({ request }) => {
          requests.push(await request.json());
          return HttpResponse.json(
            {
              error: {
                code: "SOCIAL_VIEWS_UNAVAILABLE",
                message:
                  "Instagram view count is temporarily unavailable. No credits were charged. Retry later, or omit --require-views to use other available data.",
              },
            },
            { status: 503 },
          );
        },
      ),
    );

    await expect(
      socialCommand.parseAsync([
        "node",
        "okou",
        "inspect",
        "https://instagram.com/reel/example",
        "--require-views",
        "--json",
      ]),
    ).rejects.toThrow("process.exit called");

    expect(requests).toStrictEqual([
      {
        tool: "instagram_stats",
        input: {
          url: "https://www.instagram.com/reel/example",
          requireViews: true,
        },
      },
    ]);
    expect(JSON.parse(errorOutput()) as unknown).toMatchObject({
      status: "error",
      error: {
        code: "SOCIAL_VIEWS_UNAVAILABLE",
        httpStatus: 503,
        retryable: true,
        message: expect.stringContaining("No credits were charged"),
      },
    });
    expect(output()).toBe("");
  });

  it("canonicalizes supported URLs and routes X threads", async () => {
    let requestBody: unknown;
    server.use(
      http.post(
        "http://localhost:3000/api/social/request",
        async ({ request }) => {
          requestBody = await request.json();
          return HttpResponse.json(socialResponse("twitter_thread", null, {}));
        },
      ),
    );

    await socialCommand.parseAsync([
      "node",
      "okou",
      "inspect",
      "http://mobile.twitter.com/example/status/1?utm_source=test#reply",
      "--thread",
      "--json",
    ]);

    expect(requestBody).toStrictEqual({
      tool: "twitter_thread",
      input: { url: "https://x.com/example/status/1" },
    });
    expect(JSON.parse(output()) as unknown).toMatchObject({
      platform: "twitter",
      target: {
        input:
          "http://mobile.twitter.com/example/status/1?utm_source=test#reply",
        canonicalUrl: "https://x.com/example/status/1",
      },
    });
    expect(outputRequest()).toStrictEqual({ thread: true });
  });

  it.each([
    [
      "https://linkedin.com/company/example",
      undefined,
      "linkedin_company_posts",
    ],
    ["https://x.com/example", undefined, "twitter_tweets"],
    ["https://instagram.com/example", undefined, "instagram_channel_posts"],
    ["https://instagram.com/example", "reels", "instagram_channel_reels"],
    ["https://tiktok.com/@example", undefined, "tiktok_channel_videos"],
    ["https://youtube.com/@example", undefined, "youtube_videos"],
    ["https://youtube.com/playlist?list=example", undefined, "youtube_videos"],
  ])("routes posts %s %s to %s", async (url, kind, expectedTool) => {
    let requestBody: unknown;
    server.use(
      http.post(
        "http://localhost:3000/api/social/request",
        async ({ request }) => {
          requestBody = await request.json();
          return HttpResponse.json(
            socialResponse(
              expectedTool,
              { state: "complete", itemsReturned: 0 },
              collectionResult(expectedTool),
            ),
          );
        },
      ),
    );
    const args = ["node", "okou", "posts", url, "--limit", "250", "--json"];
    if (kind) {
      args.push("--kind", kind);
    }

    await socialCommand.parseAsync(args);

    expect(requestBody).toMatchObject({ tool: expectedTool });
    expect(requestBody).toHaveProperty(
      "input.limit",
      expectedTool === "linkedin_company_posts"
        ? 50
        : expectedTool === "tiktok_channel_videos"
          ? 30
          : 100,
    );
    expect(requestBody).not.toHaveProperty("input.full_details");
    expect(outputRequest()).toStrictEqual(
      kind === undefined ? { limit: 250 } : { limit: 250, kind },
    );
  });

  it.each([
    {
      source: "channel",
      url: "https://www.youtube.com/@example",
      limit: undefined,
    },
    {
      source: "channel",
      url: "https://www.youtube.com/@example",
      limit: 1,
    },
    {
      source: "playlist",
      url: "https://www.youtube.com/playlist?list=example",
      limit: 30,
    },
  ])(
    "requests full details for a $source with limit $limit",
    async ({ source, url, limit }) => {
      let requestBody: unknown;
      const results = [
        {
          videoId: "older-video",
          title: "An older video",
          publishedTime: "12 years ago",
          publishedAt: "2014-01-01T12:00:00.000Z",
          description: "The complete older video description",
        },
      ];
      server.use(
        http.post(
          "http://localhost:3000/api/social/request",
          async ({ request }) => {
            requestBody = await request.json();
            return HttpResponse.json(
              socialResponse(
                "youtube_videos",
                { state: "complete", itemsReturned: results.length },
                { type: source, url, results },
              ),
            );
          },
        ),
      );
      const args = ["node", "okou", "posts", url, "--full-details", "--json"];
      if (limit !== undefined) {
        args.push("--limit", String(limit));
      }

      await socialCommand.parseAsync(args);

      expect(requestBody).toStrictEqual({
        tool: "youtube_videos",
        input: { url, limit: limit ?? 10, full_details: true },
      });
      expect(JSON.parse(output()) as unknown).toMatchObject({
        status: "complete",
        request: { limit: limit ?? 10, fullDetails: true },
        data: { items: results, context: { type: source, url } },
      });
    },
  );

  it.each([false, true])(
    "preserves unavailable YouTube metadata with full details %s",
    async (fullDetails) => {
      const results = [
        { videoId: "unavailable", publishedAt: null, description: "" },
        { videoId: "missing" },
      ];
      server.use(
        http.post("http://localhost:3000/api/social/request", () => {
          return HttpResponse.json(
            socialResponse(
              "youtube_videos",
              { state: "complete", itemsReturned: results.length },
              { type: "playlist", results },
            ),
          );
        }),
      );
      const args = [
        "node",
        "okou",
        "posts",
        "https://youtube.com/playlist?list=example",
        "--json",
      ];
      if (fullDetails) {
        args.push("--full-details");
      }

      await socialCommand.parseAsync(args);

      const result = JSON.parse(output()) as { readonly data: unknown };
      expect(result.data).toStrictEqual({
        items: results,
        context: { type: "playlist" },
      });
    },
  );

  it("includes full-details intent in streamed pages and the summary", async () => {
    server.use(
      http.post("http://localhost:3000/api/social/request", () => {
        return HttpResponse.json(
          socialResponse(
            "youtube_videos",
            { state: "complete", itemsReturned: 1 },
            { results: [{ videoId: "example", publishedAt: null }] },
          ),
        );
      }),
    );

    await socialCommand.parseAsync([
      "node",
      "okou",
      "posts",
      "https://youtube.com/playlist?list=example",
      "--full-details",
      "--stream",
    ]);

    const records: unknown = output()
      .split("\n")
      .map((line) => {
        return JSON.parse(line) as unknown;
      });
    expect(records).toEqual([
      expect.objectContaining({
        kind: "page",
        request: { limit: 10, fullDetails: true },
      }),
      expect.objectContaining({
        kind: "summary",
        request: { limit: 10, fullDetails: true },
      }),
    ]);
  });

  it.each([31, 250])(
    "rejects full details with limit %s before HTTP",
    async (limit) => {
      let apiRequests = 0;
      server.use(
        http.post("http://localhost:3000/api/social/request", () => {
          apiRequests += 1;
          return HttpResponse.json(socialResponse("youtube_videos", null, {}));
        }),
      );

      await expect(
        socialCommand.parseAsync([
          "node",
          "okou",
          "posts",
          "https://youtube.com/@example",
          "--full-details",
          "--limit",
          String(limit),
          "--json",
        ]),
      ).rejects.toThrow("process.exit called");

      expect(apiRequests).toBe(0);
      expect(JSON.parse(errorOutput()) as unknown).toMatchObject({
        status: "error",
        error: {
          kind: "invalid_input",
          code: "INVALID_INPUT",
          message:
            "--full-details supports at most 30 videos; use --limit 30 or less, or omit --full-details for the fast listing",
        },
      });
    },
  );

  it("discovers YouTube full-details constraints without HTTP", async () => {
    vi.stubEnv("OKOU_TOKEN", "");

    await socialCommand.parseAsync([
      "node",
      "okou",
      "capabilities",
      "youtube",
      "--json",
    ]);

    expect(output()).toContain("channels and playlists");
    expect(output()).toContain("--full-details");
    expect(output()).toContain("slower; --limit at most 30");
    expect(output()).toContain("null, empty, or missing");
  });

  it.each([
    ["instagram", false, "instagram_reels_search"],
    ["tiktok", false, "tiktok_search"],
    ["tiktok", true, "tiktok_hashtag_search"],
    ["youtube", false, "youtube_search"],
  ])("routes %s search to %s", async (platform, hashtag, expectedTool) => {
    let requestBody: unknown;
    server.use(
      http.post(
        "http://localhost:3000/api/social/request",
        async ({ request }) => {
          requestBody = await request.json();
          return HttpResponse.json(
            socialResponse(
              expectedTool,
              { state: "complete", itemsReturned: 0 },
              collectionResult(expectedTool),
            ),
          );
        },
      ),
    );
    const args = [
      "node",
      "okou",
      "search",
      hashtag ? "#launch" : "launch",
      "--platform",
      platform,
      "--json",
    ];
    if (hashtag) {
      args.push("--hashtag");
    }

    await socialCommand.parseAsync(args);

    expect(requestBody).toMatchObject({ tool: expectedTool });
    if (hashtag) {
      expect(requestBody).toHaveProperty("input.hashtag", "launch");
    }
    expect(outputRequest()).toStrictEqual({ limit: 10, hashtag });
  });

  it.each([
    { query: "  CaTs  ", hashtag: false, normalized: "CaTs" },
    { query: "#CaTs", hashtag: false, normalized: "CaTs" },
    { query: "%23CaTs", hashtag: false, normalized: "CaTs" },
    { query: "CaTs", hashtag: true, normalized: "CaTs" },
    { query: " #CaTs ", hashtag: true, normalized: "CaTs" },
    { query: "%23CaTs", hashtag: true, normalized: "CaTs" },
    { query: "Cat Videos", hashtag: false, normalized: "CatVideos" },
    {
      query: `  ${"A".repeat(100)}  `,
      hashtag: false,
      normalized: "A".repeat(100),
    },
    { query: "İ".repeat(100), hashtag: false, normalized: "İ".repeat(100) },
  ])(
    "normalizes Instagram query $query with hashtag=$hashtag",
    async ({ query, hashtag, normalized }) => {
      let requestBody: unknown;
      server.use(
        http.post(
          "http://localhost:3000/api/social/request",
          async ({ request }) => {
            requestBody = await request.json();
            return HttpResponse.json(
              socialResponse(
                "instagram_reels_search",
                { state: "complete", itemsReturned: 0 },
                { items: [], hasMore: false },
              ),
            );
          },
        ),
      );
      const args = [
        "node",
        "okou",
        "search",
        query,
        "--platform",
        "instagram",
        "--json",
      ];
      if (hashtag) {
        args.push("--hashtag");
      }

      await socialCommand.parseAsync(args);

      expect(requestBody).toStrictEqual({
        tool: "instagram_reels_search",
        input: { query: normalized },
      });
      expect(outputRequest()).toStrictEqual({ limit: 10, hashtag });
    },
  );

  it.each(["a".repeat(101), `  ${"a".repeat(101)}  `, "#", "%23"])(
    "rejects invalid Instagram query %s before an API request",
    async (query) => {
      let apiRequests = 0;
      server.use(
        http.post("http://localhost:3000/api/social/request", () => {
          apiRequests += 1;
          return new HttpResponse(null, { status: 500 });
        }),
      );

      await expect(
        socialCommand.parseAsync([
          "node",
          "okou",
          "search",
          query,
          "--platform",
          "instagram",
          "--hashtag",
          "--json",
        ]),
      ).rejects.toThrow("process.exit called");

      expect(apiRequests).toBe(0);
      expect(JSON.parse(errorOutput()) as unknown).toMatchObject({
        status: "error",
        error: { kind: "invalid_input" },
      });
    },
  );

  it.each([
    { count: 0, limit: 20, stream: false },
    { count: 3, limit: 20, stream: true },
    { count: 12, limit: 20, stream: false },
    { count: 12, limit: 12, stream: true },
    { count: 12, limit: 2, stream: false },
    { count: 12, limit: 2, stream: true },
  ])(
    "reports Instagram source and caller limits for $count items, limit $limit, stream=$stream",
    async ({ count, limit, stream }) => {
      let apiRequests = 0;
      const items = Array.from({ length: count }, (_, id) => {
        return {
          id: String(id),
        };
      });
      server.use(
        http.post("http://localhost:3000/api/social/request", () => {
          apiRequests += 1;
          return HttpResponse.json(
            socialResponse(
              "instagram_reels_search",
              { state: "complete", itemsReturned: count },
              { items, count, hasMore: false },
            ),
          );
        }),
      );
      const args = [
        "node",
        "okou",
        "search",
        "cats",
        "--platform",
        "instagram",
        "--limit",
        String(limit),
        "--json",
      ];
      if (stream) {
        args.push("--stream");
      }

      await socialCommand.parseAsync(args);

      const records = output()
        .split("\n")
        .map((line) => {
          return JSON.parse(line) as Record<string, unknown>;
        });
      const terminal = records.at(-1);
      expect(terminal).toMatchObject({
        kind: stream ? "summary" : "result",
        status: count >= limit ? "complete" : "partial",
        collection: {
          state: "provider_limited",
          pages: 1,
          itemsReturned: Math.min(count, limit),
          itemsObserved: count,
          requestedItems: limit,
          reason: "provider_ceiling",
          sourceLimit: { kind: "single_batch", maxItems: 12 },
          callerLimited: count > limit,
        },
        warnings: expect.arrayContaining([
          expect.objectContaining({
            code: "PROVIDER_LIMITED",
            message: expect.stringContaining("one anonymous batch of up to 12"),
          }),
        ]),
      });
      if (count > limit) {
        expect(terminal?.warnings).toContainEqual(
          expect.objectContaining({ code: "RESULT_LIMIT_REACHED" }),
        );
      }
      if (stream) {
        expect(terminal).not.toHaveProperty("data");
        expect(records[0]).toMatchObject({
          kind: "page",
          data: { items: items.slice(0, limit) },
        });
      } else {
        expect(terminal).toMatchObject({
          data: { items: items.slice(0, limit) },
        });
      }
      expect(apiRequests).toBe(1);
      expect(process.exitCode).toBe(count >= limit ? originalExitCode : 2);
    },
  );

  it("does not follow an older API's Instagram page-2 continuation", async () => {
    let apiRequests = 0;
    server.use(
      http.post("http://localhost:3000/api/social/request", () => {
        apiRequests += 1;
        return HttpResponse.json(
          socialResponse(
            "instagram_reels_search",
            { state: "more", itemsReturned: 1, nextInput: { page: 2 } },
            { items: [{ id: "one" }], hasMore: true },
          ),
        );
      }),
    );

    await socialCommand.parseAsync([
      "node",
      "okou",
      "search",
      "cats",
      "--platform",
      "instagram",
      "--json",
    ]);

    expect(apiRequests).toBe(1);
    expect(JSON.parse(output()) as unknown).toMatchObject({
      status: "partial",
      collection: {
        state: "provider_limited",
        sourceLimit: { kind: "single_batch", maxItems: 12 },
      },
    });
  });

  it("reports provider-neutral search filters in the result envelope", async () => {
    let requestBody: unknown;
    server.use(
      http.post(
        "http://localhost:3000/api/social/request",
        async ({ request }) => {
          requestBody = await request.json();
          return HttpResponse.json(
            socialResponse(
              "youtube_search",
              { state: "complete", itemsReturned: 0 },
              collectionResult("youtube_search"),
            ),
          );
        },
      ),
    );

    await socialCommand.parseAsync([
      "node",
      "okou",
      "search",
      "launch",
      "--platform",
      "youtube",
      "--sort",
      "views",
      "--date",
      "month",
      "--type",
      "shorts",
      "--limit",
      "25",
      "--json",
    ]);

    expect(requestBody).toStrictEqual({
      tool: "youtube_search",
      input: {
        query: "launch",
        limit: 25,
        sortBy: "views",
        uploadDate: "month",
        type: "shorts",
      },
    });
    expect(outputRequest()).toStrictEqual({
      limit: 25,
      hashtag: false,
      sort: "views",
      date: "month",
      type: "shorts",
    });
  });

  it.each([
    ["https://facebook.com/example/posts/1", "facebook_comments"],
    ["https://instagram.com/p/example", "instagram_comments"],
    ["https://tiktok.com/@example/video/1", "tiktok_comments"],
    ["https://youtu.be/example", "youtube_comments"],
  ])("routes comments %s to %s", async (url, expectedTool) => {
    let requestBody: unknown;
    server.use(
      http.post(
        "http://localhost:3000/api/social/request",
        async ({ request }) => {
          requestBody = await request.json();
          return HttpResponse.json(
            socialResponse(
              expectedTool,
              { state: "complete", itemsReturned: 0 },
              collectionResult(expectedTool),
            ),
          );
        },
      ),
    );

    await socialCommand.parseAsync(["node", "okou", "comments", url, "--json"]);

    expect(requestBody).toMatchObject({ tool: expectedTool });
    expect(outputRequest()).toStrictEqual({ limit: 10 });
  });

  it.each([
    ["https://linkedin.com/posts/example", "linkedin_transcript"],
    ["https://x.com/example/status/1", "twitter_transcript"],
    ["https://facebook.com/example/videos/1", "facebook_transcript"],
    ["https://instagram.com/reel/example", "instagram_transcript"],
    ["https://tiktok.com/@example/video/1", "tiktok_transcript"],
    ["https://youtu.be/example", "youtube_transcript"],
  ])("routes transcript %s to %s", async (url, expectedTool) => {
    let requestBody: unknown;
    server.use(
      http.post(
        "http://localhost:3000/api/social/request",
        async ({ request }) => {
          requestBody = await request.json();
          return HttpResponse.json(
            socialResponse(expectedTool, null, { transcript: "Example" }),
          );
        },
      ),
    );

    await socialCommand.parseAsync([
      "node",
      "okou",
      "transcript",
      url,
      "--json",
    ]);

    expect(requestBody).toMatchObject({ tool: expectedTool });
    expect(outputRequest()).toStrictEqual({});
    expect(requestBody).not.toHaveProperty("input.no_cache");
    expect(requestBody).not.toHaveProperty("input.cache");
  });

  it.each([
    ["https://facebook.com/example/videos/1", "facebook_summarize"],
    ["https://instagram.com/reel/example", "instagram_summarize"],
    ["https://tiktok.com/@example/video/1", "tiktok_summarize"],
    ["https://youtu.be/example", "youtube_summarize"],
  ])("routes summarize %s to %s", async (url, expectedTool) => {
    let requestBody: unknown;
    server.use(
      http.post(
        "http://localhost:3000/api/social/request",
        async ({ request }) => {
          requestBody = await request.json();
          return HttpResponse.json(
            socialResponse(expectedTool, null, { summary: "Example" }),
          );
        },
      ),
    );

    await socialCommand.parseAsync([
      "node",
      "okou",
      "summarize",
      url,
      "--prompt",
      "Focus on outcomes",
      "--json",
    ]);

    expect(requestBody).toMatchObject({
      tool: expectedTool,
      input: { custom_prompt: "Focus on outcomes" },
    });
    expect(outputRequest()).toStrictEqual({ customPrompt: true });
    expect(requestBody).not.toHaveProperty("input.no_cache");
    expect(requestBody).not.toHaveProperty("input.cache");
  });

  it.each(["transcript", "summarize"])(
    "refreshes YouTube extraction through %s without changing result caching",
    async (operation) => {
      let requestBody: unknown;
      server.use(
        http.post(
          "http://localhost:3000/api/social/request",
          async ({ request }) => {
            requestBody = await request.json();
            return HttpResponse.json(
              socialResponse(`youtube_${operation}`, null, {
                transcript: "Fresh captions",
                summary: "Fresh summary",
              }),
            );
          },
        ),
      );

      const isSummary = operation === "summarize";
      await socialCommand.parseAsync([
        "node",
        "okou",
        operation,
        "https://youtu.be/example",
        "--refresh",
        ...(isSummary ? ["--prompt", "Focus on outcomes"] : []),
        "--json",
      ]);

      expect(requestBody).toStrictEqual({
        tool: `youtube_${operation}`,
        input: {
          url: "https://youtu.be/example",
          no_cache: true,
          ...(isSummary ? { custom_prompt: "Focus on outcomes" } : {}),
        },
      });
      expect(outputRequest()).toStrictEqual({
        refresh: true,
        ...(isSummary ? { customPrompt: true } : {}),
      });
      expect(JSON.parse(output()) as unknown).toMatchObject({
        status: "complete",
        operation,
        platform: "youtube",
        data: isSummary
          ? { summary: "Fresh summary" }
          : { transcript: "Fresh captions" },
      });
    },
  );

  it.each(["transcript", "summarize"])(
    "rejects unsupported %s refresh before requesting managed work",
    async (operation) => {
      let requests = 0;
      server.use(
        http.post("http://localhost:3000/api/social/request", () => {
          requests += 1;
          return HttpResponse.json({});
        }),
      );

      await expect(
        socialCommand.parseAsync([
          "node",
          "okou",
          operation,
          "https://instagram.com/reel/example",
          "--refresh",
          "--json",
        ]),
      ).rejects.toThrow("process.exit called");

      expect(requests).toBe(0);
      expect(JSON.parse(errorOutput()) as unknown).toMatchObject({
        status: "error",
        error: {
          code: "INVALID_INPUT",
          message: "--refresh is supported only for YouTube videos",
          retryable: false,
        },
      });
      expect(mockExit).toHaveBeenCalledWith(1);
    },
  );

  it.each([
    ["transcript", 404, "SOCIAL_TRANSCRIPT_UNAVAILABLE"],
    ["summarize", 400, "BAD_REQUEST"],
  ])(
    "preserves %s refresh failures (%s) without retrying",
    async (operation, status, code) => {
      let requests = 0;
      server.use(
        http.post("http://localhost:3000/api/social/request", () => {
          requests += 1;
          return HttpResponse.json(
            { error: { code, message: "Requested extraction is unavailable" } },
            { status },
          );
        }),
      );

      await expect(
        socialCommand.parseAsync([
          "node",
          "okou",
          operation,
          "https://youtu.be/example",
          "--refresh",
          "--json",
        ]),
      ).rejects.toThrow("process.exit called");

      expect(requests).toBe(1);
      expect(JSON.parse(errorOutput()) as unknown).toMatchObject({
        status: "error",
        error: { code, httpStatus: status, retryable: false },
      });
      expect(mockExit).toHaveBeenCalledWith(1);
    },
  );

  it.each([
    ["https://www.facebook.com/example/videos/1", "facebook_summarize"],
    ["https://www.instagram.com/reel/example", "instagram_summarize"],
    ["https://www.tiktok.com/@example/video/1", "tiktok_summarize"],
    ["https://youtu.be/example", "youtube_summarize"],
  ])("extracts custom summary fields from %s", async (url, expectedTool) => {
    const fields = {
      audience: "Who this video helps",
      actionItems: 'Practical next steps, including "quoted" advice\n保留原文',
    };
    const data = {
      audience: ["Small business owners"],
      actionItems: [{ task: "Review customer feedback", owner: null }],
      hasOffer: false,
      offerCount: 0,
    };
    let requestBody: unknown;
    server.use(
      http.post(
        "http://localhost:3000/api/social/request",
        async ({ request }) => {
          requestBody = await request.json();
          return HttpResponse.json(socialResponse(expectedTool, null, data));
        },
      ),
    );

    await socialCommand.parseAsync([
      "node",
      "okou",
      "summarize",
      url,
      "--fields",
      JSON.stringify(fields),
      "--json",
    ]);

    expect(requestBody).toStrictEqual({
      tool: expectedTool,
      input: { url, custom_response: fields },
    });
    expect(JSON.parse(output()) as unknown).toMatchObject({
      status: "complete",
      data,
      request: { customFields: true, customPrompt: false },
    });
    expect(output()).not.toContain(fields.audience);
  });

  it.each([false, true])(
    "reads a fields file with prompt instructions (refresh: %s)",
    async (refresh) => {
      const fields = {
        audience: "Who this video helps",
        topics: "Main business topics",
      };
      const path = await fieldsFile(` ${JSON.stringify(fields, null, 2)}\r\n`);
      let requestBody: unknown;
      server.use(
        http.post(
          "http://localhost:3000/api/social/request",
          async ({ request }) => {
            requestBody = await request.json();
            return HttpResponse.json(
              socialResponse("youtube_summarize", null, {
                audience: "Business owners",
                topics: ["Customer retention"],
              }),
            );
          },
        ),
      );

      await socialCommand.parseAsync([
        "node",
        "okou",
        "summarize",
        "https://youtu.be/example",
        "--fields-file",
        path,
        "--prompt",
        "Write in plain English",
        ...(refresh ? ["--refresh"] : []),
        "--json",
      ]);

      expect(requestBody).toStrictEqual({
        tool: "youtube_summarize",
        input: {
          url: "https://youtu.be/example",
          custom_response: fields,
          custom_prompt: "Write in plain English",
          ...(refresh ? { no_cache: true } : {}),
        },
      });
      expect(outputRequest()).toStrictEqual({
        customFields: true,
        customPrompt: true,
        ...(refresh ? { refresh: true } : {}),
      });
      expect(output()).not.toContain(path);
    },
  );

  it("preserves default summary requests without customization", async () => {
    let requestBody: unknown;
    server.use(
      http.post(
        "http://localhost:3000/api/social/request",
        async ({ request }) => {
          requestBody = await request.json();
          return HttpResponse.json(
            socialResponse("youtube_summarize", null, { summary: "Example" }),
          );
        },
      ),
    );

    await socialCommand.parseAsync([
      "node",
      "okou",
      "summarize",
      "https://youtu.be/example",
      "--json",
    ]);

    expect(requestBody).toStrictEqual({
      tool: "youtube_summarize",
      input: { url: "https://youtu.be/example" },
    });
    expect(outputRequest()).toStrictEqual({ customPrompt: false });
  });

  it("accepts the compact serialized fields limit with Unicode and file whitespace", async () => {
    const fields = { audience: "界".repeat(4096 - '{"audience":""}'.length) };
    const path = await fieldsFile(
      `${" ".repeat(4096)}${JSON.stringify(fields)}\n`,
    );
    let requestBody: unknown;
    server.use(
      http.post(
        "http://localhost:3000/api/social/request",
        async ({ request }) => {
          requestBody = await request.json();
          return HttpResponse.json(
            socialResponse("youtube_summarize", null, {
              audience: "Business owners",
            }),
          );
        },
      ),
    );

    await socialCommand.parseAsync([
      "node",
      "okou",
      "summarize",
      "https://youtu.be/example",
      "--fields-file",
      path,
      "--json",
    ]);

    expect(requestBody).toMatchObject({ input: { custom_response: fields } });
    expect(JSON.parse(output()) as unknown).toMatchObject({
      status: "complete",
    });
  });

  it.each([
    ["malformed JSON", "{not-json}"],
    ["empty input", ""],
    ["string instructions", '"Extract the audience"'],
    ["null", "null"],
    ["array", '["audience"]'],
    ["empty map", "{}"],
    ["empty name", '{"":"Who this video helps"}'],
    ["blank name", '{" ":"Who this video helps"}'],
    ["long name", JSON.stringify({ ["a".repeat(65)]: "Audience" })],
    ["empty description", '{"audience":""}'],
    ["blank description", '{"audience":" \\n\\t"}'],
    ["non-string description", '{"audience":true}'],
    ["nested schema", '{"audience":{"type":"string"}}'],
    [
      "oversized map",
      JSON.stringify({ audience: "a".repeat(4097 - '{"audience":""}'.length) }),
    ],
    ["oversized escaped map", JSON.stringify({ audience: "\n".repeat(2042) })],
  ])("rejects %s fields before a managed request", async (_name, fields) => {
    let apiRequests = 0;
    server.use(
      http.post("http://localhost:3000/api/social/request", () => {
        apiRequests += 1;
        return HttpResponse.json(socialResponse("youtube_summarize", null, {}));
      }),
    );

    await expect(
      socialCommand.parseAsync([
        "node",
        "okou",
        "summarize",
        "https://youtu.be/example",
        "--fields",
        fields,
        "--json",
      ]),
    ).rejects.toThrow("process.exit called");

    expect(apiRequests).toBe(0);
    expect(mockExit).toHaveBeenCalledWith(1);
    expect(JSON.parse(errorOutput()) as unknown).toMatchObject({
      status: "error",
      error: { kind: "invalid_input", retryable: false },
    });
  });

  it.each(["malformed", "oversized", "missing", "conflicting"])(
    "rejects a %s fields file before a managed request",
    async (problem) => {
      const path = await fieldsFile(
        problem === "malformed"
          ? "{not-json}"
          : JSON.stringify({ audience: "a".repeat(4096) }),
      );
      const suppliedPath = problem === "missing" ? `${path}.missing` : path;
      const args = ["--fields-file", suppliedPath];
      if (problem === "conflicting") {
        args.push("--fields", '{"audience":"Who this video helps"}');
      }
      let apiRequests = 0;
      server.use(
        http.post("http://localhost:3000/api/social/request", () => {
          apiRequests += 1;
          return HttpResponse.json(
            socialResponse("youtube_summarize", null, {}),
          );
        }),
      );

      await expect(
        socialCommand.parseAsync([
          "node",
          "okou",
          "summarize",
          "https://youtu.be/example",
          ...args,
          "--json",
        ]),
      ).rejects.toThrow("process.exit called");

      expect(apiRequests).toBe(0);
      expect(JSON.parse(errorOutput()) as unknown).toMatchObject({
        error: { kind: "invalid_input" },
      });
      if (problem === "missing") {
        expect(errorOutput()).toContain("Cannot read --fields-file");
        expect(errorOutput()).toContain(suppliedPath);
      } else if (problem === "malformed") {
        expect(errorOutput()).toContain(
          "--fields-file must contain valid JSON",
        );
        expect(errorOutput()).not.toContain("not-json");
      } else if (problem === "conflicting") {
        expect(errorOutput()).toContain("Use either --fields or --fields-file");
      } else {
        expect(errorOutput()).toContain("4096 characters");
      }
    },
  );

  it.each([
    ["summarize", "https://x.com/example/status/1"],
    ["summarize", "https://linkedin.com/posts/example"],
    ["transcript", "https://youtu.be/example"],
  ])("rejects fields on unsupported %s targets %s", async (operation, url) => {
    let apiRequests = 0;
    server.use(
      http.post("http://localhost:3000/api/social/request", () => {
        apiRequests += 1;
        return HttpResponse.json(socialResponse("youtube_summarize", null, {}));
      }),
    );

    await expect(
      socialCommand.parseAsync([
        "node",
        "okou",
        operation,
        url,
        "--fields",
        '{"audience":"Who this video helps"}',
        "--json",
      ]),
    ).rejects.toThrow("process.exit called");

    expect(apiRequests).toBe(0);
    expect(`${errorOutput()}${parserErrorOutput()}`).toContain("invalid_input");
  });

  it("discovers fields support only on reviewed summary platforms", async () => {
    await socialCommand.parseAsync(["node", "okou", "capabilities", "--json"]);

    const result = JSON.parse(output()) as {
      capabilities: {
        platform: string;
        operations: string[];
        notes?: string[];
      }[];
    };
    const supported = result.capabilities.filter((capability) => {
      return capability.notes?.some((note) => {
        return note.includes("--fields-file");
      });
    });
    expect(
      supported.map((capability) => {
        return capability.platform;
      }),
    ).toStrictEqual(["facebook", "instagram", "tiktok", "youtube"]);
    for (const capability of supported) {
      expect(capability.operations).toContain("summarize");
      expect(capability.notes?.join(" ")).toContain("not strict JSON Schema");
    }
  });

  it("aggregates pages, trims provider overshoot, and totals billing", async () => {
    const requests: unknown[] = [];
    server.use(
      http.post(
        "http://localhost:3000/api/social/request",
        async ({ request }) => {
          requests.push(await request.json());
          const firstPage = requests.length === 1;
          const comments = Array.from({ length: 7 }, (_, index) => {
            return { id: `${firstPage ? "a" : "b"}-${index}` };
          });
          return HttpResponse.json(
            socialResponse(
              "instagram_comments",
              {
                state: "more",
                itemsReturned: 7,
                reportedTotal: 82,
                nextInput: { cursor: firstPage ? "next" : "after-next" },
              },
              { comments, hasMore: true, commentCount: 82 },
              2,
            ),
          );
        },
      ),
    );

    await socialCommand.parseAsync([
      "node",
      "okou",
      "comments",
      "https://instagram.com/p/example",
      "--limit",
      "10",
      "--json",
    ]);

    expect(requests).toHaveLength(2);
    expect(requests[0]).toHaveProperty("input.limit", 10);
    expect(requests[1]).toHaveProperty("input.limit", 3);
    const result = JSON.parse(output()) as {
      readonly status: string;
      readonly request: Readonly<Record<string, unknown>>;
      readonly data: { readonly items: readonly unknown[] };
      readonly collection: Readonly<Record<string, unknown>>;
      readonly billing: Readonly<Record<string, unknown>>;
    };
    expect(result.status).toBe("complete");
    expect(result.request).toStrictEqual({ limit: 10 });
    expect(result.data.items).toHaveLength(10);
    expect(result.collection).toMatchObject({
      state: "caller_limited",
      pages: 2,
      itemsReturned: 10,
      itemsObserved: 14,
      requestedItems: 10,
      reportedTotal: 82,
    });
    expect(result.billing).toMatchObject({
      quantity: 4,
      creditsCharged: 12,
    });
  });

  it("marks a complete provider page caller-limited when trimming overshoot", async () => {
    server.use(
      http.post("http://localhost:3000/api/social/request", () => {
        return HttpResponse.json(
          socialResponse(
            "youtube_search",
            { state: "complete", itemsReturned: 3 },
            {
              results: [{ id: "one" }, { id: "two" }, { id: "three" }],
              hasMore: false,
            },
          ),
        );
      }),
    );

    await socialCommand.parseAsync([
      "node",
      "okou",
      "search",
      "launch",
      "--platform",
      "youtube",
      "--limit",
      "2",
      "--json",
    ]);

    expect(JSON.parse(output()) as unknown).toMatchObject({
      status: "complete",
      data: { items: [{ id: "one" }, { id: "two" }] },
      collection: {
        state: "caller_limited",
        itemsReturned: 2,
        itemsObserved: 3,
      },
      warnings: [{ code: "RESULT_LIMIT_REACHED" }],
    });
  });

  it("marks an unsatisfied provider-limited collection partial", async () => {
    server.use(
      http.post("http://localhost:3000/api/social/request", () => {
        return HttpResponse.json(
          socialResponse(
            "youtube_comments",
            {
              state: "provider_limited",
              itemsReturned: 2,
              reason: "no_pagination",
            },
            { comments: [{ id: "1" }, { id: "2" }] },
          ),
        );
      }),
    );

    await socialCommand.parseAsync([
      "node",
      "okou",
      "comments",
      "https://youtu.be/example",
      "--limit",
      "10",
      "--json",
    ]);

    expect(JSON.parse(output()) as unknown).toMatchObject({
      status: "partial",
      collection: {
        state: "provider_limited",
        itemsReturned: 2,
        requestedItems: 10,
      },
      warnings: [{ code: "PROVIDER_LIMITED" }],
    });
    expect(process.exitCode).toBe(2);
  });

  it("detects repeated pagination and emits a structured error", async () => {
    let requests = 0;
    server.use(
      http.post("http://localhost:3000/api/social/request", () => {
        requests += 1;
        return HttpResponse.json(
          socialResponse(
            "tiktok_search",
            {
              state: "more",
              itemsReturned: 1,
              nextInput: { cursor: "same" },
            },
            {
              results: [{ id: `video-${requests}` }],
              hasMore: true,
              cursor: "same",
            },
          ),
        );
      }),
    );

    await socialCommand.parseAsync([
      "node",
      "okou",
      "search",
      "launch",
      "--platform",
      "tiktok",
      "--limit",
      "10",
      "--json",
    ]);

    expect(requests).toBe(2);
    expect(JSON.parse(output()) as unknown).toMatchObject({
      kind: "result",
      status: "partial",
      data: { items: [{ id: "video-1" }, { id: "video-2" }] },
      collection: { state: "failed", pages: 2, itemsReturned: 2 },
      billing: { quantity: 2, creditsCharged: 6 },
    });
    expect(JSON.parse(output()) as unknown).not.toHaveProperty(
      "collection.nextInput",
    );
    expect(JSON.parse(errorOutput()) as unknown).toMatchObject({
      status: "error",
      error: {
        kind: "internal",
        code: "INTERNAL",
        message: "Okou Social returned a repeated pagination state",
      },
      progress: { pages: 2, itemsReturned: 2 },
    });
    expect(process.exitCode).toBe(1);
    expect(mockExit).not.toHaveBeenCalled();
  });

  it.each([
    ["aggregate HTTP failure", "--json", "http"],
    ["stream HTTP failure", "--stream", "http"],
    ["default HTTP failure", "", "http"],
    ["aggregate structured HTTP failure", "--json", "structured"],
    ["stream structured HTTP failure", "--stream", "structured"],
    ["aggregate malformed response", "--json", "malformed"],
    ["stream malformed response", "--stream", "malformed"],
    ["aggregate missing metadata", "--json", "metadata"],
    ["stream missing metadata", "--stream", "metadata"],
  ])("preserves accepted results after %s", async (_name, format, failure) => {
    const requests: unknown[] = [];
    server.use(
      http.post(
        "http://localhost:3000/api/social/request",
        async ({ request }) => {
          requests.push(await request.json());
          if (requests.length === 1) {
            return HttpResponse.json(
              socialResponse(
                "instagram_comments",
                {
                  state: "more",
                  itemsReturned: 2,
                  reportedTotal: 12,
                  nextInput: { cursor: "next" },
                },
                {
                  comments: [{ id: "one" }, { id: "two" }],
                  hasMore: true,
                  commentCount: 12,
                },
                2,
              ),
            );
          }
          if (failure === "malformed" || failure === "metadata") {
            return HttpResponse.json(
              socialResponse(
                "instagram_comments",
                failure === "metadata"
                  ? null
                  : { state: "complete", itemsReturned: 1 },
                {
                  comments: failure === "malformed" ? null : [{ id: "third" }],
                },
              ),
            );
          }
          return HttpResponse.json(
            {
              error: {
                code: "SOCIALKIT_UPSTREAM_ERROR",
                message: "SocialKit request failed",
                ...(failure === "structured"
                  ? {
                      reason: "upstream_failure",
                      retryable: false,
                      retryAfterSeconds: 120,
                    }
                  : {}),
              },
            },
            { status: 502 },
          );
        },
      ),
    );

    await socialCommand.parseAsync([
      "node",
      "okou",
      "comments",
      "https://instagram.com/p/example",
      "--limit",
      "10",
      ...(format ? [format] : []),
    ]);

    expect(requests).toHaveLength(2);
    expect(requests[1]).toHaveProperty("input.cursor", "next");
    expect(requests[1]).toHaveProperty("input.limit", 8);
    const records = mockConsoleLog.mock.calls.map(([value]) => {
      return JSON.parse(String(value)) as Readonly<Record<string, unknown>>;
    });
    const streaming = format === "--stream";
    expect(records).toHaveLength(streaming ? 2 : 1);
    const terminal = records.at(-1);
    const progress = {
      pages: 1,
      itemsReturned: 2,
      itemsObserved: 2,
      billingQuantity: 2,
      creditsCharged: 6,
    };
    const error =
      failure === "http"
        ? {
            kind: "provider_temporary",
            code: "SOCIAL_UPSTREAM_ERROR",
            retryable: true,
          }
        : failure === "structured"
          ? {
              kind: "upstream_failure",
              code: "SOCIAL_UPSTREAM_ERROR",
              reason: "upstream_failure",
              retryable: false,
              retryAfterSeconds: 120,
            }
          : { kind: "internal", code: "INTERNAL", retryable: false };
    expect(terminal).toMatchObject({
      kind: streaming ? "summary" : "result",
      status: "partial",
      collection: {
        state: "failed",
        pages: 1,
        itemsReturned: 2,
        itemsObserved: 2,
        requestedItems: 10,
        reportedTotal: 12,
        nextInput: { cursor: "next" },
      },
      billing: { quantity: 2, creditsCharged: 6 },
      error,
      progress,
    });
    expect(records[0]).toHaveProperty("data.items", [
      { id: "one" },
      { id: "two" },
    ]);
    expect(records[0]).toHaveProperty("data.context.commentCount", 12);
    if (streaming) {
      expect(records[0]).toMatchObject({ kind: "page", page: 1 });
      expect(terminal).not.toHaveProperty("data");
    }
    if (format) {
      expect(JSON.parse(errorOutput()) as unknown).toMatchObject({
        status: "error",
        error,
        progress,
      });
    } else {
      expect(errorOutput()).toContain("502:");
    }
    expect(process.exitCode).toBe(1);
    expect(mockExit).not.toHaveBeenCalled();
  });

  it.each(["--json", "--stream"])(
    "emits one terminal outcome for a first-page failure with %s",
    async (format) => {
      let requests = 0;
      server.use(
        http.post("http://localhost:3000/api/social/request", () => {
          requests += 1;
          return HttpResponse.json(
            {
              error: { code: "SOCIAL_UPSTREAM_ERROR", message: "Unavailable" },
            },
            { status: 502 },
          );
        }),
      );

      await socialCommand.parseAsync([
        "node",
        "okou",
        "comments",
        "https://instagram.com/p/example",
        format,
      ]);

      const records = mockConsoleLog.mock.calls.map(([value]) => {
        return JSON.parse(String(value)) as Readonly<Record<string, unknown>>;
      });
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        kind: format === "--stream" ? "summary" : "result",
        status: "error",
        collection: {
          state: "failed",
          pages: 0,
          itemsReturned: 0,
          itemsObserved: 0,
          requestedItems: 10,
        },
        billing: null,
        progress: {
          pages: 0,
          itemsReturned: 0,
          itemsObserved: 0,
          billingQuantity: 0,
          creditsCharged: 0,
        },
        error: { code: "SOCIAL_UPSTREAM_ERROR", httpStatus: 502 },
      });
      expect(records[0]).not.toHaveProperty("collection.nextInput");
      if (format === "--stream") {
        expect(records[0]).not.toHaveProperty("data");
      } else {
        expect(records[0]).toHaveProperty("data.items", []);
      }
      expect(requests).toBe(1);
      expect(process.exitCode).toBe(1);
      expect(mockExit).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["empty", "--json", 0],
    ["empty", "--stream", 0],
    ["complete", "--json", 2],
    ["complete", "--stream", 2],
  ] as const)(
    "emits one terminal outcome for %s results with %s",
    async (_name, format, count) => {
      const items = Array.from({ length: count }, (_, index) => {
        return { id: String(index) };
      });
      server.use(
        http.post("http://localhost:3000/api/social/request", () => {
          return HttpResponse.json(
            socialResponse(
              "instagram_comments",
              { state: "complete", itemsReturned: items.length },
              { comments: items, hasMore: false },
            ),
          );
        }),
      );

      await socialCommand.parseAsync([
        "node",
        "okou",
        "comments",
        "https://instagram.com/p/example",
        format,
      ]);

      const records = mockConsoleLog.mock.calls.map(([value]) => {
        return JSON.parse(String(value)) as Readonly<Record<string, unknown>>;
      });
      expect(records).toHaveLength(format === "--stream" ? 2 : 1);
      expect(records[0]).toHaveProperty("data.items", items);
      expect(records.at(-1)).toMatchObject({
        kind: format === "--stream" ? "summary" : "result",
        status: "complete",
        collection: {
          state: "complete",
          pages: 1,
          itemsReturned: items.length,
        },
        billing: { quantity: 1, creditsCharged: 3 },
      });
      expect(records.at(-1)).not.toHaveProperty("error");
      if (format === "--stream") {
        expect(records.at(-1)).not.toHaveProperty("data");
      }
      expect(errorOutput()).toBe("");
      expect(process.exitCode ?? 0).toBe(0);
      expect(mockExit).not.toHaveBeenCalled();
    },
  );

  it.each([
    { continuation: "cursor", nextInput: { cursor: "next" } },
    { continuation: "unsupported page", nextInput: { page: 2 } },
  ] as const)(
    "preserves only validated continuation after $continuation is offered",
    async ({ nextInput }) => {
      const requests: unknown[] = [];
      server.use(
        http.post(
          "http://localhost:3000/api/social/request",
          async ({ request }) => {
            requests.push(await request.json());
            if (requests.length === 1) {
              return HttpResponse.json(
                socialResponse(
                  "instagram_comments",
                  {
                    state: "more",
                    itemsReturned: 1,
                    nextInput,
                  },
                  { comments: [{ id: "one" }], hasMore: true },
                ),
              );
            }
            return HttpResponse.json(
              {
                error: {
                  code: "SOCIAL_UPSTREAM_ERROR",
                  message: "Unavailable",
                },
              },
              { status: 502 },
            );
          },
        ),
      );

      await socialCommand.parseAsync([
        "node",
        "okou",
        "comments",
        "https://instagram.com/p/example",
        "--json",
      ]);

      const result = JSON.parse(output()) as unknown;
      expect(result).toMatchObject({
        status: "partial",
        data: { items: [{ id: "one" }] },
        collection: { state: "failed", pages: 1, itemsReturned: 1 },
        billing: { quantity: 1, creditsCharged: 3 },
      });
      if ("cursor" in nextInput) {
        expect(requests).toHaveLength(2);
        expect(requests[1]).toHaveProperty("input.cursor", "next");
        expect(requests[1]).toHaveProperty("input.limit", 9);
        expect(result).toHaveProperty("collection.nextInput", nextInput);
      } else {
        expect(requests).toHaveLength(1);
        expect(result).not.toHaveProperty("collection.nextInput");
        expect(result).toHaveProperty("error.kind", "internal");
      }
      expect(process.exitCode).toBe(1);
    },
  );

  it.each(["more", "provider_limited"] as const)(
    "streams one terminal outcome when %s limits collection",
    async (state) => {
      let requests = 0;
      server.use(
        http.post("http://localhost:3000/api/social/request", () => {
          requests += 1;
          return HttpResponse.json(
            socialResponse(
              "instagram_comments",
              state === "more"
                ? { state, itemsReturned: 3, nextInput: { cursor: "next" } }
                : { state, itemsReturned: 3, reason: "provider_ceiling" },
              {
                comments: [{ id: "one" }, { id: "two" }, { id: "three" }],
                hasMore: true,
              },
            ),
          );
        }),
      );

      await socialCommand.parseAsync([
        "node",
        "okou",
        "comments",
        "https://instagram.com/p/example",
        "--limit",
        state === "more" ? "2" : "10",
        "--stream",
      ]);

      const records = mockConsoleLog.mock.calls.map(([value]) => {
        return JSON.parse(String(value)) as Readonly<Record<string, unknown>>;
      });
      expect(records).toHaveLength(2);
      expect(records[0]).toHaveProperty(
        "data.items",
        state === "more"
          ? [{ id: "one" }, { id: "two" }]
          : [{ id: "one" }, { id: "two" }, { id: "three" }],
      );
      expect(records[1]).toMatchObject({
        kind: "summary",
        status: state === "more" ? "complete" : "partial",
        collection: {
          state: state === "more" ? "caller_limited" : "provider_limited",
          pages: 1,
          itemsReturned: state === "more" ? 2 : 3,
          itemsObserved: 3,
        },
        billing: { quantity: 1, creditsCharged: 3 },
      });
      expect(records[1]).not.toHaveProperty("data");
      expect(records[1]).not.toHaveProperty("error");
      expect(requests).toBe(1);
      expect(process.exitCode ?? 0).toBe(state === "more" ? 0 : 2);
    },
  );

  it("retains the pending cursor in the safety-ceiling summary", async () => {
    let requests = 0;
    server.use(
      http.post("http://localhost:3000/api/social/request", () => {
        requests += 1;
        return HttpResponse.json(
          socialResponse(
            "instagram_comments",
            {
              state: "more",
              itemsReturned: 1,
              nextInput: { cursor: `after-${requests}` },
            },
            { comments: [{ id: String(requests) }], hasMore: true },
          ),
        );
      }),
    );

    await socialCommand.parseAsync([
      "node",
      "okou",
      "comments",
      "https://instagram.com/p/example",
      "--limit",
      "101",
      "--stream",
    ]);

    const records = mockConsoleLog.mock.calls.map(([value]) => {
      return JSON.parse(String(value)) as Readonly<Record<string, unknown>>;
    });
    expect(requests).toBe(100);
    expect(records).toHaveLength(101);
    expect(records.at(-1)).toMatchObject({
      kind: "summary",
      status: "partial",
      collection: {
        state: "provider_limited",
        reason: "safety_page_ceiling",
        pages: 100,
        itemsReturned: 100,
        nextInput: { cursor: "after-100" },
      },
      billing: { quantity: 100, creditsCharged: 300 },
    });
    expect(records.at(-1)).not.toHaveProperty("data");
    expect(process.exitCode).toBe(2);
  });

  it("streams only when explicitly requested", async () => {
    let requests = 0;
    server.use(
      http.post("http://localhost:3000/api/social/request", () => {
        requests += 1;
        const firstPage = requests === 1;
        return HttpResponse.json(
          socialResponse(
            "instagram_comments",
            firstPage
              ? {
                  state: "more",
                  itemsReturned: 1,
                  nextInput: { cursor: "next" },
                }
              : { state: "complete", itemsReturned: 1 },
            {
              comments: [{ id: String(requests) }],
              hasMore: firstPage,
              ...(firstPage ? { cursor: "next" } : {}),
            },
          ),
        );
      }),
    );

    await socialCommand.parseAsync([
      "node",
      "okou",
      "comments",
      "https://instagram.com/p/example",
      "--limit",
      "10",
      "--stream",
    ]);

    const records = mockConsoleLog.mock.calls.map(([value]) => {
      return JSON.parse(String(value)) as Readonly<Record<string, unknown>>;
    });
    expect(records).toHaveLength(3);
    expect(records[0]).toMatchObject({
      kind: "page",
      page: 1,
      request: { limit: 10 },
    });
    expect(records[1]).toMatchObject({
      kind: "page",
      page: 2,
      request: { limit: 10 },
    });
    expect(records[2]).toMatchObject({
      kind: "summary",
      status: "complete",
      request: { limit: 10 },
      collection: { pages: 2 },
    });
    expect(records[2]).not.toHaveProperty("data");
  });

  it.each([
    {
      reason: "content_restricted",
      status: 422,
      retryable: false,
      expected: false,
    },
    { reason: "no_transcript", status: 404, retryable: false, expected: false },
    {
      reason: "transcript_not_ready",
      status: 404,
      retryable: false,
      expected: false,
    },
    {
      reason: "content_unavailable",
      status: 404,
      retryable: false,
      expected: false,
    },
    {
      reason: "provider_quota_exhausted",
      status: 503,
      retryable: false,
      expected: false,
    },
    {
      reason: "upstream_failure",
      status: 502,
      retryable: false,
      expected: false,
    },
    {
      reason: "upstream_failure",
      status: 502,
      retryable: true,
      expected: true,
    },
    { reason: "rate_limited", status: 429, retryable: true, expected: true },
    { reason: "future_reason", status: 503, retryable: false, expected: false },
    {
      reason: "upstream_failure",
      status: 503,
      retryable: "false",
      expected: true,
    },
  ])(
    "prints $reason / $retryable without broad retry guesses",
    async (testCase) => {
      let requests = 0;
      server.use(
        http.post("http://localhost:3000/api/social/request", () => {
          requests += 1;
          return HttpResponse.json(
            {
              error: {
                code: "SOCIAL_FAILURE",
                message: "The social request failed",
                reason: testCase.reason,
                retryable: testCase.retryable,
                retryAfterSeconds: 24,
              },
            },
            { status: testCase.status },
          );
        }),
      );
      await expect(
        socialCommand.parseAsync([
          "node",
          "okou",
          "transcript",
          "https://youtu.be/example",
          "--json",
        ]),
      ).rejects.toThrow("process.exit called");
      expect(JSON.parse(errorOutput()) as unknown).toMatchObject({
        error: {
          kind:
            testCase.reason === "future_reason"
              ? "provider_temporary"
              : testCase.reason,
          retryable: testCase.expected,
          retryAfterSeconds: 24,
        },
      });
      expect(requests).toBe(1);
    },
  );

  it("explains retry delay and quota ownership in human output", async () => {
    server.use(
      http.post("http://localhost:3000/api/social/request", () => {
        return HttpResponse.json(
          {
            error: {
              code: "SOCIAL_QUOTA_EXHAUSTED",
              message:
                "The social data service has insufficient provider credits",
              reason: "provider_quota_exhausted",
              retryable: false,
              retryAfterSeconds: 120,
            },
          },
          { status: 503 },
        );
      }),
    );
    await expect(
      socialCommand.parseAsync([
        "node",
        "okou",
        "transcript",
        "https://youtu.be/example",
      ]),
    ).rejects.toThrow("process.exit called");
    expect(errorOutput()).toContain("provider_quota_exhausted");
    expect(errorOutput()).toContain("Retryable: no");
    expect(errorOutput()).toContain("Retry after: 120 seconds");
  });

  it("emits structured API failures and exits non-zero", async () => {
    server.use(
      http.post("http://localhost:3000/api/social/request", () => {
        return HttpResponse.json(
          {
            error: {
              code: "SOCIAL_UPSTREAM_ERROR",
              message: "The social data service is temporarily unavailable",
            },
          },
          { status: 502 },
        );
      }),
    );

    await expect(
      socialCommand.parseAsync([
        "node",
        "okou",
        "inspect",
        "https://instagram.com/p/example",
        "--json",
      ]),
    ).rejects.toThrow("process.exit called");

    expect(JSON.parse(errorOutput()) as unknown).toStrictEqual({
      status: "error",
      error: {
        kind: "provider_temporary",
        code: "SOCIAL_UPSTREAM_ERROR",
        message: "The social data service is temporarily unavailable",
        httpStatus: 502,
        retryable: true,
      },
    });
  });

  it.each([
    [
      "invalid option value",
      ["posts", "https://x.com/example", "--limit", "invalid", "--json"],
    ],
    ["missing required option", ["search", "launch", "--json"]],
    ["invalid argument value", ["capabilities", "unsupported", "--json"]],
    [
      "nonpositive full-details limit",
      [
        "posts",
        "https://youtube.com/@example",
        "--full-details",
        "--limit",
        "0",
        "--json",
      ],
    ],
    ["invalid resume ID", ["download", "--resume", "not-a-uuid", "--json"]],
    [
      "streaming option value",
      [
        "comments",
        "https://youtu.be/example",
        "--limit",
        "invalid",
        "--stream",
      ],
    ],
  ])("emits structured parser failures for %s", async (_case, args) => {
    await expect(
      socialCommand.parseAsync(["node", "okou", ...args]),
    ).rejects.toThrow("process.exit called");

    expect(JSON.parse(parserErrorOutput()) as unknown).toMatchObject({
      status: "error",
      error: {
        kind: "invalid_input",
        code: "INVALID_INPUT",
        retryable: false,
      },
    });
  });

  it.each([
    "https://example.com/video",
    "https://instagram.com.example.com/user/p/ABC123/",
    "https://user:password@instagram.com/user/reel/ABC123/",
    "https://instagram.com/explore/p/ABC123/",
  ])("rejects unsupported URL %s before managed work", async (url) => {
    let apiRequests = 0;
    server.use(
      http.post("http://localhost:3000/api/social/request", () => {
        apiRequests += 1;
        return HttpResponse.json(socialResponse("youtube_stats", null, {}));
      }),
    );

    await expect(
      socialCommand.parseAsync(["node", "okou", "inspect", url, "--json"]),
    ).rejects.toThrow("process.exit called");

    expect(apiRequests).toBe(0);
    expect(JSON.parse(errorOutput()) as unknown).toMatchObject({
      status: "error",
      error: { kind: "invalid_input", code: "INVALID_INPUT" },
    });
  });

  it.each([
    ["transcript", "https://instagram.com/example"],
    ["transcript", "https://youtube.com/"],
    ["transcript", "https://youtu.be/"],
    ["transcript", "https://vm.tiktok.com/"],
    ["transcript", "https://instagram.com/explore/"],
    ["transcript", "https://linkedin.com/posts"],
    ["transcript", "https://facebook.com/watch"],
    ["transcript", "https://facebook.com/marketplace?v=example"],
    ["transcript", "https://facebook.com/marketplace?fbid=example"],
    ["transcript", "https://facebook.com/marketplace?story_fbid=example"],
    ["transcript", "https://facebook.com/video.php/extra?v=example"],
    ["transcript", "https://facebook.com/photo.php/extra?fbid=example"],
    [
      "transcript",
      "https://facebook.com/permalink.php/extra?story_fbid=example",
    ],
    ["transcript", "https://facebook.com/story.php/extra?story_fbid=example"],
    ["transcript", "https://fb.watch/example/extra"],
    ["transcript", "https://vm.tiktok.com/example/extra"],
    ["transcript", "https://vt.tiktok.com/example/extra"],
    ["transcript", "https://tiktok.com/t/example/extra"],
    ["transcript", "https://youtube.com/results?v=example"],
    ["transcript", "https://youtu.be/example/extra"],
    ["transcript", "https://youtube.com/playlist/extra?list=example"],
  ])(
    "rejects mismatched %s target %s before managed work",
    async (operation, url) => {
      let apiRequests = 0;
      server.use(
        http.post("http://localhost:3000/api/social/request", () => {
          apiRequests += 1;
          return HttpResponse.json(
            socialResponse("youtube_transcript", null, {}),
          );
        }),
      );

      await expect(
        socialCommand.parseAsync(["node", "okou", operation, url, "--json"]),
      ).rejects.toThrow("process.exit called");

      expect(apiRequests).toBe(0);
      expect(JSON.parse(errorOutput()) as unknown).toMatchObject({
        status: "error",
        error: {
          kind: "invalid_input",
          message: "transcript requires a public post or video URL",
        },
      });
    },
  );

  it.each([
    ["inspect", "https://instagram.com/p/example", "--thread"],
    ["posts", "https://x.com/example", "--kind", "reels"],
    ["posts", "https://x.com/example", "--full-details"],
    ["posts", "https://instagram.com/example", "--full-details"],
    ["posts", "https://tiktok.com/@example", "--full-details"],
    ["posts", "https://facebook.com/example", "--full-details"],
    ["posts", "https://linkedin.com/company/example", "--full-details"],
    ["posts", "https://youtube.com/watch?v=example", "--full-details"],
    ["posts", "https://youtu.be/example", "--full-details"],
    [
      "search",
      "launch",
      "--platform",
      "tiktok",
      "--hashtag",
      "--sort",
      "likes",
    ],
    ["search", "launch", "--platform", "youtube", "--sort", ""],
    ["search", "launch", "--platform", "tiktok", "--date", ""],
    ["search", "launch", "--platform", "youtube", "--type", ""],
    ["comments", "https://facebook.com/posts/example", "--sort", ""],
    ["comments", "https://instagram.com/p/example", "--sort", ""],
    ["summarize", "https://youtu.be/example", "--prompt", ""],
    [
      "download",
      "https://youtu.be/example",
      "--max-duration",
      "600",
      "--quality",
      "",
    ],
    [
      "download",
      "https://youtu.be/example",
      "--max-duration",
      "600",
      "--format",
      "",
    ],
  ])("rejects mismatched %s options before managed work", async (...args) => {
    let apiRequests = 0;
    server.use(
      http.post("http://localhost:3000/api/social/request", () => {
        apiRequests += 1;
        return HttpResponse.json(socialResponse("youtube_stats", null, {}));
      }),
      http.post("http://localhost:3000/api/social/downloads", () => {
        apiRequests += 1;
        return HttpResponse.json(completedDownload(), { status: 202 });
      }),
    );

    await expect(
      socialCommand.parseAsync(["node", "okou", ...args, "--json"]),
    ).rejects.toThrow("process.exit called");

    expect(apiRequests).toBe(0);
    expect(JSON.parse(errorOutput()) as unknown).toMatchObject({
      status: "error",
      error: { kind: "invalid_input" },
    });
  });

  it("auto-detects downloads and prints the stable envelope", async () => {
    let requestBody: unknown;
    server.use(
      http.post(
        "http://localhost:3000/api/social/downloads",
        async ({ request }) => {
          requestBody = await request.json();
          return HttpResponse.json(completedDownload(), { status: 202 });
        },
      ),
    );

    await socialCommand.parseAsync([
      "node",
      "okou",
      "download",
      "https://youtu.be/example?si=tracking",
      "--max-duration",
      "600",
      "--json",
    ]);

    expect(requestBody).toStrictEqual({
      platform: "youtube",
      url: "https://youtu.be/example",
      maxDuration: 600,
      quality: "720p",
      format: "mp4",
    });
    expect(JSON.parse(output()) as unknown).toMatchObject({
      status: "complete",
      operation: "download",
      platform: "youtube",
      billing: { quantity: 2, creditsCharged: 6 },
      data: { status: "completed", artifact: { filename: "example.mp4" } },
      inlineMarkdownLink:
        "[example.mp4](<https://artifacts.example/video.mp4>)",
      previewMarkdownBlock:
        "![example.mp4](<https://artifacts.example/video.mp4>)",
      artifactPresentationContext: expect.stringContaining(
        "media file saved to Okou",
      ),
    });
    expect(outputRequest()).toStrictEqual({
      resume: false,
      maxDuration: 600,
      quality: "720p",
      format: "mp4",
    });
  });

  it("creates, polls and discovers an explicit MP3 audio download", async () => {
    const legacy = completedDownload();
    const completed = {
      ...legacy,
      quality: "1080p",
      format: "mp3",
      requested: { quality: "1080p", format: "mp3" },
      delivered: { quality: null, format: "mp3" },
      provider: { ...legacy.provider, quality: "1080p", format: "mp3" },
      artifact: {
        ...legacy.artifact,
        filename: "example.mp3",
        url: "https://artifacts.example/example.mp3",
        contentType: "audio/mpeg",
        format: "mp3",
      },
    };
    let requestBody: unknown;
    server.use(
      http.post(
        "http://localhost:3000/api/social/downloads",
        async ({ request }) => {
          requestBody = await request.json();
          return HttpResponse.json(
            {
              ...completed,
              status: "processing",
              delivered: { quality: null, format: null },
              provider: null,
              billing: null,
              artifact: null,
              completedAt: null,
            },
            { status: 202 },
          );
        },
      ),
      http.get("http://localhost:3000/api/social/downloads/:downloadId", () => {
        return HttpResponse.json(completed);
      }),
      http.get("http://localhost:3000/api/social/downloads", () => {
        return HttpResponse.json({
          downloads: [
            {
              ...completed,
              request: {
                platform: "youtube",
                url: "https://youtu.be/example",
                maxDuration: 600,
                quality: "1080p",
                format: "mp3",
              },
              resumeCommand: `okou social download --resume ${completed.downloadId}`,
            },
          ],
          nextCursor: null,
        });
      }),
    );

    await socialCommand.parseAsync([
      "node",
      "okou",
      "download",
      "https://youtu.be/example",
      "--max-duration",
      "600",
      "--format",
      "mp3",
      "--quality",
      "1080p",
      "--json",
    ]);
    expect(requestBody).toStrictEqual({
      platform: "youtube",
      url: "https://youtu.be/example",
      maxDuration: 600,
      quality: "1080p",
      format: "mp3",
    });
    expect(JSON.parse(output()) as unknown).toMatchObject({
      status: "complete",
      data: {
        requested: completed.requested,
        delivered: completed.delivered,
        artifact: completed.artifact,
      },
      billing: { quantity: 2, creditsCharged: 6 },
      inlineMarkdownLink:
        "[example.mp3](<https://artifacts.example/example.mp3>)",
    });
    expect(outputRequest()).toStrictEqual({
      resume: false,
      maxDuration: 600,
      quality: "1080p",
      format: "mp3",
    });
    mockConsoleLog.mockClear();
    await socialCommand.parseAsync(["node", "okou", "downloads", "--json"]);
    expect(JSON.parse(output()) as unknown).toMatchObject({
      downloads: [
        {
          format: "mp3",
          requested: completed.requested,
          delivered: completed.delivered,
          artifact: completed.artifact,
          resumeCommand: `okou social download --resume ${completed.downloadId}`,
        },
      ],
      nextCommand: null,
    });
  });

  it.each([
    {
      caseName: "creation",
      method: "post",
      status: 502,
      args: [
        "download",
        "https://youtu.be/example",
        "--max-duration",
        "600",
        "--json",
      ],
    },
    {
      caseName: "status",
      method: "get",
      status: 500,
      args: [
        "download",
        "--resume",
        "6bdc3449-41ef-4624-a525-45bce09c67f0",
        "--json",
      ],
    },
  ] as const)(
    "sanitizes and structures download $caseName API failures",
    async ({ method, status, args }) => {
      const response = () => {
        return HttpResponse.json(
          {
            error: {
              code: "SOCIALKIT_DOWNLOAD_FAILED",
              message: "SocialKit download request failed",
            },
          },
          { status },
        );
      };
      server.use(
        method === "post"
          ? http.post("http://localhost:3000/api/social/downloads", response)
          : http.get(
              "http://localhost:3000/api/social/downloads/:downloadId",
              response,
            ),
      );

      await expect(
        socialCommand.parseAsync(["node", "okou", ...args]),
      ).rejects.toThrow("process.exit called");

      expect(JSON.parse(errorOutput()) as unknown).toMatchObject({
        status: "error",
        error: {
          kind: "provider_temporary",
          code: "SOCIAL_DOWNLOAD_FAILED",
          message: "Okou Social download request failed",
          httpStatus: status,
          retryable: true,
        },
      });
      expect(errorOutput()).not.toMatch(/socialkit/iu);
    },
  );

  it("resumes an existing download without a new request", async () => {
    let creates = 0;
    server.use(
      http.post("http://localhost:3000/api/social/downloads", () => {
        creates += 1;
        return HttpResponse.json(completedDownload(), { status: 202 });
      }),
      http.get("http://localhost:3000/api/social/downloads/:downloadId", () => {
        return HttpResponse.json(completedDownload());
      }),
    );

    await socialCommand.parseAsync([
      "node",
      "okou",
      "download",
      "--resume",
      "6bdc3449-41ef-4624-a525-45bce09c67f0",
      "--json",
    ]);

    expect(creates).toBe(0);
    expect(JSON.parse(output()) as unknown).toMatchObject({
      data: {
        requested: { quality: "720p", format: "mp4" },
        delivered: { quality: null, format: null },
      },
      inlineMarkdownLink:
        "[example.mp4](<https://artifacts.example/video.mp4>)",
      previewMarkdownBlock:
        "![example.mp4](<https://artifacts.example/video.mp4>)",
      artifactPresentationContext: expect.stringContaining(
        "outside code fences",
      ),
      target: {
        kind: "download",
        downloadId: "6bdc3449-41ef-4624-a525-45bce09c67f0",
      },
    });
    expect(outputRequest()).toStrictEqual({
      resume: true,
      maxDuration: 600,
      quality: "720p",
      format: "mp4",
    });
  });

  it.each([
    {
      platform: "tiktok",
      requestedFormat: "mp4",
      providerQuality: "576p",
      delivered: { quality: "576p", format: "mp4" },
      filename: "example.mp4",
      contentType: "video/mp4",
    },
    {
      platform: "youtube",
      requestedFormat: "mp4",
      providerQuality: "720p",
      delivered: { quality: null, format: "mp3" },
      filename: "example.mp3",
      contentType: "audio/mpeg",
    },
    {
      platform: "youtube",
      requestedFormat: "mp3",
      providerQuality: "720p",
      delivered: { quality: null, format: "mp3" },
      filename: "example.mp3",
      contentType: "audio/mpeg",
    },
  ])(
    "preserves requested $requestedFormat and delivered $delivered.format metadata when resuming",
    async ({
      platform,
      requestedFormat,
      providerQuality,
      delivered,
      filename,
      contentType,
    }) => {
      const legacy = completedDownload();
      const response = {
        ...legacy,
        platform,
        format: requestedFormat,
        requested: { quality: "720p", format: requestedFormat },
        delivered,
        provider: {
          ...legacy.provider,
          quality: providerQuality,
          format: requestedFormat,
        },
        artifact: {
          ...legacy.artifact,
          filename,
          url: `https://artifacts.example/${filename}`,
          contentType,
          format: delivered.format,
        },
      };
      server.use(
        http.get(
          "http://localhost:3000/api/social/downloads/:downloadId",
          () => {
            return HttpResponse.json(response);
          },
        ),
      );

      await socialCommand.parseAsync([
        "node",
        "okou",
        "download",
        "--resume",
        legacy.downloadId,
        "--json",
      ]);

      expect(JSON.parse(output()) as unknown).toMatchObject({
        data: {
          quality: "720p",
          format: requestedFormat,
          requested: response.requested,
          delivered,
          artifact: { filename, contentType, format: delivered.format },
        },
        billing: { quantity: 2, creditsCharged: 6 },
      });
      expect(outputRequest()).toStrictEqual({
        resume: true,
        maxDuration: 600,
        quality: "720p",
        format: requestedFormat,
      });
    },
  );

  it("retries artifact materialization when resuming a download", async () => {
    let statusRequests = 0;
    server.use(
      http.get("http://localhost:3000/api/social/downloads/:downloadId", () => {
        statusRequests += 1;
        return HttpResponse.json(
          statusRequests === 1
            ? failedDownload("artifact_failed")
            : completedDownload(),
        );
      }),
    );

    await socialCommand.parseAsync([
      "node",
      "okou",
      "download",
      "--resume",
      "6bdc3449-41ef-4624-a525-45bce09c67f0",
      "--json",
    ]);

    expect(statusRequests).toBe(2);
    expect(JSON.parse(output()) as unknown).toMatchObject({
      status: "complete",
      data: { status: "completed" },
    });
    expect(errorOutput()).toBe("");
  });

  it.each(["provider_failed", "artifact_failed"] as const)(
    "emits a structured %s download failure",
    async (status) => {
      server.use(
        http.post("http://localhost:3000/api/social/downloads", () => {
          return HttpResponse.json(failedDownload(status), { status: 202 });
        }),
      );

      await expect(
        socialCommand.parseAsync([
          "node",
          "okou",
          "download",
          "https://youtu.be/example",
          "--max-duration",
          "600",
          "--json",
        ]),
      ).rejects.toThrow("process.exit called");

      expect(JSON.parse(errorOutput()) as unknown).toMatchObject({
        status: "error",
        error: {
          kind: "download_failed",
          retryable: status === "artifact_failed",
          billed: status === "artifact_failed",
        },
        download: { status },
      });
    },
  );

  it.each([true, false])(
    "stops terminal polling when resubmission retryability is %s",
    async (resubmitRetryable) => {
      const terminal = failedDownload("provider_failed");
      let polls = 0;
      server.use(
        http.get(
          "http://localhost:3000/api/social/downloads/:downloadId",
          () => {
            polls += 1;
            return HttpResponse.json({
              ...terminal,
              error: {
                ...terminal.error,
                reason: "upstream_failure",
                resubmitRetryable,
              },
            });
          },
        ),
      );
      await expect(
        socialCommand.parseAsync([
          "node",
          "okou",
          "download",
          "--resume",
          terminal.downloadId,
          "--json",
        ]),
      ).rejects.toThrow("process.exit called");
      expect(JSON.parse(errorOutput()) as unknown).toMatchObject({
        error: { retryable: false, resubmitRetryable },
        download: {
          downloadId: terminal.downloadId,
          status: "provider_failed",
        },
      });
      expect(polls).toBe(1);
    },
  );

  it("stops on recoverable quota polling errors and keeps same-task guidance", async () => {
    const initial = failedDownload("provider_failed");
    let polls = 0;
    server.use(
      http.get("http://localhost:3000/api/social/downloads/:downloadId", () => {
        polls += 1;
        return HttpResponse.json({
          ...initial,
          status: "processing",
          completedAt: null,
          error: {
            code: "SOCIAL_QUOTA_EXHAUSTED",
            message: "Social service capacity must be restored",
            reason: "provider_quota_exhausted",
            retryable: false,
            billed: false,
            retryAfterSeconds: 120,
          },
        });
      }),
    );
    await expect(
      socialCommand.parseAsync([
        "node",
        "okou",
        "download",
        "--resume",
        initial.downloadId,
        "--json",
      ]),
    ).rejects.toThrow("process.exit called");
    expect(JSON.parse(errorOutput()) as unknown).toMatchObject({
      error: {
        reason: "provider_quota_exhausted",
        retryable: false,
        retryAfterSeconds: 120,
      },
      recovery: {
        downloadId: initial.downloadId,
        resumeCommand: `okou social download --resume ${initial.downloadId}`,
      },
    });
    expect(polls).toBe(1);
  });

  it.each(["api", "network"])(
    "keeps a known download ID after a %s polling failure",
    async (failure) => {
      const downloadId = completedDownload().downloadId;
      server.use(
        http.get(
          "http://localhost:3000/api/social/downloads/:downloadId",
          () => {
            return failure === "network"
              ? HttpResponse.error()
              : HttpResponse.json(
                  {
                    error: {
                      code: "TEMPORARY",
                      message: "Service temporarily unavailable",
                    },
                  },
                  { status: 500 },
                );
          },
        ),
      );
      await expect(
        socialCommand.parseAsync([
          "node",
          "okou",
          "download",
          "--resume",
          downloadId,
          "--json",
        ]),
      ).rejects.toThrow("process.exit called");
      expect(JSON.parse(errorOutput()) as unknown).toMatchObject({
        recovery: {
          downloadId,
          resumeCommand: `okou social download --resume ${downloadId}`,
        },
      });
    },
  );

  it("fails visibly when a terminal download omits error details", async () => {
    server.use(
      http.post("http://localhost:3000/api/social/downloads", () => {
        return HttpResponse.json(
          { ...failedDownload("provider_failed"), error: null },
          { status: 202 },
        );
      }),
    );

    await expect(
      socialCommand.parseAsync([
        "node",
        "okou",
        "download",
        "https://youtu.be/example",
        "--max-duration",
        "600",
        "--json",
      ]),
    ).rejects.toThrow("process.exit called");

    expect(JSON.parse(errorOutput()) as unknown).toStrictEqual({
      status: "error",
      error: {
        kind: "internal",
        code: "INTERNAL",
        message: expect.stringContaining("without error details"),
        retryable: false,
      },
    });
  });

  it("rejects mixed resume and new-download arguments", async () => {
    await expect(
      socialCommand.parseAsync([
        "node",
        "okou",
        "download",
        "https://youtu.be/example",
        "--resume",
        "6bdc3449-41ef-4624-a525-45bce09c67f0",
        "--json",
      ]),
    ).rejects.toThrow("process.exit called");

    expect(JSON.parse(errorOutput()) as unknown).toMatchObject({
      status: "error",
      error: {
        kind: "invalid_input",
        message: expect.stringContaining(
          "okou social download --resume 6bdc3449-41ef-4624-a525-45bce09c67f0",
        ),
      },
    });
  });

  it.each([
    ["quality", "--quality"],
    ["format", "--format"],
  ])("rejects an explicitly empty %s when resuming", async (_case, option) => {
    await expect(
      socialCommand.parseAsync([
        "node",
        "okou",
        "download",
        "--resume",
        "6bdc3449-41ef-4624-a525-45bce09c67f0",
        option,
        "",
        "--json",
      ]),
    ).rejects.toThrow("process.exit called");

    expect(JSON.parse(errorOutput()) as unknown).toMatchObject({
      status: "error",
      error: {
        kind: "invalid_input",
        message: expect.stringContaining("--resume cannot be combined"),
      },
    });
  });

  it.each([
    ["SIGINT", "SIGTERM", 130],
    ["SIGTERM", "SIGINT", 143],
  ] as const)(
    "emits structured recovery guidance and cleans up after %s",
    async (signal, secondSignal, exitCode) => {
      let statusRequestStarted = false;
      const initialSigintListeners = process.listenerCount("SIGINT");
      const initialSigtermListeners = process.listenerCount("SIGTERM");
      server.use(
        http.get(
          "http://localhost:3000/api/social/downloads/:downloadId",
          async ({ request }) => {
            statusRequestStarted = true;
            await new Promise<void>((resolve) => {
              if (request.signal.aborted) {
                resolve();
                return;
              }
              request.signal.addEventListener(
                "abort",
                () => {
                  resolve();
                },
                { once: true },
              );
            });
            return HttpResponse.error();
          },
        ),
      );

      const command = socialCommand.parseAsync([
        "node",
        "okou",
        "download",
        "--resume",
        "6bdc3449-41ef-4624-a525-45bce09c67f0",
        "--json",
      ]);
      await vi.waitFor(() => {
        expect(statusRequestStarted).toBeTruthy();
      });
      process.emit(signal, signal);
      process.emit(secondSignal, secondSignal);
      await command;

      expect(output()).toBe("");
      expect(mockConsoleError).toHaveBeenCalledTimes(1);
      expect(JSON.parse(errorOutput()) as unknown).toMatchObject({
        status: "error",
        error: {
          kind: "interrupted",
          code: "INTERRUPTED",
          retryable: true,
        },
        interruption: {
          signal,
          downloadId: "6bdc3449-41ef-4624-a525-45bce09c67f0",
          resumeCommand:
            "okou social download --resume 6bdc3449-41ef-4624-a525-45bce09c67f0",
        },
      });
      expect(process.exitCode).toBe(exitCode);
      expect(mockExit).not.toHaveBeenCalled();
      expect(process.listenerCount("SIGINT")).toBe(initialSigintListeners);
      expect(process.listenerCount("SIGTERM")).toBe(initialSigtermListeners);
    },
  );

  it("documents the intent-oriented surface", () => {
    const help = socialCommand.helpInformation();
    let renderedHelp = "";
    socialCommand.configureOutput({
      writeOut: (value) => {
        renderedHelp += value;
      },
    });
    socialCommand.outputHelp();
    const postsHelp = socialCommand.commands
      .find((command) => {
        return command.name() === "posts";
      })
      ?.helpInformation();
    expect(help).toContain("capabilities");
    expect(help).toContain("inspect");
    expect(help).toContain("comments");
    expect(postsHelp).toContain("Maximum total items to return");
    expect(postsHelp).toContain("--full-details");
    expect(postsHelp).toContain("YouTube channel/playlist");
    expect(postsHelp).toContain("slower; --limit at most 30");
    expect(renderedHelp).toContain("--full-details --limit 30 --json");
    expect(renderedHelp).toContain("--format mp3 --json");
    expect(renderedHelp).toContain("null, empty, or missing");
    for (const name of ["transcript", "summarize"]) {
      const command = socialCommand.commands.find((candidate) => {
        return candidate.name() === name;
      });
      expect(command?.helpInformation()).toContain("--refresh");
      expect(command?.helpInformation()).toContain("YouTube extraction caches");
    }
    expect(renderedHelp).toContain(
      "Provider credentials remain on the Okou API server",
    );
    expect(renderedHelp).toContain(
      "one kind=page record per fetched page, followed by one metadata-only kind=summary record",
    );
    expect(renderedHelp).toContain("--fields-file summary-fields.json");
    const transcript = socialCommand.commands.find((command) => {
      return command.name() === "transcript";
    });
    renderedHelp = "";
    transcript?.configureOutput({
      writeOut: (value) => {
        renderedHelp += value;
      },
    });
    transcript?.outputHelp();
    expect(renderedHelp).toContain("json, text, srt, vtt");
    expect(renderedHelp).toContain(
      "--format text|srt|vtt requires --output and cannot use --select",
    );
    expect(renderedHelp).toContain(
      "Extraction support does not guarantee timestamped output",
    );
    expect(renderedHelp).toContain("Choose vtt for escaped literal markup");
    expect(renderedHelp).toContain("SRT rejects timestamp-like cue-text lines");
    expect(renderedHelp).toContain(
      "recovered stdout JSON without repeating the request",
    );
    const summarize = socialCommand.commands.find((command) => {
      return command.name() === "summarize";
    });
    expect(summarize).toBeDefined();
    renderedHelp = "";
    summarize?.configureOutput({
      writeOut: (value) => {
        renderedHelp += value;
      },
    });
    summarize?.outputHelp();
    expect(renderedHelp).toContain("--refresh");
    expect(renderedHelp).toContain(
      "Extraction refresh and summary-result caching are separate controls",
    );
    expect(renderedHelp).toContain("--fields <json>");
    expect(renderedHelp).toContain("--fields-file <path>");
    expect(renderedHelp).toContain("Who this video helps");
    expect(renderedHelp).toContain("4096 characters");
    expect(renderedHelp).toContain("--prompt adds analysis instructions");
    expect(renderedHelp).toContain("do not enforce strict JSON Schema");
    const download = socialCommand.commands.find((command) => {
      return command.name() === "download";
    });
    renderedHelp = "";
    download?.configureOutput({
      writeOut: (value) => {
        renderedHelp += value;
      },
    });
    download?.outputHelp();
    expect(renderedHelp).toContain("mp4, m4a, or mp3");
  });
});
