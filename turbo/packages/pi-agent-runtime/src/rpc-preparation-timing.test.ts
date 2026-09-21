import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, onTestFinished, vi } from "vitest";

import { MemoryPiSession } from "./session-memory";
import type { PiPreparationObservation } from "./preparation-timing";

const RPC_MODE_REACHED = "rpc-mode-reached";

// Only the terminal RPC loop is replaced: session preparation must run for
// real, because the regression this covers is the sandbox host silently not
// forwarding its preparation observer into `createPiAgentSession`.
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@earendil-works/pi-coding-agent")
    >();
  return {
    ...actual,
    runRpcMode: () => {
      throw new Error(RPC_MODE_REACHED);
    },
  };
});

const SESSION_ID = "00000000-0000-4000-8000-000000000123";

describe("Pi sandbox RPC preparation observability", () => {
  it("forwards its preparation observer into the sandbox session it creates", async () => {
    const { runPiOfficialRpcMode } = await import("./rpc");
    const directory = await mkdtemp(join(tmpdir(), "pi-rpc-preparation-"));
    onTestFinished(async () => {
      await rm(directory, { force: true, recursive: true });
    });
    const cwd = join(directory, "workspace");
    await mkdir(cwd, { recursive: true });
    const sessionFile = join(directory, "session.jsonl");
    await writeFile(
      sessionFile,
      MemoryPiSession.create({ cwd, id: SESSION_ID }).toJsonl(),
    );
    const observed: PiPreparationObservation[] = [];

    await expect(
      runPiOfficialRpcMode({
        sessionId: SESSION_ID,
        sessionDir: directory,
        sessionFile,
        cwd,
        agentDir: join(directory, "agent"),
        appendSystemPrompt: null,
        ownershipTransferMode: "sandbox-first",
        model: {
          provider: "openai",
          model: "gpt-5.6-terra",
          dialect: "openai-responses" as const,
          transport: "sse" as const,
          apiKey: "synthetic-key",
          baseUrl: "http://127.0.0.1:1",
        },
        onPreparationTiming(observation) {
          observed.push(observation);
        },
      }),
    ).rejects.toThrow(RPC_MODE_REACHED);

    expect(
      observed.map((observation) => {
        return observation.phase;
      }),
    ).toEqual(
      expect.arrayContaining([
        "resources_prompt",
        "model_runtime",
        "session_services",
        "resource_loader",
        "session_create",
        "session_finalize",
      ]),
    );
    for (const observation of observed) {
      expect(observation.outcome).toBe("success");
      expect(observation.durationMs).toBeGreaterThanOrEqual(0);
    }
  });
});
