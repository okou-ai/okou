import { createHash } from "node:crypto";
import { escapeHtml } from "../../lib/telegram-format";
import { command } from "ccstate";
import { number, object, string } from "zod";
import {
  answerTelegramCallbackQuery,
  sendMessage,
} from "../external/telegram-client";
import { integrationModelRecoveryIdentity$ } from "./integration-model-recovery-access.service";
import {
  loadIntegrationModelChoices$,
  MODEL_RECOVERY_STALE,
  saveIntegrationModelChoice$,
} from "./integration-model-recovery.service";

const callbackSchema = object({
  callback_query: object({
    id: string(),
    data: string(),
    from: object({ id: number().int() }),
    message: object({
      message_id: number().int(),
      message_thread_id: number().int().optional(),
      chat: object({ id: number().int() }),
    }),
  }),
});

function modelKey(model: string): string {
  return createHash("sha256").update(model).digest("hex").slice(0, 12);
}

/** The owning official-bot webhook has verified its secret header. */
export const handleTelegramModelRecovery$ = command(
  async (
    { set },
    body: unknown,
    botToken: string,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const parsed = callbackSchema.safeParse(body);
    if (
      !parsed.success ||
      !/^(?:mr|ms):/u.test(parsed.data.callback_query.data)
    ) {
      return false;
    }
    const query = parsed.data.callback_query;
    const [action, eventId, key] = query.data.split(":");
    const identity = eventId
      ? await set(
          integrationModelRecoveryIdentity$,
          {
            channel: "telegram",
            eventId,
            platformUserId: String(query.from.id),
            conversationId: String(query.message.chat.id),
          },
          signal,
        )
      : null;
    const recovery = identity
      ? await set(loadIntegrationModelChoices$, identity, signal)
      : null;
    if (!identity || !recovery) {
      await answerTelegramCallbackQuery(
        botToken,
        query.id,
        MODEL_RECOVERY_STALE,
        signal,
      );
      return true;
    }
    if (action === "ms") {
      const model = recovery.choices.find((choice) => {
        return modelKey(choice.value) === key;
      });
      const text = model
        ? await set(
            saveIntegrationModelChoice$,
            { ...identity, model: model.value, expectedModelState: recovery },
            signal,
          )
        : MODEL_RECOVERY_STALE;
      await answerTelegramCallbackQuery(botToken, query.id, text, signal);
      return true;
    }
    await answerTelegramCallbackQuery(botToken, query.id, undefined, signal);
    const result = await sendMessage(
      botToken,
      String(query.message.chat.id),
      `Current model: ${escapeHtml(recovery.currentModelLabel)}. Select a model for this conversation, then send your previous request again.`,
      {
        replyToMessageId: query.message.message_id,
        messageThreadId: query.message.message_thread_id,
        replyMarkup: {
          inline_keyboard: [
            ...recovery.choices.map((choice) => {
              return [
                {
                  text: `${choice.label} — ${choice.description}`,
                  callback_data: `ms:${recovery.eventId}:${modelKey(choice.value)}`,
                },
              ];
            }),
            [{ text: "Open conversation in Okou", url: recovery.url }],
          ],
        },
      },
    );
    signal.throwIfAborted();
    if (result.kind === "telegram-error") {
      throw new Error(`Telegram model selector failed: ${result.description}`);
    }
    return true;
  },
);
