import { waitUntil } from "../context/wait-until";
import {
  publishChatThreadMessageCreated$,
  projectCommittedChatThreadSearch$,
} from "./chat-event-publication.service";
import { command } from "ccstate";
import { eq } from "drizzle-orm";
import { chatFeishuContext } from "@okouai/db/schema/chat-feishu-context";
import { writeDb$ } from "../external/db";
import { getOfficialTelegramBotConfig } from "../external/telegram-official";
import { sendChatAction } from "../external/telegram-client";
import { publishThreadListChangedSafely } from "../external/realtime";
import { logger } from "../../lib/log";
import { settle } from "../utils";
import { loadUserFeatureSwitchContext$ } from "./feature-switches.service";
import { reconcileCanonicalSlackThreadStatus$ } from "./canonical-slack-thread-status.service";
import { loadSlackQueuedLaunchMaterial$ } from "./slack-queued-launch-context.service";
import { createTeamsQueuedDelivery } from "./teams-queued-launch-context.service";
import { sendTeamsRunStartIndicator } from "./teams-thinking-indicator.service";
import { loadTelegramQueuedLaunchMaterial$ } from "./telegram-queued-launch-context.service";
import { loadAgentPhoneQueuedLaunchMaterial$ } from "./agentphone-queued-launch-context.service";
import { loadWechatQueuedLaunchMaterial$ } from "./wechat-context.service";
import { reconcileWechatThreadTyping$ } from "./wechat-thread-typing.service";
import { sendAgentPhoneRunTyping } from "./agentphone-run-typing.service";
import { createFeishuRecoveryContext } from "./feishu-queued-launch-context.service";
import { addFeishuThinkingReaction$ } from "./feishu-thinking-indicator.service";
import {
  pickEnqueuedChatThread$,
  notifyRunningChatRunOfPendingInput$,
} from "./chat-thread-queue-drain.service";
import { touchNativeChatThread$ } from "./native-chat-event-write.service";
import type { IntegrationRecoveryInput } from "./integration-recovery-input.service";

const L = logger("IntegrationRecoveryContinuation");

const showRecoveryIndicator$ = command(
  async (
    { get, set },
    input: IntegrationRecoveryInput,
    signal: AbortSignal,
  ): Promise<void> => {
    if (input.contextType === "teams") {
      signal.throwIfAborted();
      const activity = await get(createTeamsQueuedDelivery(input));
      signal.throwIfAborted();
      if (activity) {
        await sendTeamsRunStartIndicator({ activity }, signal);
      }
      return;
    }
    const featureSwitchContext = await set(
      loadUserFeatureSwitchContext$,
      input.orgId,
      input.userId,
      signal,
    );
    const source = { ...input, featureSwitchContext };
    switch (input.contextType) {
      case "slack": {
        const material = await set(loadSlackQueuedLaunchMaterial$, source);
        signal.throwIfAborted();
        if (material) {
          await set(
            reconcileCanonicalSlackThreadStatus$,
            { ...material.slackDelivery, chatThreadId: input.chatThreadId },
            signal,
          );
        }
        break;
      }
      case "feishu": {
        const context = await get(createFeishuRecoveryContext(input));
        signal.throwIfAborted();
        if (context) {
          const reactionId = await set(
            addFeishuThinkingReaction$,
            context,
            signal,
          );
          if (reactionId) {
            await set(writeDb$)
              .update(chatFeishuContext)
              .set({ reactionId })
              .where(eq(chatFeishuContext.id, input.eventId));
            signal.throwIfAborted();
          }
        }
        break;
      }
      case "telegram": {
        const material = await set(loadTelegramQueuedLaunchMaterial$, source);
        signal.throwIfAborted();
        const botToken = getOfficialTelegramBotConfig().botToken;
        if (material && botToken) {
          await sendChatAction(
            botToken,
            material.telegramDelivery.chatId,
            "typing",
          );
          signal.throwIfAborted();
        }
        break;
      }
      case "agentphone": {
        const material = await set(loadAgentPhoneQueuedLaunchMaterial$, source);
        signal.throwIfAborted();
        const target = material?.agentphoneDelivery;
        if (
          target?.conversationId &&
          (target.channel === "imessage" || target.channel === "whatsapp")
        ) {
          await sendAgentPhoneRunTyping(
            { conversationId: target.conversationId, phase: "admission" },
            signal,
          );
        }
        break;
      }
      case "wechat": {
        const material = await set(
          loadWechatQueuedLaunchMaterial$,
          source,
          signal,
        );
        if (material) {
          await set(
            reconcileWechatThreadTyping$,
            {
              chatThreadId: input.chatThreadId,
              target: material.wechatDelivery,
            },
            signal,
          );
        }
        break;
      }
      // Discord starts its existing typing lifecycle at Run launch.
      // Email and SMS/MMS do not have an ingress typing indicator.
    }
  },
);

/** The normal queue owns admission, native session continuity and source delivery. */
export const continueIntegrationRecovery$ = command(
  async (
    { set },
    input: IntegrationRecoveryInput,
    signal: AbortSignal,
  ): Promise<void> => {
    const indicator = await settle(
      set(showRecoveryIndicator$, input, signal),
      signal,
    );
    if (!indicator.ok) {
      L.warn("Could not show recovery indicator", {
        eventId: input.eventId,
        error: indicator.error,
      });
    }
    await set(
      touchNativeChatThread$,
      { ...input, authorizedScope: input },
      signal,
    );
    waitUntil(
      set(
        projectCommittedChatThreadSearch$,
        {
          userId: input.userId,
          orgId: input.orgId,
          threadId: input.chatThreadId,
        },
        signal,
      ),
    );
    await set(
      publishChatThreadMessageCreated$,
      {
        userId: input.userId,
        orgId: input.orgId,
        threadId: input.chatThreadId,
      },
      signal,
    );
    signal.throwIfAborted();
    await publishThreadListChangedSafely({
      userId: input.userId,
      orgId: input.orgId,
    });
    signal.throwIfAborted();
    await set(pickEnqueuedChatThread$, input, signal);
    await set(notifyRunningChatRunOfPendingInput$, input.chatThreadId, signal);
  },
);
