import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { http, HttpResponse } from "msw";
import { server } from "../../../../mocks/server";
import { registerRequestedCommand } from "../../../../okou";

const HISTORY_URL =
  "http://localhost:3000/api/integrations/agentphone/group-history";

describe("okou imessage group history", () => {
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});

  beforeEach(() => {
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("OKOU_TOKEN", "test-token");
    mockConsoleLog.mockClear();
    server.resetHandlers();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    server.resetHandlers();
  });

  it.each(["imessage", "sms"] as const)(
    "registers %s message sending through the shared CLI command",
    async (integration) => {
      let capturedBody: Record<string, unknown> | undefined;
      server.use(
        http.post(
          "http://localhost:3000/api/integrations/phone/message",
          async ({ request }) => {
            capturedBody = (await request.json()) as Record<string, unknown>;
            return HttpResponse.json({
              ok: true,
              messageId: "apmsg_sent",
              channel: "sms",
              toNumber: "+15551234567",
            });
          },
        ),
      );

      const program = new Command();
      await registerRequestedCommand(program, ["node", "okou", integration]);
      await program.parseAsync([
        "node",
        "okou",
        integration,
        "message",
        "send",
        "--text",
        "hello",
        "--json",
      ]);

      expect(capturedBody).toMatchObject({ text: "hello" });
      expect(
        JSON.parse(mockConsoleLog.mock.calls.flat().join("\\n")),
      ).toMatchObject({
        integration,
        chatId: "+15551234567",
        messages: [{ id: "apmsg_sent", url: null }],
      });
    },
  );

  it("reads a filtered page through the registered iMessage CLI command", async () => {
    let capturedUrl: URL | undefined;

    server.use(
      http.get(HISTORY_URL, ({ request }) => {
        capturedUrl = new URL(request.url);
        expect(request.headers.get("authorization")).toBe("Bearer test-token");
        return HttpResponse.json({
          groupId: "grp_12345",
          messages: [
            {
              id: "apmsg_1",
              conversationId: "apconv_1",
              fromNumber: "+15551234567",
              toNumber: "grp_12345",
              direction: "inbound",
              channel: "imessage",
              body: "Launch plan attached",
              mediaUrl: "https://media.example/plan.pdf",
              receivedAt: "2026-10-01T10:00:00.000Z",
            },
          ],
          hasMore: true,
          nextCursor: "next-page-cursor",
        });
      }),
    );

    const program = new Command();
    await registerRequestedCommand(program, ["node", "okou", "imessage"]);
    await program.parseAsync([
      "node",
      "okou",
      "imessage",
      "group",
      "history",
      "--group",
      "grp_12345",
      "--after",
      "2026-10-01T00:00:00Z",
      "--before",
      "2026-10-02T00:00:00Z",
      "--query",
      "launch plan",
      "--limit",
      "10",
      "--cursor",
      "previous-page-cursor",
    ]);

    expect(capturedUrl?.searchParams.get("groupId")).toBe("grp_12345");
    expect(capturedUrl?.searchParams.get("after")).toBe("2026-10-01T00:00:00Z");
    expect(capturedUrl?.searchParams.get("before")).toBe(
      "2026-10-02T00:00:00Z",
    );
    expect(capturedUrl?.searchParams.get("query")).toBe("launch plan");
    expect(capturedUrl?.searchParams.get("limit")).toBe("10");
    expect(capturedUrl?.searchParams.get("cursor")).toBe(
      "previous-page-cursor",
    );
    expect(mockConsoleLog.mock.calls.flat().join("\n")).toContain(
      "Launch plan attached",
    );
    expect(mockConsoleLog.mock.calls.flat().join("\n")).toContain(
      "Media: https://media.example/plan.pdf",
    );
    expect(mockConsoleLog.mock.calls.flat().join("\n")).toContain(
      "Next cursor: next-page-cursor",
    );
  });
});
