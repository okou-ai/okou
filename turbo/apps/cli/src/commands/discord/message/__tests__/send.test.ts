import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const channelId = "1346579924358245999";
const messageId = "18446744073709551614";

function sendWithStdin(input: string, args: readonly string[] = []) {
  return execFileSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--import",
      'data:text/javascript,globalThis.__CLI_VERSION__="0.0.0-test"',
      fileURLToPath(new URL("./fixtures/send.fixture.ts", import.meta.url)),
      "--to",
      channelId,
      ...args,
    ],
    {
      input,
      encoding: "utf8",
      env: {
        ...process.env,
        OKOU_TOKEN: "test-token",
        OKOU_API_BACKEND_URL: "http://localhost:3000",
      },
    },
  );
}

describe("okou discord message send stdin", () => {
  it("reads real piped multiline text and preserves exact reply IDs", () => {
    const output = sendWithStdin("First line\nSecond line\n", [
      "--reply-to",
      messageId,
      "--json",
    ]);
    const [request, ...receipt] = output.trim().split("\n");
    if (!request) {
      throw new Error("Expected an observed API request");
    }
    expect(JSON.parse(request)).toStrictEqual({
      channelId,
      text: "First line\nSecond line",
      replyToMessageId: messageId,
    });
    expect(JSON.parse(receipt.join("\n"))).toMatchObject({
      integration: "discord",
      chatId: channelId,
    });
  });

  it("uses explicit --text instead of piped input", () => {
    const output = sendWithStdin("Ignored input", [
      "--text",
      "Explicit text",
      "--json",
    ]);
    expect(JSON.parse(output.split("\n")[0] ?? "")).toStrictEqual({
      channelId,
      text: "Explicit text",
    });
  });

  it("fails empty piped input with actionable guidance", () => {
    expect(() => {
      sendWithStdin(" \n ");
    }).toThrow("Provide --text or pipe message text on stdin");
  });

  it("enforces the same input limit for piped text", () => {
    expect(() => {
      sendWithStdin("x".repeat(20_001));
    }).toThrow("20000");
  });
});
