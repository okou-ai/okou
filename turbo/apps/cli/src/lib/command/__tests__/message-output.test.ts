import chalk from "chalk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type MessageSendOutput, printMessageOutput } from "../message-output";

const UPLOAD: MessageSendOutput = {
  integration: "slack",
  chatId: "C123",
  messages: [],
  file: {
    name: "report.pdf",
    contentType: "application/pdf",
    size: 12,
    url: "https://files.example/report.pdf",
  },
  delivery: { status: "failed", error: "rate limited", operationId: "op-1" },
};

describe("printMessageOutput", () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});

  beforeEach(() => {
    chalk.level = 0;
  });

  function printed(): string {
    return log.mock.calls.flat().join("\n");
  }

  it("prints exactly one JSON object with --json", () => {
    printMessageOutput(UPLOAD, { json: true });

    expect(log).toHaveBeenCalledOnce();
    expect(JSON.parse(printed())).toStrictEqual(UPLOAD);
  });

  it("summarizes a single sent message", () => {
    printMessageOutput(
      {
        integration: "discord",
        chatId: "42",
        messages: [{ id: "1", url: "https://discord.com/channels/1/42/1" }],
      },
      {},
    );

    expect(printed()).toBe(
      [
        "✓ Message sent (id: 1)",
        "  chat: 42",
        "  permalink: https://discord.com/channels/1/42/1",
      ].join("\n"),
    );
  });

  it("lists every message when a send is split", () => {
    printMessageOutput(
      {
        integration: "discord",
        chatId: null,
        messages: [
          { id: "1", url: "https://discord.com/1" },
          { id: "2", url: null },
        ],
      },
      {},
    );

    expect(printed()).toBe(
      ["✓ Message sent (2 messages)", "  1  https://discord.com/1", "  2"].join(
        "\n",
      ),
    );
  });

  it("summarizes an upload with undelivered status", () => {
    printMessageOutput(UPLOAD, {});

    expect(printed()).toBe(
      [
        "✓ File uploaded",
        "  chat: C123",
        "  file: report.pdf (application/pdf, 12 bytes)",
        "  url: https://files.example/report.pdf",
        "  delivery: failed",
      ].join("\n"),
    );
  });
});
