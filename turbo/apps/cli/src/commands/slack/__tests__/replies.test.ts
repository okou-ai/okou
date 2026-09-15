import { beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { slackMessageCommand } from "../message";
import { repliesCommand } from "../message/replies";

const repliesUrl = "http://localhost:3000/api/integrations/slack/replies";
const channelUrl = "https://slack.com/app_redirect?team=T123&channel=C123";
const thread = "1750000000.000001";

describe("okou slack message replies", () => {
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation(() => {
    throw new Error("process.exit");
  });

  beforeEach(() => {
    vi.stubEnv("OKOU_TOKEN", "test-token");
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    for (const option of [
      "channel",
      "thread",
      "cursor",
      "oldest",
      "latest",
      "json",
    ]) {
      repliesCommand.setOptionValue(option, undefined);
    }
    repliesCommand.setOptionValue("limit", "15");
  });

  it("routes the message subcommand and preserves raw reply metadata and pagination", async () => {
    const message = {
      type: "message",
      ts: "1750000001.000001",
      text: "Project update",
      user: "U123",
      thread_ts: thread,
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: "Project update" } },
      ],
      files: [{ id: "F123", name: "report.pdf" }],
    };
    let query: URLSearchParams | undefined;
    server.use(
      http.get(repliesUrl, ({ request }) => {
        query = new URL(request.url).searchParams;
        return HttpResponse.json({
          channel: "D123",
          channelUrl,
          thread,
          messages: [message],
          hasMore: true,
          nextCursor: "next+page=",
        });
      }),
    );
    await slackMessageCommand.parseAsync([
      "node",
      "okou",
      "replies",
      "--channel",
      "D123",
      "--thread",
      thread,
      "--oldest",
      "1750000000",
      "--latest",
      "1750100000",
      "--limit",
      "25",
      "--cursor",
      "previous+page=",
      "--json",
    ]);
    expect(Object.fromEntries(query ?? [])).toStrictEqual({
      channel: "D123",
      thread,
      oldest: "1750000000",
      latest: "1750100000",
      limit: "25",
      cursor: "previous+page=",
    });
    expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toStrictEqual({
      channel: "D123",
      channelUrl,
      thread,
      messages: [message],
      hasMore: true,
      nextCursor: "next+page=",
    });
  });

  it("labels the parent and prints a continuation without claiming a complete thread", async () => {
    server.use(
      http.get(repliesUrl, () => {
        return HttpResponse.json({
          channel: "C123",
          channelUrl,
          thread,
          messages: [
            {
              type: "message",
              ts: thread,
              text: "Project update",
              user: "U123",
            },
            { type: "message", ts: "1750000001.000001", bot_id: "B123" },
          ],
          hasMore: true,
          nextCursor: "next-page",
        });
      }),
    );
    await repliesCommand.parseAsync([
      "node",
      "okou",
      "--channel",
      "C123",
      "--thread",
      thread,
    ]);
    const text = output.mock.calls.flat().join("\n");
    expect(text).toContain("one page");
    expect(text).toContain("U123 [parent]");
    expect(text).toContain("use --json to inspect its content");
    expect(text).toContain("Next cursor: next-page");
    expect(text).toContain("same channel, thread and time filters");
  });

  it("discloses an incomplete empty page even when Slack supplies no cursor", async () => {
    server.use(
      http.get(repliesUrl, () => {
        return HttpResponse.json({
          channel: "C123",
          channelUrl,
          thread,
          messages: [],
          hasMore: true,
          nextCursor: null,
        });
      }),
    );
    await repliesCommand.parseAsync([
      "node",
      "okou",
      "--channel",
      "C123",
      "--thread",
      thread,
    ]);
    const text = output.mock.calls.flat().join("\n");
    expect(text).toContain("No messages on this page");
    expect(text).toContain("this page is incomplete");
  });

  it.each([
    [["--thread", "not-a-timestamp"], "thread"],
    [["--thread", "1750000000.1234567"], "thread"],
    [["--channel", "U123"], "channel"],
    [["--limit", "0"], "limit"],
    [["--limit", "201"], "limit"],
    [["--limit", "1.5"], "limit"],
    [["--cursor", ""], "cursor"],
    [
      ["--oldest", "20", "--latest", "10"],
      "oldest must be earlier than latest",
    ],
  ])(
    "rejects invalid arguments %j before requesting a page",
    async (args, message) => {
      await expect(
        repliesCommand.parseAsync([
          "node",
          "okou",
          "--channel",
          "C123",
          "--thread",
          thread,
          ...args,
        ]),
      ).rejects.toThrow("process.exit");
      expect(errors.mock.calls.flat().join("\n")).toContain(message);
      expect(output).not.toHaveBeenCalled();
    },
  );

  it("requires a parent timestamp", async () => {
    repliesCommand.exitOverride();
    await expect(
      repliesCommand.parseAsync(["node", "okou", "--channel", "C123"]),
    ).rejects.toThrow("required option '--thread <ts>' not specified");
    expect(output).not.toHaveBeenCalled();
  });

  it.each([
    [
      404,
      "SLACK_THREAD_NOT_FOUND",
      "Check --channel and use the parent message's ts for --thread.",
    ],
    [
      403,
      "SLACK_MISSING_SCOPE",
      "The organization's Slack bot lacks a required OAuth scope.",
    ],
    [
      429,
      "SLACK_RATE_LIMITED",
      "Slack rate limit reached. Retry after 60 seconds.",
    ],
    [404, "NOT_FOUND", "Not Found"],
  ])(
    "reports API error %s %s without silently reading history instead",
    async (status, code, message) => {
      let requests = 0;
      server.use(
        http.get(repliesUrl, () => {
          requests++;
          return HttpResponse.json({ error: { code, message } }, { status });
        }),
      );
      await expect(
        repliesCommand.parseAsync([
          "node",
          "okou",
          "--channel",
          "C123",
          "--thread",
          thread,
        ]),
      ).rejects.toThrow("process.exit");
      expect(errors.mock.calls.flat().join("\n")).toContain(message);
      expect(output).not.toHaveBeenCalled();
      expect(requests).toBe(1);
    },
  );
});
