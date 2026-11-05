import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { createInstructionsCommand } from "../index";

const saved = {
  orgId: "workspace-one",
  userId: "ordinary-member",
  content: "# Personal\r\nKeep exact spacing.  \n",
  updatedAt: "2026-11-05T10:00:00.000Z",
  version: "opaque-version-1",
};

function runToken(singleAgent?: true): string {
  return `vm0_sandbox_e30.${Buffer.from(
    JSON.stringify({
      scope: "okou",
      userId: saved.userId,
      orgId: saved.orgId,
      runId: "run-one",
      capabilities: ["instructions:read", "instructions:write"],
      ...(singleAgent ? { singleAgent } : {}),
    }),
  ).toString("base64url")}.signature`;
}

async function run(...args: string[]) {
  return createInstructionsCommand()
    .exitOverride()
    .parseAsync(args, { from: "user" });
}

describe("personal Instructions CLI", () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => {
    return true;
  });
  let directory: string;
  let current = saved;
  let writes: unknown[];

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "okou-instructions-"));
    current = { ...saved };
    writes = [];
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("OKOU_TOKEN", runToken(true));
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit");
    });
    server.use(
      http.get("*/api/instructions", () => {
        return HttpResponse.json(current);
      }),
      http.put("*/api/instructions", async ({ request }) => {
        const body = (await request.json()) as {
          content: string;
          ifVersion?: string;
        };
        writes.push(body);
        if (
          body.ifVersion !== undefined &&
          body.ifVersion !== current.version
        ) {
          return HttpResponse.json(
            {
              error: { code: "CONFLICT", message: "Newer Instructions exist" },
            },
            { status: 409 },
          );
        }
        current = {
          ...current,
          content: body.content,
          version: "opaque-version-2",
        };
        return HttpResponse.json(current);
      }),
    );
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
    vi.mocked(process.exit).mockRestore();
    vi.unstubAllEnvs();
  });

  it("prints only the exact saved bytes, including zero bytes for empty content", async () => {
    await run("view", "--raw");
    expect(
      stdout.mock.calls
        .map(([text]) => {
          return text;
        })
        .join(""),
    ).toBe(saved.content);
    expect(log).not.toHaveBeenCalled();
    stdout.mockClear();
    current = { ...current, content: "" };
    await run("view", "--raw");
    expect(
      stdout.mock.calls
        .map(([text]) => {
          return text;
        })
        .join(""),
    ).toBe("");
  });

  it("returns the stable JSON document and distinguishes saved from loaded Instructions", async () => {
    await run("view", "--json");
    expect(JSON.parse(log.mock.calls[0]![0] as string)).toEqual(saved);
    log.mockClear();
    await run("view");
    expect(log.mock.calls.flat().join("\n")).toContain(
      "ordinary-member, workspace workspace-one",
    );
    expect(log.mock.calls.flat().join("\n")).toContain(
      "Work in progress won't change",
    );
  });

  it("writes exact UTF-8 file content and supports explicit empty unconditional replacement", async () => {
    const file = join(directory, "instructions.md");
    const content = "\uFEFF你好\r\n  keep whitespace\n";
    await writeFile(file, content);
    await run("edit", "--file", file, "--if-version", saved.version, "--json");
    expect(writes).toEqual([{ content, ifVersion: saved.version }]);
    expect(JSON.parse(log.mock.calls[0]![0] as string)).toEqual({
      ...saved,
      content,
      version: "opaque-version-2",
    });
    await writeFile(file, "");
    await run("edit", "--file", file);
    expect(writes[1]).toEqual({ content: "" });
    expect(current.content).toBe("");
    expect(log.mock.calls.flat().join("\n")).toContain(
      "Instructions saved. Used the next time Okou starts working",
    );
  });

  it("reads stdin without trimming", async () => {
    process.stdin.push(Buffer.from("stdin content\n\n"));
    process.stdin.push(null);
    await run("edit", "--file", "-", "--json");
    expect(writes).toEqual([{ content: "stdin content\n\n" }]);
  });

  it("keeps a newer document on conflict and writes actionable diagnostics only to stderr", async () => {
    const file = join(directory, "instructions.md");
    await writeFile(file, "stale edit");
    await expect(
      run("edit", "--file", file, "--if-version", "older", "--json"),
    ).rejects.toThrow("exit");
    expect(current).toEqual(saved);
    expect(error.mock.calls.flat().join("\n")).toContain(
      "okou instructions view --json",
    );
    expect(error.mock.calls.flat().join("\n")).toContain(
      "Your edit was not saved",
    );
    expect(log).not.toHaveBeenCalled();
    expect(stdout).not.toHaveBeenCalled();
  });

  it.each(["--user", "--agent"])(
    "rejects impersonation target %s before a write",
    async (flag) => {
      await expect(
        run("edit", "--file", "unused", flag, "someone-else"),
      ).rejects.toThrow();
      expect(writes).toEqual([]);
    },
  );

  it("rejects mutually exclusive raw and JSON output", async () => {
    await expect(run("view", "--raw", "--json")).rejects.toThrow();
    expect(log).not.toHaveBeenCalled();
    expect(stdout).not.toHaveBeenCalled();
  });

  it("keeps captured enabled and legacy Run modes despite opposite live flags", async () => {
    let featureReads = 0;
    server.use(
      http.get("*/api/feature-switches", () => {
        featureReads++;
        return HttpResponse.json({
          switches: {},
          effectiveSwitches: { singleAgent: true },
        });
      }),
    );
    await run("view", "--json");
    vi.stubEnv("OKOU_TOKEN", runToken());
    await expect(run("view", "--json")).rejects.toThrow("exit");
    expect(featureReads).toBe(0);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("uses authenticated member mode outside a Run and surfaces API authorization failure", async () => {
    vi.stubEnv("OKOU_TOKEN", "member-token");
    server.use(
      http.get("*/api/feature-switches", () => {
        return HttpResponse.json({
          switches: {},
          effectiveSwitches: { singleAgent: true },
        });
      }),
      http.get("*/api/instructions", () => {
        return HttpResponse.json(
          { error: { code: "FORBIDDEN", message: "Membership revoked" } },
          { status: 403 },
        );
      }),
    );
    await expect(run("view", "--json")).rejects.toThrow("exit");
    expect(error.mock.calls.flat().join("\n")).toContain(
      "403: Membership revoked",
    );
    expect(log).not.toHaveBeenCalled();
  });

  it("does not write when the file is absent or contains invalid text", async () => {
    await expect(
      run("edit", "--file", join(directory, "missing")),
    ).rejects.toThrow("exit");
    const file = join(directory, "invalid");
    await writeFile(file, Buffer.from([0xff]));
    await expect(run("edit", "--file", file)).rejects.toThrow("exit");
    await writeFile(file, "bad\0text");
    await expect(run("edit", "--file", file)).rejects.toThrow("exit");
    expect(writes).toEqual([]);
  });
});
