import {
  fauxAssistantMessage,
  fauxToolCall,
  type Message,
} from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { encode } from "gpt-tokenizer/encoding/o200k_base";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  onTestFinished,
} from "vitest";

import { MemoryPiSession } from "./session-memory";
import {
  projectPiMemoryStage1Evidence,
  runPiMemoryStage1Extraction,
} from "./stage1-memory";
import {
  PiMemoryStage1BudgetError,
  boundStage1Evidence,
  selectStage1Evidence,
  stage1InputBudgets,
  type PiMemoryStage1Evidence,
} from "./stage1-input";
import type { PiAgentModelConfig } from "./types";
import { renderPiMemoryStage1Input } from "./stage1-prompts";

const server = setupServer();
beforeAll(() => {
  return server.listen({ onUnhandledRequest: "error" });
});
afterEach(() => {
  return server.resetHandlers();
});
afterAll(() => {
  return server.close();
});
const SESSION = "00000000-0000-4000-8000-000000000123";
const MODEL = "gpt-5.6-luna";

function canonical(messages: readonly Message[]): PiMemoryStage1Evidence[] {
  const session = MemoryPiSession.create({ cwd: "/private/path", id: SESSION });
  for (const message of messages) session.appendMessage(message);
  session.appendMessage(
    fauxAssistantMessage("settled", { stopReason: "stop" }),
  );
  return projectPiMemoryStage1Evidence({
    jsonl: session.toJsonl(),
    expectedSessionId: SESSION,
  });
}

function textMessage(text: string, phase?: string): Message {
  return fauxAssistantMessage([{ type: "text", text, textSignature: phase }], {
    stopReason: "stop",
  });
}

function phase(value: string): string {
  return JSON.stringify({ v: 1, id: "private-provider-id", phase: value });
}

function captureBodies(): string[] {
  const bodies: string[] = [];
  server.use(
    http.post("https://stage1.test/v1/responses", async ({ request }) => {
      bodies.push(await request.text());
      const text = JSON.stringify({
        raw_memory: "memory",
        rollout_summary: "summary",
        rollout_slug: null,
      });
      const events = [
        {
          type: "response.created",
          response: { id: "resp_test", output: [], usage: null },
        },
        {
          type: "response.output_item.added",
          output_index: 0,
          item: {
            type: "message",
            id: "msg_test",
            role: "assistant",
            content: [],
          },
        },
        {
          type: "response.output_text.delta",
          output_index: 0,
          content_index: 0,
          delta: text,
        },
        {
          type: "response.completed",
          response: {
            id: "resp_test",
            status: "completed",
            output: [],
            usage: {
              input_tokens: 11,
              output_tokens: 7,
              input_tokens_details: { cached_tokens: 2 },
              total_tokens: 18,
            },
          },
        },
      ];
      return new HttpResponse(
        events
          .map((event) => {
            return `data: ${JSON.stringify(event)}\n\n`;
          })
          .join(""),
        { headers: { "content-type": "text/event-stream" } },
      );
    }),
  );
  return bodies;
}

function config(
  provider = "openai",
): Extract<PiAgentModelConfig, { dialect: "openai-responses" }> {
  return {
    provider,
    model: provider === "openrouter" ? `openai/${MODEL}` : MODEL,
    baseUrl: "https://stage1.test/v1",
    apiKey: "test-key",
    dialect: "openai-responses",
    transport: "sse",
  };
}

function overrideCatalog(property: string, value: unknown): void {
  // External SDK metadata fault injection; serialization and HTTP remain real.
  const model = openaiProvider()
    .getModels()
    .find((item) => {
      return item.id === MODEL;
    });
  if (!model) throw new Error("Missing pinned Luna catalog");
  const descriptor = Object.getOwnPropertyDescriptor(model, property);
  Object.defineProperty(model, property, {
    value,
    configurable: true,
    writable: true,
  });
  onTestFinished(() => {
    if (descriptor) Object.defineProperty(model, property, descriptor);
    else Reflect.deleteProperty(model, property);
  });
}

function count(text: string): number {
  return encode(text, { disallowedSpecial: new Set() }).length;
}

function historyFromBody(body: string): string {
  const parsed: unknown = JSON.parse(body);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("input" in parsed) ||
    !Array.isArray(parsed.input)
  )
    throw new Error("Missing input");
  const user: unknown = parsed.input[1];
  if (
    typeof user !== "object" ||
    user === null ||
    !("content" in user) ||
    !Array.isArray(user.content)
  )
    throw new Error("Missing user");
  const part: unknown = user.content[0];
  if (
    typeof part !== "object" ||
    part === null ||
    !("text" in part) ||
    typeof part.text !== "string"
  )
    throw new Error("Missing text");
  const text = part.text;
  return (
    text.split("filtered response items):\n")[1]?.split("\n\nIMPORTANT:")[0] ??
    ""
  );
}

