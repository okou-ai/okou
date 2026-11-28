import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { server } from "../../mocks/server";
import { transcribeCommand } from "../transcribe";

const API = "http://localhost:3000";
const MODEL = "google/gemini-3.1-flash-lite";
const FILE_IDS = [
  "aaaaaaaa-1111-4000-8000-111111111111",
  "aaaaaaaa-2222-4000-8000-222222222222",
] as const;

describe("okou transcribe", () => {
  const mockExit = vi.spyOn(process, "exit").mockImplementation(() => {
    throw new Error("process.exit called");
  });
  const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);

  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "okou-transcribe-test-"));
    vi.stubEnv("TMPDIR", tempDir);
    vi.stubEnv("OKOU_API_BACKEND_URL", API);
    vi.stubEnv("OKOU_TOKEN", "test-token");
    vi.stubEnv("OKOU_ANTIGRAVITY_MODEL", "");
    transcribeCommand.setOptionValue("fileId", []);
    transcribeCommand.setOptionValue("operationId", undefined);
    transcribeCommand.setOptionValue("forceTranscribe", undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    mockExit.mockClear();
    stderr.mockClear();
    stdout.mockClear();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("sends ordered file IDs and writes identical transcript bytes to the file and stdout", async () => {
    const transcript = "第一段。\nSecond clip.";
    const requests: unknown[] = [];
    server.use(
      http.post(`${API}/api/voice/transcribe`, async ({ request }) => {
        requests.push(await request.json());
        return HttpResponse.json({ transcript });
      }),
    );

    await transcribeCommand.parseAsync(
      [
        MODEL,
        ...FILE_IDS.flatMap((id) => {
          return ["--file-id", id];
        }),
      ],
      { from: "user" },
    );

    const path = String(stderr.mock.calls.at(-1)?.[0]);
    expect(path.startsWith(tempDir)).toBe(true);
    expect(await readFile(path, "utf8")).toBe(transcript);
    expect(stdout).toHaveBeenCalledWith(transcript);
    expect(requests).toEqual([{ model: MODEL, fileIds: [...FILE_IDS] }]);
  });

  it("downloads ordered audio clips for read_file when OKOU_ANTIGRAVITY_MODEL is set", async () => {
    vi.stubEnv("OKOU_ANTIGRAVITY_MODEL", "gemini-4-neon");
    const payloads: Record<string, { body: string; contentType: string }> = {
      [FILE_IDS[0]]: { body: "first-wav-bytes", contentType: "audio/wav" },
      [FILE_IDS[1]]: {
        body: "second-mp3-bytes",
        contentType: "audio/mpeg; charset=binary",
      },
    };
    server.use(
      http.get(`${API}/api/web/file-url`, ({ request }) => {
        const fileId = new URL(request.url).searchParams.get("file_id");
        expect(request.headers.get("authorization")).toBe("Bearer test-token");
        if (!fileId || !(fileId in payloads)) {
          return HttpResponse.json(
            { error: { code: "NOT_FOUND", message: "File not found" } },
            { status: 404 },
          );
        }
        const downloadUrl = `https://delivery.example.com/audio/${fileId}?sig=temp`;
        return HttpResponse.json({
          url: downloadUrl,
          downloadUrl,
          expiresAt: "2026-11-28T10:00:00.000Z",
          publicUrl: null,
        });
      }),
      http.get("https://delivery.example.com/audio/:fileId", ({ params }) => {
        const entry = payloads[String(params.fileId)];
        if (!entry) {
          return new HttpResponse(null, { status: 404 });
        }
        return new HttpResponse(entry.body, {
          headers: { "content-type": entry.contentType },
        });
      }),
    );

    await transcribeCommand.parseAsync(
      [
        MODEL,
        ...FILE_IDS.flatMap((id) => {
          return ["--file-id", id];
        }),
      ],
      { from: "user" },
    );

    const output = stdout.mock.calls
      .map(([chunk]) => {
        return String(chunk);
      })
      .join("");
    expect(output).toContain("read_file");
    expect(stderr).not.toHaveBeenCalled();

    const firstMatch = /^1\. (.+)$/m.exec(output);
    const secondMatch = /^2\. (.+)$/m.exec(output);
    const firstPath = firstMatch?.[1];
    const secondPath = secondMatch?.[1];
    expect(firstPath).toBeDefined();
    expect(secondPath).toBeDefined();
    expect(firstPath?.startsWith(tempDir)).toBe(true);
    expect(secondPath?.startsWith(tempDir)).toBe(true);
    expect(firstPath?.endsWith(".wav")).toBe(true);
    expect(secondPath?.endsWith(".mp3")).toBe(true);
    expect(await readFile(firstPath!, "utf8")).toBe("first-wav-bytes");
    expect(await readFile(secondPath!, "utf8")).toBe("second-mp3-bytes");
    expect((await stat(firstPath!)).mode & 0o777).toBe(0o600);
    expect((await stat(secondPath!)).mode & 0o777).toBe(0o600);
  });

  it("calls the transcription API when --force-transcribe is passed even with OKOU_ANTIGRAVITY_MODEL set", async () => {
    vi.stubEnv("OKOU_ANTIGRAVITY_MODEL", "gemini-4-neon");
    const transcript = "Forced transcript.";
    const requests: unknown[] = [];
    server.use(
      http.post(`${API}/api/voice/transcribe`, async ({ request }) => {
        requests.push(await request.json());
        return HttpResponse.json({ transcript });
      }),
    );

    await transcribeCommand.parseAsync(
      [MODEL, "--file-id", FILE_IDS[0], "--force-transcribe"],
      { from: "user" },
    );

    const path = String(stderr.mock.calls.at(-1)?.[0]);
    expect(await readFile(path, "utf8")).toBe(transcript);
    expect(stdout).toHaveBeenCalledWith(transcript);
    expect(requests).toEqual([{ model: MODEL, fileIds: [FILE_IDS[0]] }]);
  });

  it("cleans up already-downloaded clips when a subsequent clip download fails", async () => {
    vi.stubEnv("OKOU_ANTIGRAVITY_MODEL", "gemini-4-neon");
    server.use(
      http.get(`${API}/api/web/file-url`, ({ request }) => {
        const fileId = new URL(request.url).searchParams.get("file_id");
        if (fileId === FILE_IDS[0]) {
          const downloadUrl = `https://delivery.example.com/audio/${fileId}?sig=temp`;
          return HttpResponse.json({
            url: downloadUrl,
            downloadUrl,
            expiresAt: "2026-11-28T10:00:00.000Z",
            publicUrl: null,
          });
        }
        return HttpResponse.json(
          { error: { code: "NOT_FOUND", message: "File not found" } },
          { status: 404 },
        );
      }),
      http.get(`https://delivery.example.com/audio/${FILE_IDS[0]}`, () => {
        return new HttpResponse("first-wav-bytes", {
          headers: { "content-type": "audio/wav" },
        });
      }),
    );

    await expect(
      transcribeCommand.parseAsync(
        [
          MODEL,
          ...FILE_IDS.flatMap((id) => {
            return ["--file-id", id];
          }),
        ],
        { from: "user" },
      ),
    ).rejects.toThrow("process.exit called");

    expect(mockExit).toHaveBeenCalledWith(1);
    expect(readdirSync(tempDir)).toEqual([]);
  });
});
