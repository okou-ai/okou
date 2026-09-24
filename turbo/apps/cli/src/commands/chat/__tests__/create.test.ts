import chalk from "chalk";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { server } from "../../../mocks/server";
import { chatCommand } from "../index";

const CURRENT_THREAD_ID = "00000000-0000-4000-8000-000000000001";
const NEW_THREAD_ID = "00000000-0000-4000-8000-000000000002";
const AGENT_ID = "00000000-0000-4000-8000-000000000010";
const OTHER_AGENT_ID = "00000000-0000-4000-8000-000000000011";
const CREATE_URL = "http://localhost:3000/api/chat-threads";

function metadataUrl(threadId: string): string {
  return `http://localhost:3000/api/chat-threads/${threadId}/metadata`;
}

describe("okou chat create command", () => {
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
    vi.stubEnv("OKOU_CHAT_THREAD_ID", CURRENT_THREAD_ID);
  });

  afterEach(() => {
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    mockExit.mockClear();
    vi.unstubAllEnvs();
  });

  it("creates a thread under this chat's agent and inherits run settings", async () => {
    server.use(
      http.get(metadataUrl(CURRENT_THREAD_ID), () => {
        return HttpResponse.json({
          id: CURRENT_THREAD_ID,
          agentId: AGENT_ID,
          title: "Current chat",
          selectedModel: "claude-sonnet-5",
          serviceTier: "priority",
        });
      }),
      http.post(CREATE_URL, async ({ request }) => {
        expect(request.headers.get("authorization")).toBe("Bearer test-token");
        const body = (await request.json()) as Record<string, unknown>;
        expect(body).toStrictEqual({
          agentId: AGENT_ID,
          title: "Deep dive on P2",
        });
        return HttpResponse.json(
          {
            id: NEW_THREAD_ID,
            title: "Deep dive on P2",
            createdAt: "2026-07-30T10:00:00.000Z",
            selectedModel: "claude-sonnet-5",
            serviceTier: "priority",
          },
          { status: 201 },
        );
      }),
    );

    await chatCommand.parseAsync([
      "node",
      "cli",
      "create",
      "Deep dive",
      "on P2",
      "--json",
    ]);

    expect(JSON.parse(String(mockConsoleLog.mock.calls[0]?.[0]))).toStrictEqual(
      {
        threadId: NEW_THREAD_ID,
        title: "Deep dive on P2",
        selectedModel: "claude-sonnet-5",
        serviceTier: "priority",
        agentId: AGENT_ID,
      },
    );
  });

  it("guides to the first send with an explicit agent, model, and priority", async () => {
    server.use(
      http.get(metadataUrl(NEW_THREAD_ID), () => {
        return HttpResponse.json({
          id: NEW_THREAD_ID,
          agentId: OTHER_AGENT_ID,
          title: "Launch plan",
          selectedModel: "claude-sonnet-5",
          modelSettings: {},
          serviceTier: "priority",
        });
      }),
      http.post(CREATE_URL, async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        expect(body).toStrictEqual({
          agentId: OTHER_AGENT_ID,
          title: "Launch plan",
          model: "claude-sonnet-5",
          serviceTier: "priority",
        });
        return HttpResponse.json(
          {
            id: NEW_THREAD_ID,
            title: "Launch plan",
            createdAt: "2026-07-30T10:00:00.000Z",
            selectedModel: "claude-sonnet-5",
            serviceTier: "priority",
          },
          { status: 201 },
        );
      }),
    );

    await chatCommand.parseAsync([
      "node",
      "cli",
      "create",
      "Launch plan",
      "--agent",
      OTHER_AGENT_ID,
      "--model",
      "claude-sonnet-5",
      "--priority",
    ]);

    const output = mockConsoleLog.mock.calls.flat().join("\n");
    expect(output).toContain("Chat thread created");
    expect(output).toContain(`Thread: ${NEW_THREAD_ID}`);
    expect(output).toContain("Title:  Launch plan");
    expect(output).toContain("Model:  claude-sonnet-5 · effort high");
    expect(output).toContain("Priority: enabled");
    expect(output).toContain(`Agent:  ${OTHER_AGENT_ID}`);
    expect(output).toContain(
      `okou chat send --thread-id ${NEW_THREAD_ID} --text "<message>"`,
    );
  });

  it("can explicitly use standard priority", async () => {
    server.use(
      http.get(metadataUrl(NEW_THREAD_ID), () => {
        return HttpResponse.json({
          id: NEW_THREAD_ID,
          agentId: OTHER_AGENT_ID,
          title: "Standard thread",
          selectedModel: "claude-sonnet-5",
          modelSettings: {},
        });
      }),
      http.post(CREATE_URL, async ({ request }) => {
        expect(await request.json()).toStrictEqual({
          agentId: OTHER_AGENT_ID,
          title: "Standard thread",
          model: "claude-sonnet-5",
          serviceTier: null,
        });
        return HttpResponse.json(
          {
            id: NEW_THREAD_ID,
            title: "Standard thread",
            createdAt: "2026-07-30T10:00:00.000Z",
            selectedModel: "claude-sonnet-5",
            serviceTier: null,
          },
          { status: 201 },
        );
      }),
    );

    await chatCommand.parseAsync([
      "node",
      "cli",
      "create",
      "Standard thread",
      "--agent",
      OTHER_AGENT_ID,
      "--model",
      "claude-sonnet-5",
      "--no-priority",
    ]);

    expect(mockConsoleLog.mock.calls.flat().join("\n")).toContain(
      "Priority: disabled",
    );
  });

  it("creates a Codex thread with xhigh and shows the saved effective effort", async () => {
    server.use(
      http.post(CREATE_URL, async ({ request }) => {
        expect(await request.json()).toStrictEqual({
          agentId: OTHER_AGENT_ID,
          title: "Debate",
          model: "gpt-6-sol",
          reasoningEffort: "xhigh",
        });
        return HttpResponse.json(
          {
            id: NEW_THREAD_ID,
            title: "Debate",
            createdAt: "2026-07-30T10:00:00.000Z",
            selectedModel: "gpt-6-sol",
            serviceTier: null,
          },
          { status: 201 },
        );
      }),
      http.get(metadataUrl(NEW_THREAD_ID), () => {
        return HttpResponse.json({
          id: NEW_THREAD_ID,
          agentId: OTHER_AGENT_ID,
          title: "Debate",
          selectedModel: "gpt-6-sol",
          modelSettings: { "gpt-6-sol": { effort: "xhigh" } },
        });
      }),
    );

    await chatCommand.parseAsync([
      "node",
      "cli",
      "create",
      "Debate",
      "--agent",
      OTHER_AGENT_ID,
      "--model",
      "gpt-6-sol",
      "--effort",
      "xhigh",
    ]);
    expect(mockConsoleLog.mock.calls.flat().join("\n")).toContain(
      "Model:  gpt-6-sol · effort xhigh",
    );

    await chatCommand.parseAsync([
      "node",
      "cli",
      "get",
      "--thread-id",
      NEW_THREAD_ID,
      "--json",
    ]);
    expect(
      JSON.parse(String(mockConsoleLog.mock.calls.at(-1)?.[0])),
    ).toMatchObject({
      selectedModel: "gpt-6-sol",
      modelSettings: { "gpt-6-sol": { effort: "xhigh" } },
    });
  });

  it("passes effort without a model for server-side run inheritance", async () => {
    server.use(
      http.post(CREATE_URL, async ({ request }) => {
        expect(await request.json()).toStrictEqual({
          agentId: OTHER_AGENT_ID,
          title: "Inherited",
          reasoningEffort: "extra",
        });
        return HttpResponse.json(
          {
            id: NEW_THREAD_ID,
            title: "Inherited",
            createdAt: "2026-07-30T10:00:00.000Z",
            selectedModel: "claude-opus-5-5",
            serviceTier: null,
          },
          { status: 201 },
        );
      }),
    );
    await chatCommand.parseAsync([
      "node",
      "cli",
      "create",
      "Inherited",
      "--agent",
      OTHER_AGENT_ID,
      "--effort",
      "extra",
      "--json",
    ]);
    expect(JSON.parse(String(mockConsoleLog.mock.calls[0]?.[0]))).toMatchObject(
      {
        selectedModel: "claude-opus-5-5",
      },
    );
  });

  it("suggests --model for a server 400 when the inherited model cannot accept effort", async () => {
    server.use(
      http.post(CREATE_URL, () => {
        return HttpResponse.json(
          {
            error: {
              code: "BAD_REQUEST",
              message: "Reasoning effort is not supported by this model",
            },
          },
          { status: 400 },
        );
      }),
    );
    await expect(
      chatCommand.parseAsync([
        "node",
        "cli",
        "create",
        "Inherited",
        "--agent",
        OTHER_AGENT_ID,
        "--effort",
        "xhigh",
      ]),
    ).rejects.toThrow("process.exit called");
    expect(mockConsoleError.mock.calls.flat().join("\n")).toContain(
      "Pass --model <id> with an effort supported by that model",
    );
  });

  it("rejects unsupported explicit model effort before creating a thread", async () => {
    let requests = 0;
    server.use(
      http.post(CREATE_URL, () => {
        requests++;
        return new HttpResponse(null, { status: 500 });
      }),
    );
    await expect(
      chatCommand.parseAsync([
        "node",
        "cli",
        "create",
        "Debate",
        "--agent",
        OTHER_AGENT_ID,
        "--model",
        "claude-opus-5-5",
        "--effort",
        "xhigh",
      ]),
    ).rejects.toThrow("process.exit called");
    expect(requests).toBe(0);
    expect(mockConsoleError.mock.calls.flat().join("\n")).toContain(
      "claude-opus-5-5 supports: low, medium, high, extra, max, ultracode",
    );
  });

  it("requires an agent when it runs outside a web chat thread", async () => {
    vi.stubEnv("OKOU_CHAT_THREAD_ID", undefined);

    await expect(async () => {
      await chatCommand.parseAsync(["node", "cli", "create", "Launch plan"]);
    }).rejects.toThrow("process.exit called");

    const stderr = mockConsoleError.mock.calls.flat().join("\n");
    expect(stderr).toContain("OKOU_CHAT_THREAD_ID is not set");
    expect(stderr).toContain("Pass --agent <agent-id>");
    expect(mockExit).toHaveBeenCalledWith(1);
  });
});
