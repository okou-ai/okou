import chalk from "chalk";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { server } from "../../../mocks/server";
import { chatCommand } from "../index";

const THREAD_ID = "00000000-0000-4000-8000-000000000001";
const AGENT_ID = "00000000-0000-4000-8000-000000000010";
const RUN_ID = "00000000-0000-4000-8000-000000000020";
const EVENT_ID = "00000000-0000-4000-8000-000000000030";
const METADATA_URL = `http://localhost:3000/api/chat-threads/${THREAD_ID}/metadata`;
const SEND_URL = "http://localhost:3000/api/chat/events";

describe("okou chat cancel command", () => {
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);

  beforeEach(() => {
    chalk.level = 0;
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("OKOU_TOKEN", "test-token");
    vi.stubEnv("OKOU_CHAT_THREAD_ID", THREAD_ID);
    server.use(
      http.get(METADATA_URL, () => {
        return HttpResponse.json({
          id: THREAD_ID,
          agentId: AGENT_ID,
          title: "Launch plan",
          selectedModel: null,
        });
      }),
    );
  });

  afterEach(() => {
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    mockExit.mockClear();
    vi.unstubAllEnvs();
  });

  it("interrupts one active run", async () => {
    let controlEventId: string | undefined;
    server.use(
      http.post(SEND_URL, async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        controlEventId = String(body.clientEventId);
        expect(body).toStrictEqual({
          agentId: AGENT_ID,
          threadId: THREAD_ID,
          interruptsRunId: RUN_ID,
          clientEventId: controlEventId,
        });
        return HttpResponse.json(
          {
            threadId: THREAD_ID,
            createdAt: "2026-07-29T10:00:00.000Z",
          },
          { status: 201 },
        );
      }),
    );

    await chatCommand.parseAsync([
      "node",
      "cli",
      "cancel",
      "--run-id",
      RUN_ID,
      "--json",
    ]);

    expect(JSON.parse(String(mockConsoleLog.mock.calls[0]?.[0]))).toStrictEqual(
      {
        threadId: THREAD_ID,
        controlEventId,
        targetType: "run",
        targetId: RUN_ID,
        createdAt: "2026-07-29T10:00:00.000Z",
      },
    );
  });

  it("revokes one queued user message", async () => {
    server.use(
      http.post(SEND_URL, async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        expect(body).toMatchObject({
          agentId: AGENT_ID,
          threadId: THREAD_ID,
          revokesEventId: EVENT_ID,
        });
        expect(body).not.toHaveProperty("interruptsRunId");
        return HttpResponse.json(
          {
            threadId: THREAD_ID,
          },
          { status: 201 },
        );
      }),
    );

    await chatCommand.parseAsync([
      "node",
      "cli",
      "cancel",
      "--event-id",
      EVENT_ID,
    ]);

    const output = mockConsoleLog.mock.calls.flat().join("\n");
    expect(output).toContain("Queued chat event cancelled");
    expect(output).toContain(`Event:    ${EVENT_ID}`);
  });

  it("requires exactly one cancellation target", async () => {
    await expect(async () => {
      await chatCommand.parseAsync([
        "node",
        "cli",
        "cancel",
        "--run-id",
        RUN_ID,
        "--event-id",
        EVENT_ID,
      ]);
    }).rejects.toThrow("process.exit called");

    const stderr = mockConsoleError.mock.calls.flat().join("\n");
    expect(stderr).toContain(
      "Exactly one of --run-id or --event-id is required",
    );
    expect(mockExit).toHaveBeenCalledWith(1);
  });
});
