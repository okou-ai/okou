import { describe, expect, it } from "vitest";

type JsonEventProjector = (event: unknown) => unknown;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function loadJsonEventProjector(): Promise<JsonEventProjector> {
  const packageEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
  const moduleUrl = new URL("./modes/json-event.js", packageEntry);
  const imported: unknown = await import(moduleUrl.href);
  if (!isRecord(imported) || typeof imported.toJsonEvent !== "function") {
    throw new Error("Pi JSON event projector is unavailable");
  }
  return imported.toJsonEvent as JsonEventProjector;
}

function textStart(api: string, text: string): unknown {
  return {
    type: "message_update",
    message: { role: "assistant", api, content: [], usage: {} },
    assistantMessageEvent: {
      type: "text_start",
      contentIndex: 0,
      partial: {
        role: "assistant",
        api,
        content: [{ type: "text", text }],
        usage: {},
      },
    },
  };
}

function assistantMessageEvent(projected: unknown): Record<string, unknown> {
  if (!isRecord(projected) || !isRecord(projected.assistantMessageEvent)) {
    throw new Error("Pi JSON event omitted assistantMessageEvent");
  }
  return projected.assistantMessageEvent;
}

describe("patched Pi JSON event wire", () => {
  it("retains Anthropic initial block text without exposing partial snapshots", async () => {
    const project = await loadJsonEventProjector();
    const event = assistantMessageEvent(
      project(textStart("anthropic-messages", "initial")),
    );

    expect(event.initialText).toBe("initial");
    expect(event).not.toHaveProperty("partial");
  });

  it("does not copy cumulative text for providers that deliver ordinary deltas", async () => {
    const project = await loadJsonEventProjector();
    const event = assistantMessageEvent(
      project(textStart("openai-responses", "must not copy")),
    );

    expect(event).not.toHaveProperty("initialText");
    expect(event).not.toHaveProperty("partial");
  });

  it("degrades to an empty start instead of failing on malformed Anthropic content", async () => {
    const project = await loadJsonEventProjector();
    const event = assistantMessageEvent(
      project({
        type: "message_update",
        message: {
          role: "assistant",
          api: "anthropic-messages",
          content: [],
          usage: {},
        },
        assistantMessageEvent: {
          type: "text_start",
          contentIndex: 0,
          partial: {
            role: "assistant",
            api: "anthropic-messages",
            content: [],
            usage: {},
          },
        },
      }),
    );

    expect(event).not.toHaveProperty("initialText");
    expect(event).not.toHaveProperty("partial");
  });
});
