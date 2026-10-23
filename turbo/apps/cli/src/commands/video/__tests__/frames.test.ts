/**
 * Tests for okou video frames command.
 *
 * Mocks only external boundaries: the curl/ffmpeg binaries (via child_process,
 * not available in CI) and HTTP (via MSW). The fake binaries write real bytes
 * to their output paths (the arg after "-o" for curl, before "-y" for ffmpeg)
 * so the command's real filesystem and real downloadWebFile code run unchanged.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execFileSync } from "child_process";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { framesCommand } from "../frames";

const DOWNLOAD_URL = "http://localhost:3000/api/web/file-url";

vi.mock("child_process", async () => {
  const { writeFileSync } = await vi.importActual<typeof import("fs")>("fs");
  return {
    execFileSync: vi.fn((command: string, args: readonly string[]) => {
      if (command === "curl") {
        const i = args.indexOf("-o");
        const outPath = i >= 0 ? args[i + 1] : undefined;
        if (outPath) {
          writeFileSync(outPath, Buffer.from("fake-video"));
        }
      } else if (command === "ffmpeg") {
        const i = args.indexOf("-y");
        const outPath = i > 0 ? args[i - 1] : undefined;
        if (outPath) {
          writeFileSync(outPath, Buffer.from("fake-frame"));
        }
      }
      return Buffer.from("");
    }),
  };
});

const mockStdoutWrite = vi
  .spyOn(process.stdout, "write")
  .mockImplementation(() => {
    return true;
  });

function readStdout(): string {
  return mockStdoutWrite.mock.calls
    .map((c) => {
      return c[0];
    })
    .join("");
}

describe("okou video frames command", () => {
  beforeEach(() => {
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("OKOU_TOKEN", "test-token");
    mockStdoutWrite.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it("extracts one frame per timestamp and prints JSON paths", async () => {
    await framesCommand.parseAsync(
      ["--url", "https://example.com/video.mp4", "--at", "00:21,01:40"],
      { from: "user" },
    );

    const result = JSON.parse(readStdout()) as {
      frames: { at: string; path: string }[];
    };
    expect(result).toEqual({
      frames: [
        {
          at: "00:21",
          path: expect.stringMatching(
            /[/\\]video-frames-\d+[/\\]frame-001\.jpg$/,
          ),
        },
        {
          at: "01:40",
          path: expect.stringMatching(
            /[/\\]video-frames-\d+[/\\]frame-002\.jpg$/,
          ),
        },
      ],
    });

    const curlCalls = vi.mocked(execFileSync).mock.calls.filter((c) => {
      return c[0] === "curl";
    });
    expect(curlCalls).toHaveLength(1);
    expect(curlCalls[0]?.[1]).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/[/\\]video-input-\d+\.mp4$/),
      ]),
    );

    const ffmpegCalls = vi.mocked(execFileSync).mock.calls.filter((c) => {
      return c[0] === "ffmpeg";
    });
    expect(ffmpegCalls).toHaveLength(2);
    expect(ffmpegCalls[0]?.[1]).toEqual(
      expect.arrayContaining(["-ss", "00:21", "-frames:v", "1"]),
    );
    expect(ffmpegCalls[1]?.[1]).toEqual(
      expect.arrayContaining(["-ss", "01:40"]),
    );
  });

  it("downloads via the web file API when --file-id is given", async () => {
    let requestedFileId: string | null = null;
    server.use(
      http.get(DOWNLOAD_URL, ({ request }) => {
        requestedFileId = new URL(request.url).searchParams.get("file_id");
        return HttpResponse.json({
          url: "https://cdn.example.com/video.mp4",
          downloadUrl: "https://cdn.example.com/video.mp4",
          expiresAt: "2026-10-23T15:00:00.000Z",
          publicUrl: null,
        });
      }),
      http.get("https://cdn.example.com/video.mp4", () => {
        return new HttpResponse(new Uint8Array([1, 2, 3, 4]), {
          headers: { "content-type": "video/mp4", "content-length": "4" },
        });
      }),
    );

    await framesCommand.parseAsync(["--file-id", "abc-123", "--at", "5"], {
      from: "user",
    });

    expect(requestedFileId).toBe("abc-123");
    const result = JSON.parse(readStdout()) as { frames: { at: string }[] };
    expect(result.frames[0]?.at).toBe("5");
  });

  it("exits with error when neither --url nor --file-id provided", async () => {
    const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);

    await expect(
      framesCommand.parseAsync(["--at", "5"], { from: "user" }),
    ).rejects.toThrow("process.exit called");

    mockExit.mockRestore();
  });
});
