import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../mocks/server";
import { phoneUseCommand } from "../phone-use";
let directory = "";
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "phone-use-"));
  vi.stubEnv("OKOU_TOKEN", "test-token");
  vi.stubEnv("OKOU_API_BACKEND_URL", "https://api.vm0.ai");
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
describe("Phone Use CLI", () => {
  it("recovers a submitted operation by its identity and writes its screenshot privately", async () => {
    const id = randomUUID();
    const operation = {
      id,
      deviceId: randomUUID(),
      runId: randomUUID(),
      grantId: randomUUID(),
      action: { kind: "observe" },
      status: "succeeded",
      result: { snapshotID: randomUUID() },
      error: null,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 45_000).toISOString(),
    };
    server.use(
      http.post(
        "https://api.vm0.ai/api/phone-use/operations",
        async ({ request }) => {
          expect(await request.json()).toEqual({
            id,
            action: { kind: "observe" },
          });
          return HttpResponse.json(operation);
        },
      ),
      http.get(`https://api.vm0.ai/api/phone-use/operations/${id}`, () => {
        return HttpResponse.json(operation);
      }),
      http.get(
        `https://api.vm0.ai/api/phone-use/operations/${id}/screenshot`,
        () => {
          return HttpResponse.json({
            url: "https://private-images.example/phone.png",
          });
        },
      ),
      http.get("https://private-images.example/phone.png", ({ request }) => {
        expect(request.headers.get("Authorization")).toBeNull();
        return new HttpResponse(new Uint8Array([137, 80, 78, 71]));
      }),
    );
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = new Command().exitOverride().addCommand(phoneUseCommand);
    await program.parseAsync(
      [
        "phone-use",
        "observe",
        "--id",
        id,
        "--wait",
        "0",
        "--output",
        directory,
      ],
      { from: "user" },
    );
    expect(output).toHaveBeenCalledWith(expect.stringContaining(id));
    const path = join(directory, `${id}.png`);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readFile(path)).toEqual(Buffer.from([137, 80, 78, 71]));
  });
});
