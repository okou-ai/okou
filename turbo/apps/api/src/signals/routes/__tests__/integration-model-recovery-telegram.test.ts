import { randomInt } from "node:crypto";
import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { array, object, string } from "zod";
import { OFFICIAL_TELEGRAM_BOT_ID } from "@okouai/api-contracts/contracts/integrations-telegram";
import { testContext } from "../../../__tests__/test-context";
import { mockEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { publicChatActor } from "./helpers/public-chat-actor";
import {
  createBddIntegrationApi,
  telegramLoginAuth,
} from "./helpers/api-bdd-integrations";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";
import { createRunReadsApi } from "./helpers/api-bdd-run-reads";

const context = testContext();
const BOT_TOKEN = "123456:recovery-bot";
const WEBHOOK_SECRET = "recovery-webhook";
const keyboardSchema = object({
  reply_markup: object({
    inline_keyboard: array(
      array(object({ text: string(), callback_data: string().optional() })),
    ),
  }),
});

describe("integration model recovery in Telegram", () => {
  it("switches from native message buttons and rejects another sender", async () => {
    const userId = randomInt(1, 2 ** 48);
    const owner = await publicChatActor(context);
    const integrations = createBddIntegrationApi(context);
    const chat = createChatEventsFixture(context);

    mockEnv("TELEGRAM_OFFICIAL_BOT_TOKEN", BOT_TOKEN);
    mockEnv("TELEGRAM_OFFICIAL_BOT_USERNAME", "model_recovery_bot");
    mockEnv("TELEGRAM_OFFICIAL_WEBHOOK_SECRET", WEBHOOK_SECRET);
    const messages: unknown[] = [];
    const notices: string[] = [];
    server.use(
      http.post(
        `https://api.telegram.org/bot${BOT_TOKEN}/sendChatAction`,
        () => {
          return HttpResponse.json({ ok: true, result: true });
        },
      ),
      http.post(
        `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
        async ({ request }) => {
          messages.push(await request.json());
          return HttpResponse.json({
            ok: true,
            result: { message_id: messages.length + 1, chat: { id: userId } },
          });
        },
      ),
      http.get(
        `https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`,
        ({ request }) => {
          notices.push(new URL(request.url).searchParams.get("text") ?? "");
          return HttpResponse.json({ ok: true, result: true });
        },
      ),
    );
    await owner.run(() => {
      return integrations.requestLinkTelegram(
        owner.actor,
        {
          telegramBotId: OFFICIAL_TELEGRAM_BOT_ID,
          telegramAuth: telegramLoginAuth(BOT_TOKEN, {
            id: userId,
            first_name: "Recovery",
          }),
        },
        [200],
      );
    });
    await owner.run(() => {
      return integrations.requestTelegramWebhook(
        OFFICIAL_TELEGRAM_BOT_ID,
        JSON.stringify({
          update_id: 1,
          message: {
            message_id: 1,
            chat: { id: userId, type: "private" },
            from: { id: userId },
            text: "Recover this model",
          },
        }),
        { "x-telegram-bot-api-secret-token": WEBHOOK_SECRET },
        [200],
      );
    });
    await flushWaitUntilForTest();
    const listed = await createRunReadsApi(context).requestListLogs(
      owner.actor,
      { triggerSource: "telegram", limit: 10 },
      [200],
    );
    const run = listed.body.data[0];
    if (!run) {
      throw new Error("Expected a Telegram run");
    }
    await chat.api.heartbeatRunner(owner.runnerGroup);
    const execution = await owner.executionInput(run.id);
    await owner.run(() => {
      return chat.webhooks.requestAgentComplete(
        {
          runId: run.id,
          exitCode: 1,
          error: "Claude verification required",
          failureReason: "account_verification_required",
        },
        { authorization: `Bearer ${execution.sandboxToken}` },
        [200],
      );
    });
    await flushWaitUntilForTest();
    const button = keyboardSchema.parse(messages.at(-1)).reply_markup
      .inline_keyboard[0]?.[0];
    if (!button?.callback_data) {
      throw new Error("Expected the error's native model button");
    }
    expect(button.text).toBe("Switch model");
    function press(data: string, sender = userId) {
      return integrations.requestTelegramWebhook(
        OFFICIAL_TELEGRAM_BOT_ID,
        JSON.stringify({
          callback_query: {
            id: `callback-${messages.length}-${sender}`,
            data,
            from: { id: sender },
            message: { message_id: 2, chat: { id: userId } },
          },
        }),
        { "x-telegram-bot-api-secret-token": WEBHOOK_SECRET },
        [200],
      );
    }
    await press(button.callback_data, userId + 1);
    expect(notices.at(-1)).toContain("no longer current");
    await press(button.callback_data);
    const choices = keyboardSchema
      .parse(messages.at(-1))
      .reply_markup.inline_keyboard.flat();
    const automatic = choices.find((choice) => {
      return choice.text.startsWith("Auto —");
    });
    if (!automatic?.callback_data) {
      throw new Error("Expected Auto in the user's model choices");
    }
    expect(Buffer.byteLength(automatic.callback_data)).toBeLessThanOrEqual(64);
    await press(automatic.callback_data);
    expect(notices.at(-1)).toContain("Switched to Auto");
    const events = await chat.chat.requestThreadEvents(owner.actor, {}, [200]);
    if (events.status !== 200) {
      throw new Error("Expected the conversation events");
    }
    const thread = events.body.events.find((event) => {
      return event.kind === "created";
    });
    if (!thread) {
      throw new Error("Expected the Telegram conversation");
    }
    expect(
      (await chat.chat.readThreadMetadata(owner.actor, thread.chatThreadId))
        .selectedModel,
    ).toBe("auto");
    expect(
      (await integrations.readUserModelPreference(owner.actor)).selectedModel,
    ).toBe("claude-fable-5-1");
    await press(automatic.callback_data);
    expect(notices.at(-1)).toContain("no longer current");
  });
});
