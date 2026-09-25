import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { registerCommands, registerRequestedCommand } from "../../../okou";
import { listCommand } from "../channel/list";
import { historyCommand } from "../message/history";
import { repliesCommand } from "../message/replies";
import { sendCommand } from "../message/send";

const baseUrl = "http://localhost:3000/api/integrations/discord";
const guildId = "1346579924358245889";
const channelId = "1346579924358245999";
const messageId = "18446744073709551614";
const before = "18446744073709551613";
const messageUrl = `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
const message = {
  id: messageId,
  channelId,
  content: "Release is ready",
  author: { id: "18446744073709551612", username: "linghan" },
  timestamp: "2026-09-24T10:00:00.000000+00:00",
  url: messageUrl,
  attachments: [
    {
      id: "18446744073709551611",
      filename: "report.pdf",
      size: 1234,
      contentType: "application/pdf",
    },
  ],
};

async function runDiscordCommand(args: string[]): Promise<void> {
  const argv = ["node", "okou", "discord", ...args];
  const program = new Command();
  await registerRequestedCommand(program, argv);
  await program.parseAsync(argv);
}

describe("okou discord", () => {
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation(() => {
    throw new Error("process.exit");
  });

  beforeEach(() => {
    vi.stubEnv("OKOU_TOKEN", "test-token");
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    for (const command of [
      listCommand,
      historyCommand,
      repliesCommand,
      sendCommand,
    ]) {
      for (const option of [
        "guildId",
        "channelId",
        "messageId",
        "before",
        "text",
        "json",
      ]) {
        command.setOptionValue(option, undefined);
      }
    }
    historyCommand.setOptionValue("limit", "50");
    repliesCommand.setOptionValue("limit", "50");
  });

  it("lists channels with an explicit guild and preserves large snowflakes as JSON strings", async () => {
    const channels = [
      { id: channelId, name: "general", type: 0, guildId, parentId: null },
    ];
    let query: URLSearchParams | undefined;
    server.use(
      http.get(`${baseUrl}/channels`, ({ request }) => {
        query = new URL(request.url).searchParams;
        return HttpResponse.json({ channels });
      }),
    );

    await runDiscordCommand([
      "channel",
      "list",
      "--guild-id",
      guildId,
      "--json",
    ]);

    expect(Object.fromEntries(query ?? [])).toStrictEqual({ guildId });
    expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toStrictEqual({
      channels,
    });
  });

  it("reads a bounded history page with exact before IDs and attachment metadata", async () => {
    let query: URLSearchParams | undefined;
    const response = {
      channelId,
      contextMode: "mentions_only",
      messages: [message],
      nextBefore: before,
    };
    server.use(
      http.get(`${baseUrl}/messages`, ({ request }) => {
        query = new URL(request.url).searchParams;
        return HttpResponse.json(response);
      }),
    );

    await runDiscordCommand([
      "message",
      "history",
      "--channel-id",
      channelId,
      "--guild-id",
      guildId,
      "--before",
      before,
      "--limit",
      "25",
      "--json",
    ]);

    expect(Object.fromEntries(query ?? [])).toStrictEqual({
      guildId,
      channelId,
      before,
      limit: "25",
    });
    expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toStrictEqual(
      response,
    );
  });

  it("reads the native thread of a root message and prints source URLs and continuation guidance", async () => {
    let query: URLSearchParams | undefined;
    server.use(
      http.get(`${baseUrl}/replies`, ({ request }) => {
        query = new URL(request.url).searchParams;
        return HttpResponse.json({
          channelId,
          contextMode: "full",
          messageId,
          threadId: messageId,
          messages: [message],
          nextBefore: before,
        });
      }),
    );

    await runDiscordCommand([
      "message",
      "replies",
      "--channel-id",
      channelId,
      "--message-id",
      messageId,
    ]);

    expect(Object.fromEntries(query ?? [])).toStrictEqual({
      channelId,
      messageId,
      limit: "50",
    });
    const text = output.mock.calls.flat().join("\n");
    expect(text).toContain(`Thread: ${messageId}`);
    expect(text).toContain(messageUrl);
    expect(text).toContain("report.pdf");
    expect(text).toContain(`Next before: ${before}`);
    expect(text).toContain("Continue with --before");
    expect(text).not.toContain("Limited content visibility");
  });

  it("explains limited visibility when ordinary message content is withheld", async () => {
    server.use(
      http.get(`${baseUrl}/messages`, () => {
        return HttpResponse.json({
          channelId,
          contextMode: "mentions_only",
          messages: [{ ...message, content: "", attachments: [] }],
          nextBefore: null,
        });
      }),
    );

    await runDiscordCommand(["message", "history", "--channel-id", channelId]);

    const text = output.mock.calls.flat().join("\n");
    expect(text).toContain("Limited content visibility (mentions_only)");
    expect(text).toContain(
      "Missing content does not mean the conversation was empty",
    );
    expect(text).toContain("Text may be withheld by Discord");
    expect(text).toContain(messageUrl);
    expect(text).not.toContain("No text content");
  });

  it("preserves the visibility limit on an empty native-thread page", async () => {
    server.use(
      http.get(`${baseUrl}/replies`, () => {
        return HttpResponse.json({
          channelId,
          contextMode: "mentions_only",
          messageId,
          threadId: messageId,
          messages: [],
          nextBefore: null,
        });
      }),
    );

    await runDiscordCommand([
      "message",
      "replies",
      "--channel-id",
      channelId,
      "--message-id",
      messageId,
    ]);

    const text = output.mock.calls.flat().join("\n");
    expect(text).toContain("Limited content visibility (mentions_only)");
    expect(text).toContain(
      "Missing content does not mean the conversation was empty",
    );
    expect(text).toContain("No messages returned on this page");
  });

  it("sends the complete long text and prints every split message receipt", async () => {
    const text = "A release update. ".repeat(200);
    const secondUrl = `https://discord.com/channels/${guildId}/${channelId}/${before}`;
    let body: unknown;
    server.use(
      http.post(`${baseUrl}/message`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({
          messages: [
            { id: messageId, channelId, url: messageUrl },
            { id: before, channelId, url: secondUrl },
          ],
        });
      }),
    );

    await runDiscordCommand([
      "message",
      "send",
      "--channel-id",
      channelId,
      "--guild-id",
      guildId,
      "--text",
      text,
    ]);

    expect(body).toStrictEqual({ channelId, guildId, text });
    const printed = output.mock.calls.flat().join("\n");
    expect(printed).toContain("2 Discord messages");
    expect(printed).toContain(messageUrl);
    expect(printed).toContain(secondUrl);
  });

  it("preserves partial-send receipts and rate-limit guidance without reporting success", async () => {
    server.use(
      http.post(`${baseUrl}/message`, () => {
        return HttpResponse.json(
          {
            error: {
              code: "DISCORD_RATE_LIMITED",
              message: "Discord rate limit reached. Retry after 60 seconds.",
              retryAfterSeconds: 60,
              deliveredMessages: [
                { id: messageId, channelId, url: messageUrl },
              ],
            },
          },
          { status: 429 },
        );
      }),
    );

    await expect(
      runDiscordCommand([
        "message",
        "send",
        "--channel-id",
        channelId,
        "--text",
        "An update",
      ]),
    ).rejects.toThrow("process.exit");

    const printed = errors.mock.calls.flat().join("\n");
    expect(printed).toContain("Retry after 60 seconds");
    expect(printed).toContain(
      "Already delivered messages (do not resend these)",
    );
    expect(printed).toContain(messageUrl);
    expect(output).not.toHaveBeenCalled();
  });

  it("reports a --guild-id that does not match the organization's binding as unavailable", async () => {
    server.use(
      http.get(`${baseUrl}/channels`, () => {
        return HttpResponse.json(
          {
            error: {
              code: "NOT_FOUND",
              message:
                "This Discord conversation is unavailable to your connected account and Okou in the current organization.",
            },
          },
          { status: 404 },
        );
      }),
    );

    await expect(
      runDiscordCommand(["channel", "list", "--guild-id", guildId]),
    ).rejects.toThrow("process.exit");
    expect(errors.mock.calls.flat().join("\n")).toContain(
      "unavailable to your connected account and Okou in the current organization",
    );
    expect(output).not.toHaveBeenCalled();
  });

  it.each([
    {
      args: ["message", "history", "--channel-id", "18446744073709551616"],
      error: "unsigned 64-bit range",
    },
    {
      args: [
        "message",
        "history",
        "--channel-id",
        channelId,
        "--before",
        "1e18",
      ],
      error: "Expected a Discord snowflake ID",
    },
    {
      args: ["message", "history", "--channel-id", channelId, "--limit", "101"],
      error: "limit",
    },
    {
      args: ["message", "send", "--channel-id", channelId, "--text", "   "],
      error: "Message text must not be blank",
    },
  ])(
    "rejects invalid command arguments before requesting Discord: $error",
    async ({ args, error }) => {
      await expect(runDiscordCommand(args)).rejects.toThrow("process.exit");
      expect(errors.mock.calls.flat().join("\n")).toContain(error);
      expect(output).not.toHaveBeenCalled();
    },
  );

  it.each([
    { capabilities: ["discord:read"], visible: true },
    { capabilities: ["discord:write"], visible: true },
    { capabilities: ["slack:read"], visible: false },
  ])(
    "gates Discord discovery in help for $capabilities",
    async ({ capabilities, visible }) => {
      const header = Buffer.from(JSON.stringify({ alg: "HS256" })).toString(
        "base64url",
      );
      const body = Buffer.from(
        JSON.stringify({ scope: "okou", capabilities }),
      ).toString("base64url");
      vi.stubEnv("OKOU_TOKEN", `vm0_sandbox_${header}.${body}.test-signature`);
      let help = "";
      const program = new Command().exitOverride().configureOutput({
        writeOut: (text) => {
          help += text;
        },
      });
      registerCommands(program);

      await expect(
        program.parseAsync(["node", "okou", "--help"]),
      ).rejects.toThrow("(outputHelp)");

      expect(help.includes("discord")).toBe(visible);
    },
  );
});
