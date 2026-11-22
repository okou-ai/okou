import { readFile, unlink } from "node:fs/promises";
import { http, HttpResponse } from "msw";
import { expect, it, vi } from "vitest";
import { server } from "../../mocks/server";
import { transcribeCommand } from "../transcribe";

it("sends ordered file IDs and writes identical transcript bytes to the file and stdout", async () => {
  const api = "http://localhost:3000";
  vi.stubEnv("OKOU_API_BACKEND_URL", api);
  vi.stubEnv("OKOU_TOKEN", "test-token");
  const fileIds = [
    "aaaaaaaa-1111-4000-8000-111111111111",
    "aaaaaaaa-2222-4000-8000-222222222222",
  ];
  const transcript = "第一段。\nSecond clip.";
  const model = "google/gemini-3.1-flash-lite";
  const requests: unknown[] = [];
  server.use(
    http.post(`${api}/api/voice/transcribe`, async ({ request }) => {
      requests.push(await request.json());
      return HttpResponse.json({ transcript });
    }),
  );
  const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  try {
    await transcribeCommand.parseAsync(
      [
        model,
        ...fileIds.flatMap((id) => {
          return ["--file-id", id];
        }),
      ],
      { from: "user" },
    );
    const path = String(stderr.mock.calls.at(-1)?.[0]);
    try {
      expect(await readFile(path, "utf8")).toBe(transcript);
      expect(stdout).toHaveBeenCalledWith(transcript);
      expect(requests).toEqual([{ model, fileIds }]);
    } finally {
      await unlink(path);
    }
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
    vi.unstubAllEnvs();
  }
});
