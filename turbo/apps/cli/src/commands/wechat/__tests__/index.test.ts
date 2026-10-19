import { randomUUID } from "node:crypto";
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { registerCommands, registerRequestedCommand } from "../../../okou";
import { historyCommand } from "../message/history";
import { sendCommand } from "../message/send";
import { listCommand } from "../channel/list";
import { connectCommand } from "../connect";
const origin = "http://localhost:3000/api/integrations/wechat";
const channelId = randomUUID();
const binding = {
  workspace: { id: "org_team", name: "Operations" },
  accountId: "scanner-owner",
};
const messageId = randomUUID();
const before = randomUUID();
const message = {
  id: messageId,
  providerMessageId: "18446744073709551615",
  direction: "inbound",
  status: "received",
  content: "Project Orchid",
  quotedText: null,
  attachments: [{ id: "1", kind: "file", filename: "report.pdf", size: 123 }],
  timestamp: "2026-10-15T00:00:00.000Z",
};
async function run(args: string[]) {
  const argv = ["node", "okou", "wechat", ...args];
  const program = new Command();
  await registerRequestedCommand(program, argv);
  await program.parseAsync(argv);
}
describe("okou wechat", () => {
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation(() => {
    throw new Error("process.exit");
  });
  beforeEach(() => {
    vi.stubEnv("OKOU_TOKEN", "test-token");
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("OKOU_APP_URL", "https://app.okou.ai");
    for (const command of [
      historyCommand,
      sendCommand,
      listCommand,
      connectCommand,
    ]) {
      for (const option of [
        "channelId",
        "before",
        "oldest",
        "latest",
        "to",
        "text",
        "operationId",
        "json",
      ])
        command.setOptionValue(option, undefined);
    }
    historyCommand.setOptionValue("limit", "50");
  });
  it("hands connection to Works without claiming it is complete", async () => {
    await run(["connect", "--json"]);
    expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toStrictEqual({
      url: "https://app.okou.ai/works",
      flow: "connect",
    });
  });
  it("discovers the verified conversation", async () => {
    const channels = [
      { id: channelId, name: "WeChat", status: "active", binding },
    ];
    server.use(
      http.get(`${origin}/channels`, () => {
        return HttpResponse.json({ channels });
      }),
    );
    await run(["channel", "list", "--json"]);
    expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toStrictEqual({
      channels,
    });
  });
  it("shows the bound workspace and WeChat account", async () => {
    server.use(
      http.get(`${origin}/channels`, () => {
        return HttpResponse.json({
          channels: [
            {
              id: channelId,
              name: "WeChat",
              status: "active",
              binding: {
                workspace: { id: "org_team", name: "Operations" },
                accountId: "scanner-owner",
              },
            },
          ],
        });
      }),
    );
    await run(["channel", "list"]);
    expect(output.mock.calls.flat().join("\n")).toContain(
      "Workspace: Operations (org_team)",
    );
    expect(output.mock.calls.flat().join("\n")).toContain(
      "WeChat account: scanner-owner",
    );
  });
  it("resolves --to me through the current owner's verified conversation", async () => {
    const operationId = randomUUID();
    let sent: unknown;
    server.use(
      http.get(`${origin}/channels`, () => {
        return HttpResponse.json({
          channels: [
            { id: channelId, name: "WeChat", status: "active", binding },
          ],
        });
      }),
      http.post(`${origin}/message`, async ({ request }) => {
        sent = await request.json();
        return HttpResponse.json({
          operationId,
          messages: [
            { id: messageId, channelId, providerMessageId: null, url: null },
          ],
        });
      }),
    );
    await run([
      "message",
      "send",
      "--to",
      "me",
      "--text",
      "Hello",
      "--operation-id",
      operationId,
    ]);
    expect(sent).toStrictEqual({ channelId, operationId, text: "Hello" });
  });
  it.each(["missing", "reconnect_required", "multiple"])(
    "does not send --to me for %s bindings",
    async (state) => {
      const channel = {
        id: channelId,
        name: "WeChat",
        status: state === "reconnect_required" ? state : "active",
        binding,
      };
      let sends = 0;
      server.use(
        http.get(`${origin}/channels`, () => {
          return HttpResponse.json({
            channels:
              state === "missing"
                ? []
                : state === "multiple"
                  ? [channel, { ...channel, id: randomUUID() }]
                  : [channel],
          });
        }),
        http.post(`${origin}/message`, () => {
          sends++;
          return new HttpResponse(null, { status: 500 });
        }),
      );
      await expect(
        run(["message", "send", "--to", "me", "--text", "Hello"]),
      ).rejects.toThrow("process.exit");
      expect(sends).toBe(0);
    },
  );
  it("keeps exact provider IDs and bounded pagination", async () => {
    let query: URLSearchParams | undefined;
    const response = {
      channelId,
      messages: [message],
      nextBefore: before,
      historyScope: "okou_received_and_sent",
    };
    server.use(
      http.get(`${origin}/messages`, ({ request }) => {
        query = new URL(request.url).searchParams;
        return HttpResponse.json(response);
      }),
    );
    await run([
      "message",
      "history",
      "--channel-id",
      channelId,
      "--before",
      before,
      "--limit",
      "25",
      "--oldest",
      "2026-10-01T00:00:00+08:00",
      "--latest",
      "2026-11-01T00:00:00Z",
      "--json",
    ]);
    expect(Object.fromEntries(query ?? [])).toStrictEqual({
      channelId,
      before,
      limit: "25",
      oldest: "2026-10-01T00:00:00+08:00",
      latest: "2026-11-01T00:00:00Z",
    });
    expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toStrictEqual(
      response,
    );
  });
  it("prints history scope, uncertainty and continuation", async () => {
    server.use(
      http.get(`${origin}/messages`, () => {
        return HttpResponse.json({
          channelId,
          messages: [{ ...message, direction: "outbound", status: "unknown" }],
          nextBefore: before,
          historyScope: "okou_received_and_sent",
        });
      }),
    );
    await run(["message", "history", "--channel-id", channelId]);
    const printed = output.mock.calls.flat().join("\n");
    expect(printed).toContain("recorded by this Okou connection only");
    expect(printed).toContain("unknown");
    expect(printed).toContain("report.pdf");
    expect(printed).toContain(`--before ${before}`);
  });
  it("sends full text with a reusable operation and no invented permalink", async () => {
    const operationId = randomUUID();
    const text = "界".repeat(2100);
    let body: unknown;
    server.use(
      http.post(`${origin}/message`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({
          operationId,
          messages: [
            { id: messageId, channelId, providerMessageId: null, url: null },
          ],
        });
      }),
    );
    await run([
      "message",
      "send",
      "--to",
      `chat:${channelId}`,
      "--text",
      text,
      "--operation-id",
      operationId,
      "--json",
    ]);
    expect(body).toStrictEqual({ channelId, operationId, text });
    expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toStrictEqual({
      integration: "wechat",
      chatId: channelId,
      messages: [{ id: messageId, url: null }],
    });
  });
  it("preserves partial receipts and unknown delivery on failure", async () => {
    const operationId = randomUUID();
    server.use(
      http.post(`${origin}/message`, () => {
        return HttpResponse.json(
          {
            error: {
              code: "WECHAT_DELIVERY_UNKNOWN",
              message: "Delivery unknown",
              deliveredMessages: [
                {
                  id: messageId,
                  channelId,
                  providerMessageId: null,
                  url: null,
                },
              ],
              uncertainMessageId: before,
            },
          },
          { status: 502 },
        );
      }),
    );
    await expect(
      run([
        "message",
        "send",
        "--to",
        channelId,
        "--text",
        "hello",
        "--operation-id",
        operationId,
      ]),
    ).rejects.toThrow("process.exit");
    const printed = errors.mock.calls.flat().join("\n");
    expect(printed).toContain(messageId);
    expect(printed).toContain(before);
    expect(printed).toContain(operationId);
    expect(printed).toContain("do not resend");
    expect(output).not.toHaveBeenCalled();
  });
  it.each([
    ["message", "history", "--channel-id", channelId, "--limit", "101"],
    ["message", "history", "--channel-id", "not-a-conversation"],
    ["message", "history", "--channel-id", channelId, "--oldest", "yesterday"],
    [
      "message",
      "history",
      "--channel-id",
      channelId,
      "--oldest",
      "2026-11-01T00:00:00Z",
      "--latest",
      "2026-10-01T00:00:00Z",
    ],
    ["message", "send", "--to", channelId, "--text", "   "],
  ])("rejects invalid command input %j", async (...args) => {
    await expect(run(args)).rejects.toThrow("process.exit");
    expect(output).not.toHaveBeenCalled();
  });
  it.each([
    { capabilities: ["wechat:read"], visible: true },
    { capabilities: ["wechat:write"], visible: true },
    { capabilities: ["discord:read"], visible: false },
  ])("gates discovery for $capabilities", async ({ capabilities, visible }) => {
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
    expect(help.includes("wechat")).toBe(visible);
  });
});
