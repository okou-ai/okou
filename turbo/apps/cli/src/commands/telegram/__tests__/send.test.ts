/**
 * Tests for okou telegram message send command.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { sendCommand } from "../message/send";
import chalk from "chalk";

const TELEGRAM_MESSAGE_URL =
  "http://localhost:3000/api/integrations/telegram/message";

describe("okou telegram message send command", () => {
  vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  beforeEach(() => {
    chalk.level = 0;
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("OKOU_TOKEN", "test-token");
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
  });

  it("sends a message with --text", async () => {
    let capturedBody: Record<string, unknown> | undefined;

    server.use(
      http.post(TELEGRAM_MESSAGE_URL, async ({ request }) => {
        capturedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(
          { ok: true, messageId: 321, chatId: "-1001234567890" },
          { status: 200 },
        );
      }),
    );

    await sendCommand.parseAsync([
      "node",
      "cli",
      "--as",
      "123456789",
      "--to",
      "-1001234567890",
      "--text",
      "hello world",
      "--reply-to",
      "42",
      "--topic",
      "7",
    ]);

    expect(capturedBody).toMatchObject({
      botId: "123456789",
      chatId: "-1001234567890",
      text: "hello world",
      replyToMessageId: 42,
      messageThreadId: 7,
    });
    const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
    expect(logCalls).toContain("Message sent");
    expect(logCalls).toContain("message_id: 321");
  });

  it("errors when text is missing", async () => {
    await expect(async () => {
      await sendCommand.parseAsync([
        "node",
        "cli",
        "--as",
        "123456789",
        "--to",
        "-1001234567890",
      ]);
    }).rejects.toThrow("process.exit called");

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("Either --text or piped stdin must be provided"),
    );
  });

  it("errors when --topic is not a positive integer", async () => {
    await expect(async () => {
      await sendCommand.parseAsync([
        "node",
        "cli",
        "--as",
        "123456789",
        "--to",
        "-1001234567890",
        "--text",
        "hello",
        "--topic",
        "not-a-number",
      ]);
    }).rejects.toThrow("process.exit called");

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("--topic must be a positive integer"),
    );
  });

  it("errors when --to is me", async () => {
    await expect(async () => {
      await sendCommand.parseAsync([
        "node",
        "cli",
        "--as",
        "123456789",
        "--to",
        "me",
        "--text",
        "hello",
      ]);
    }).rejects.toThrow("process.exit called");

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("Telegram does not support --to me"),
    );
  });

  it("surfaces API errors", async () => {
    server.use(
      http.post(TELEGRAM_MESSAGE_URL, () => {
        return HttpResponse.json(
          {
            error: {
              message: "Telegram API error: Bad Request: chat not found",
              code: "TELEGRAM_ERROR",
            },
          },
          { status: 400 },
        );
      }),
    );

    await expect(async () => {
      await sendCommand.parseAsync([
        "node",
        "cli",
        "--as",
        "123456789",
        "--to",
        "-1001234567890",
        "--text",
        "hello",
      ]);
    }).rejects.toThrow("process.exit called");

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("chat not found"),
    );
  });
});