describe("Stage 1 evidence and complete request admission", () => {
  it("renders replacement metacharacters as literal evidence", () => {
    const evidence = "$& $` $' $$";
    expect(renderPiMemoryStage1Input(evidence)).toContain(
      `filtered response items):\n${evidence}\n\nIMPORTANT:`,
    );
  });

  it("classifies recognized phases and whole agent envelopes without inventing provenance", () => {
    const signatures = [
      phase("final_answer"),
      phase("commentary"),
      undefined,
      "legacy-id",
      "{bad",
      phase("analysis"),
      JSON.stringify({ v: 2, id: "id", phase: "final_answer" }),
      JSON.stringify({ v: 1, id: 3, phase: "commentary" }),
    ];
    const rows = canonical([
      { role: "user", content: "human", timestamp: 0 },
      ...signatures.map((signature, index) => {
        return textMessage(`answer ${index}`, signature);
      }),
      {
        role: "user",
        content:
          "Message Type: MESSAGE\nTask name: task\nSender: agent\nPayload:\ncomplete result",
        timestamp: 0,
      },
      {
        role: "user",
        content:
          "<subagent_notification>complete result</subagent_notification>",
        timestamp: 0,
      },
      { role: "user", content: "prose mentioning an agent", timestamp: 0 },
      {
        role: "user",
        content: "<environment_context>runtime</environment_context>",
        timestamp: 0,
      },
      {
        role: "user",
        content: "# AGENTS.md instructions private",
        timestamp: 0,
      },
      {
        role: "user",
        content: "<permissions instructions>private</permissions instructions>",
        timestamp: 0,
      },
    ]);
    expect(
      rows.map((row) => {
        return row.kind;
      }),
    ).toEqual([
      "human",
      "final",
      "commentary",
      "assistant",
      "assistant",
      "assistant",
      "assistant",
      "assistant",
      "assistant",
      "other_agent",
      "other_agent",
      "human",
      "assistant",
    ]);
    expect(JSON.stringify(rows)).not.toContain("private");
    expect(JSON.stringify(rows)).not.toContain("textSignature");
    expect(JSON.stringify(rows)).not.toContain("legacy-id");
  });

  it("redacts split secrets and citations before Unicode-safe row clipping and replaces media", () => {
    const key = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789";
    const rows = canonical([
      {
        role: "user",
        timestamp: 0,
        content: [
          { type: "text", text: '"\\😀汉字'.repeat(5_000) },
          { type: "image", data: "PRIVATE_BASE64", mimeType: "image/png" },
        ],
      },
      fauxAssistantMessage(
        [
          {
            type: "text",
            text: `start ${key.slice(0, 17)}`,
            textSignature: phase("commentary"),
          },
          {
            type: "text",
            text: `${key.slice(17)}<oai-mem-`,
            textSignature: phase("final_answer"),
          },
          {
            type: "text",
            text: "citation><citation_entries>private.md:1-1|note=[private]</citation_entries></oai-mem-citation> visible",
            textSignature: phase("final_answer"),
          },
          {
            type: "text",
            text: "-----BEGIN RSA PRIVATE KEY-----\nprivate material",
          },
          { type: "text", text: "more private material" },
        ],
        { stopReason: "stop" },
      ),
    ]);
    const history = selectStage1Evidence(rows, 150_000, 200_000);
    expect(history).toContain("[image omitted]");
    expect(history).toContain("[... truncated ...]");
    expect(history).toContain("[REDACTED_SECRET]");
    for (const privateText of [
      key,
      key.slice(17),
      "PRIVATE_BASE64",
      "private.md",
      "private material",
      "�",
    ])
      expect(history).not.toContain(privateText);
    for (const row of history.trimEnd().split("\n")) {
      expect(Buffer.byteLength(`${row}\n`, "utf8")).toBeLessThanOrEqual(10_000);
      expect(() => {
        return JSON.parse(row);
      }).not.toThrow();
    }
  });

  it("keeps paired arbitrary tools at Tool and bounds the complete result to 2,000 local tokens", () => {
    const call = fauxToolCall(
      "request_user_input",
      {
        question: "which option?",
        secret: "private-secret",
        command: 'password="nested-command-secret"',
      },
      { id: "private-call-id" },
    );
    const rows = canonical([
      fauxAssistantMessage([call], { stopReason: "toolUse" }),
      {
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        isError: false,
        timestamp: 0,
        content: [
          {
            type: "text",
            text: '{"answers":["yes"]}' + '"\\汉字😀'.repeat(5_000),
          },
        ],
      },
    ]);
    expect(rows[0]?.kind).toBe("tool");
    const history = selectStage1Evidence(rows, 150_000, 200_000);
    const tool = history.split("\n").find((row) => {
      return row.includes('"role":"tool"');
    });
    expect(tool).toBeDefined();
    expect(count(`${tool}\n`)).toBeLessThanOrEqual(2_000);
    expect(Buffer.byteLength(`${tool}\n`, "utf8")).toBeLessThanOrEqual(10_000);
    expect(tool).toContain("which option?");
    expect(tool).toContain("[... truncated ...]");
    expect(tool).not.toContain("private-secret");
    expect(tool).not.toContain("nested-command-secret");
    expect(tool).not.toContain("private-call-id");
    expect(selectStage1Evidence(rows, 20, 20)).not.toContain('"role":"tool"');
  });

  it("selects newest Human before lower tiers and restores source order with bounded gaps", () => {
    const rows = canonical([
      textMessage("old tool-like assistant", phase("commentary")),
      {
        role: "user",
        content: `old human ${"old ".repeat(500)}`,
        timestamp: 0,
      },
      textMessage("final below human", phase("final_answer")),
      { role: "user", content: "new human decision", timestamp: 0 },
      textMessage("last commentary", phase("commentary")),
    ]);
    const selected = selectStage1Evidence(rows, 110, 110);
    expect(selected).toContain("new human decision");
    expect(selected).toContain("old human");
    expect(selected.indexOf("old human")).toBeLessThan(
      selected.indexOf("new human decision"),
    );
    expect(selected).not.toContain("final below human");
    expect(selected).not.toContain("commentary");
    expect(count(selected)).toBeLessThanOrEqual(110);
    expect(selected).toContain("response items omitted");
  });

  it("orders all tiers ahead of recency and reselects as the serialized budget shrinks", () => {
    // Context tests the selector contract only; canonical Pi does not supply it.
    const kinds = [
      "human",
      "final",
      "other_agent",
      "commentary",
      "context",
      "tool",
    ] as const;
    for (let index = 0; index < kinds.length; index += 1) {
      const competing = kinds.slice(index);
      const rows = boundStage1Evidence(
        competing.map((kind) => {
          return { kind, content: `${kind} ${"value ".repeat(80)}` };
        }),
      );
      const small = selectStage1Evidence(rows, 600, 115);
      expect(small).toContain(`"role":"${competing[0]}"`);
      for (const kind of competing.slice(1))
        expect(small).not.toContain(`"role":"${kind}"`);
      if (competing.length > 1) {
        const larger = selectStage1Evidence(rows, 600, 235);
        expect(larger).toContain(`"role":"${competing[1]}"`);
        expect(larger.indexOf(`"role":"${competing[0]}"`)).toBeLessThan(
          larger.indexOf(`"role":"${competing[1]}"`),
        );
      }
    }
  });

  it("retains the 8 MiB defense for bounded prepared evidence", () => {
    const rows: PiMemoryStage1Evidence[] = Array.from({ length: 950 }, () => {
      return { kind: "human", content: "x".repeat(9_000) };
    });
    expect(() => {
      return boundStage1Evidence(rows);
    }).toThrow(PiMemoryStage1BudgetError);
  });

  it.each(["openai", "openrouter"])(
    "caps the actual %s Luna HTTP body with large competing canonical evidence",
    async (provider) => {
      const edgeTools = (id: string): Message[] => {
        const call = fauxToolCall("read", { path: id }, { id });
        return [
          fauxAssistantMessage([call], { stopReason: "toolUse" }),
          {
            role: "toolResult",
            toolCallId: id,
            toolName: "read",
            isError: false,
            timestamp: 0,
            content: [
              { type: "text", text: `${id} ${"tool output ".repeat(1_000)}` },
            ],
          },
        ];
      };
      const messages: Message[] = edgeTools("low-tool-first");
      for (let index = 0; index < 120; index += 1) {
        messages.push(
          textMessage(
            `commentary ${index} ${"tool noise ".repeat(100)}`,
            phase("commentary"),
          ),
        );
        messages.push({
          role: "user",
          timestamp: index,
          content: `human-${index} ${'"\\汉😀 '.repeat(600)}`,
        });
        messages.push(
          textMessage(
            `final-${index} ${"final evidence ".repeat(100)}`,
            phase("final_answer"),
          ),
        );
      }
      messages.push(...edgeTools("low-tool-last"));
      const bodies = captureBodies();
      await runPiMemoryStage1Extraction({
        model: config(provider),
        evidence: canonical(messages),
        requestId: "bounded-request",
      });
      expect(bodies).toHaveLength(1);
      const body = bodies[0] ?? "";
      const tokens = count(body);
      expect(tokens).toBeGreaterThan(100_000);
      expect(tokens).toBeLessThanOrEqual(250_000);
      const window = provider === "openai" ? 272_000 : 1_050_000;
      expect(tokens + 32_768 + 8_192).toBeLessThanOrEqual(window);
      const history = historyFromBody(body);
      expect(history).toContain("human-119");
      expect(history).not.toContain("human-0 ");
      expect(history).not.toContain('"role":"commentary"');
      expect(history).not.toContain("low-tool-");
      expect(count(history)).toBeLessThanOrEqual(Math.floor(window * 0.7));
      for (const row of history.trimEnd().split("\n"))
        expect(Buffer.byteLength(`${row}\n`, "utf8")).toBeLessThanOrEqual(
          10_000,
        );
    },
  );

  it.each([undefined, null, 0, -1, NaN, Infinity])(
    "uses the 150,000 history ceiling for unknown or invalid window %s in the actual body",
    async (window) => {
      overrideCatalog("contextWindow", window);
      const bodies = captureBodies();
      const evidence = boundStage1Evidence(
        Array.from({ length: 100 }, (_, index) => {
          return {
            kind: "human",
            content: `${index} ${'\\"value '.repeat(1_400)}`,
          };
        }),
      );
      await runPiMemoryStage1Extraction({
        model: config(),
        evidence,
        requestId: "invalid-window",
      });
      expect(bodies).toHaveLength(1);
      expect(count(bodies[0] ?? "")).toBeLessThanOrEqual(250_000);
      expect(count(historyFromBody(bodies[0] ?? ""))).toBeLessThanOrEqual(
        150_000,
      );
    },
  );

  it.each([1, 40_960, 40_961])(
    "rejects an impossible %s-token context before HTTP",
    async (window) => {
      overrideCatalog("contextWindow", window);
      const bodies = captureBodies();
      await expect(
        runPiMemoryStage1Extraction({
          model: config(),
          evidence: canonical([]),
          requestId: "tiny-window",
        }),
      ).rejects.toBeInstanceOf(PiMemoryStage1BudgetError);
      expect(bodies).toHaveLength(0);
      expect(stage1InputBudgets(null)).toEqual({
        history: 150_000,
        request: 250_000,
      });
    },
  );

  it("counts heavy SDK fields and reselects Human instead of truncating selected history", async () => {
    const bodies = captureBodies();
    const evidence = canonical(
      Array.from({ length: 100 }, (_, index) => {
        return {
          role: "user",
          timestamp: index,
          content: `human-${index} ${"value ".repeat(2_000)}`,
        };
      }),
    );
    await runPiMemoryStage1Extraction({
      model: {
        ...config(),
        catalogModel: MODEL,
        model: 'overhead"\\ '.repeat(25_000),
      },
      evidence,
      requestId: "overhead",
    });
    expect(bodies).toHaveLength(1);
    expect(count(bodies[0] ?? "")).toBeLessThanOrEqual(231_040);
    expect(historyFromBody(bodies[0] ?? "")).toContain("human-99");
    expect(historyFromBody(bodies[0] ?? "")).not.toContain("human-0 ");
  });

  it.each(["unmeasurable", "over_budget"])(
    "retains terminal %s classification through the SDK callback error with zero HTTP",
    async (failure) => {
      const bodies = captureBodies();
      if (failure === "unmeasurable")
        overrideCatalog("thinkingLevelMap", { low: 1n });
      const model =
        failure === "over_budget"
          ? {
              ...config(),
              catalogModel: MODEL,
              model: 'overhead"\\ '.repeat(100_000),
            }
          : config();
      await expect(
        runPiMemoryStage1Extraction({
          model,
          evidence: canonical([]),
          requestId: "rejected",
        }),
      ).rejects.toMatchObject({
        name: "PiMemoryStage1BudgetError",
        errorClass:
          failure === "unmeasurable"
            ? "input_payload_unmeasurable"
            : "input_budget_exceeded",
      });
      expect(bodies).toHaveLength(0);
    },
  );
});
