import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { browserCommand } from "../index";
import { writeProxyDiagnostic } from "../proxy/diagnostic";

const RUN_ID = "f0000000-0000-4000-a000-000000000010";
const INSTANCE_ID = "d0000000-0000-4000-a000-000000000010";
const closedAt = "2026-11-26T00:18:56.406Z";

function runToken(runId: string): string {
  const payload = Buffer.from(
    JSON.stringify({ runId, scope: "okou", capabilities: [] }),
  ).toString("base64url");
  return `vm0_sandbox_header.${payload}.signature`;
}

describe("okou browser diagnose", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "okou-browser-diagnose-"));
    vi.stubEnv("TMPDIR", directory);
    vi.stubEnv("OKOU_RUN_ID", undefined);
    vi.stubEnv("OKOU_TOKEN", runToken(RUN_ID));
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await rm(directory, { recursive: true });
  });

  function diagnose() {
    return browserCommand.parseAsync(["diagnose", "--json"], { from: "user" });
  }

  it("reads the latest owner-only record and keeps it scoped to the Run", async () => {
    await writeProxyDiagnostic(INSTANCE_ID, { reason: "closed", closedAt });
    const exit = {
      reason: "upstream-socket-closed",
      closeCode: 1012,
      closedAt,
    } as const;
    await writeProxyDiagnostic(INSTANCE_ID, exit);
    await diagnose();
    expect(
      JSON.parse(String(vi.mocked(console.log).mock.lastCall?.[0])),
    ).toEqual({
      lastProxyExit: { ...exit, instanceId: INSTANCE_ID },
    });
    const files = await readdir(directory);
    expect(files).toHaveLength(1);
    expect((await stat(join(directory, files[0]!))).mode & 0o777).toBe(0o600);

    vi.stubEnv("OKOU_TOKEN", runToken(INSTANCE_ID));
    await diagnose();
    expect(console.log).toHaveBeenLastCalledWith('{"lastProxyExit":null}');
  });

  it("returns an empty result for an unrecognized field in the saved record", async () => {
    await writeProxyDiagnostic(INSTANCE_ID, { reason: "closed", closedAt });
    const [file] = await readdir(directory);
    expect(file).toBeDefined();
    await writeFile(
      join(directory, file!),
      JSON.stringify({
        instanceId: INSTANCE_ID,
        reason: "upstream-socket-error",
        closedAt,
        url: "https://example.test/?token=private",
      }),
    );
    await diagnose();
    expect(console.log).toHaveBeenLastCalledWith('{"lastProxyExit":null}');
  });
});
