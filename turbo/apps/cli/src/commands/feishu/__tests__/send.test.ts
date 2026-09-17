import chalk from "chalk";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { server } from "../../../mocks/server";
import { createFeishuSendCommand } from "../message/send";

const FEISHU_MESSAGE_URL =
  "http://localhost:3000/api/integrations/feishu/message";

describe.each(["feishu", "lark"] as const)(
  "okou %s message send command",
  (platform) => {
    const sendCommand = createFeishuSendCommand(platform);
    vi.spyOn(process, "exit").mockImplementation((): never => {
      throw new Error("process.exit called");
    });
    const mockConsoleLog = vi
      .spyOn(console, "log")
      .mockImplementation(() => {});
    const mockConsoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    beforeEach(() => {
      chalk.level = 0;
      vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
      vi.stubEnv("OKOU_TOKEN", "test-token");
    });

    it("documents the Feishu targeting modes", () => {
      expect(
        sendCommand.options.find((option) => {
          return option.long === "--chat";
        })?.description,
      ).toContain("chat ID");
      expect(
        sendCommand.options.find((option) => {
          return option.long === "--user";
        })?.description,
      ).toContain('"me"');
      expect(
        sendCommand.options.find((option) => {
          return option.long === "--reply";
        })?.description,
      ).toContain("reply to");
    });

    it("sends text to a chat through a selected installation", async () => {
      let capturedBody: Readonly<Record<string, unknown>> | undefined;
      server.use(
        http.post(
          FEISHU_MESSAGE_URL.replace("/feishu/", `/${platform}/`),
          async ({ request }) => {
            capturedBody = (await request.json()) as Readonly<
              Record<string, unknown>
            >;
            return HttpResponse.json({
              ok: true,
              messageId: "om_sent",
              chatId: "oc_target",
            });
          },
        ),
      );

      await sendCommand.parseAsync([
        "node",
        "cli",
        "--installation",
        "8b82bb60-c85b-4385-875a-d97f34e59b52",
        "--chat",
        "oc_target",
        "--text",
        "Hello Feishu",
      ]);

      expect(capturedBody).toStrictEqual({
        installationId: "8b82bb60-c85b-4385-875a-d97f34e59b52",
        chat: "oc_target",
        text: "Hello Feishu",
      });
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Message sent (message: om_sent)"),
      );
    });

    it("sends an interactive card to the current user", async () => {
      let capturedBody: Readonly<Record<string, unknown>> | undefined;
      server.use(
        http.post(
          FEISHU_MESSAGE_URL.replace("/feishu/", `/${platform}/`),
          async ({ request }) => {
            capturedBody = (await request.json()) as Readonly<
              Record<string, unknown>
            >;
            return HttpResponse.json({
              ok: true,
              messageId: "om_card",
              chatId: "oc_dm",
            });
          },
        ),
      );

      await sendCommand.parseAsync([
        "node",
        "cli",
        "--user",
        "me",
        "--card",
        '{"schema":"2.0","body":{"elements":[]}}',
      ]);

      expect(capturedBody).toStrictEqual({
        user: "me",
        card: {
          schema: "2.0",
          body: { elements: [] },
        },
      });
    });

    it("sends a threaded reply", async () => {
      let capturedBody: Readonly<Record<string, unknown>> | undefined;
      server.use(
        http.post(
          FEISHU_MESSAGE_URL.replace("/feishu/", `/${platform}/`),
          async ({ request }) => {
            capturedBody = (await request.json()) as Readonly<
              Record<string, unknown>
            >;
            return HttpResponse.json({
              ok: true,
              messageId: "om_reply",
              chatId: "oc_thread",
            });
          },
        ),
      );

      await sendCommand.parseAsync([
        "node",
        "cli",
        "--reply",
        "om_parent",
        "--thread",
        "--text",
        "Thread reply",
      ]);

      expect(capturedBody).toStrictEqual({
        replyToMessageId: "om_parent",
        replyInThread: true,
        text: "Thread reply",
      });
    });

    it("rejects ambiguous targets", async () => {
      await expect(
        sendCommand.parseAsync([
          "node",
          "cli",
          "--chat",
          "oc_target",
          "--user",
          "ou_target",
          "--text",
          "Hello",
        ]),
      ).rejects.toThrow("process.exit called");
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining(
          "Exactly one of --chat, --user, or --reply must be provided",
        ),
      );
    });

    it("rejects --thread without --reply", async () => {
      await expect(
        sendCommand.parseAsync([
          "node",
          "cli",
          "--chat",
          "oc_target",
          "--thread",
          "--text",
          "Hello",
        ]),
      ).rejects.toThrow("process.exit called");
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("--thread requires --reply"),
      );
    });

    it("rejects invalid card JSON", async () => {
      await expect(
        sendCommand.parseAsync([
          "node",
          "cli",
          "--chat",
          "oc_target",
          "--card",
          "not-json",
        ]),
      ).rejects.toThrow("process.exit called");
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Invalid JSON for --card flag"),
      );
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining(
          `Provide a valid ${platform === "lark" ? "Lark" : "Feishu"} card JSON object`,
        ),
      );
    });

    it("surfaces API errors", async () => {
      server.use(
        http.post(
          FEISHU_MESSAGE_URL.replace("/feishu/", `/${platform}/`),
          () => {
            return HttpResponse.json(
              {
                error: {
                  code: "BAD_REQUEST",
                  message: "Multiple Feishu installations are available",
                },
              },
              { status: 400 },
            );
          },
        ),
      );

      await expect(
        sendCommand.parseAsync([
          "node",
          "cli",
          "--chat",
          "oc_target",
          "--text",
          "Hello",
        ]),
      ).rejects.toThrow("process.exit called");
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Multiple Feishu installations"),
      );
    });
  },
);
