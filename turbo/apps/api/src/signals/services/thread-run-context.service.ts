import type { FeatureSwitchContext } from "@okouai/core/feature-switch";
import { computed, type Computed } from "ccstate";
import {
  createAgentPhoneLaunchContext,
  type AgentPhoneThreadContext,
} from "./agentphone-queued-launch-context.service";
import {
  createFeishuLaunchContext,
  type FeishuThreadContext,
} from "./feishu-queued-launch-context.service";
import {
  createSlackLaunchContext,
  type SlackThreadContext,
} from "./slack-queued-launch-context.service";
import {
  createTeamsLaunchContext,
  type TeamsThreadContext,
} from "./teams-queued-launch-context.service";
import {
  createTelegramLaunchContext,
  type TelegramThreadContext,
} from "./telegram-queued-launch-context.service";
import type { PickedThreadInputEvent } from "./thread-run-prompt/types";

type PickedThreadInputEventNode = Computed<
  Promise<PickedThreadInputEvent | null>
>;

export function createSlackThreadContext(
  pickedEvent$: PickedThreadInputEventNode,
  orgId: string,
): Computed<Promise<SlackThreadContext>> {
  return computed(async (get) => {
    const pickedEvent = await get(pickedEvent$);
    if (
      !pickedEvent ||
      pickedEvent.contextType !== "slack" ||
      pickedEvent.contextId === null
    ) {
      return null;
    }
    return await get(
      createSlackLaunchContext({
        eventId: pickedEvent.id,
        chatThreadId: pickedEvent.chatThreadId,
        contextId: pickedEvent.contextId,
        orgId,
        userId: pickedEvent.userId,
      }),
    );
  });
}

export function createFeishuThreadContext(
  pickedEvent$: PickedThreadInputEventNode,
  orgId: string,
  featureSwitches$: Computed<Promise<FeatureSwitchContext>>,
): Computed<Promise<FeishuThreadContext>> {
  const source$ = computed(async (get) => {
    const pickedEvent = await get(pickedEvent$);
    if (
      !pickedEvent ||
      pickedEvent.contextType !== "feishu" ||
      pickedEvent.contextId === null
    ) {
      return null;
    }
    return {
      eventId: pickedEvent.id,
      chatThreadId: pickedEvent.chatThreadId,
      contextId: pickedEvent.contextId,
      orgId,
      userId: pickedEvent.userId,
    };
  });
  return createFeishuLaunchContext(source$, featureSwitches$);
}

export function createTeamsThreadContext(
  pickedEvent$: PickedThreadInputEventNode,
  orgId: string,
): Computed<Promise<TeamsThreadContext>> {
  return computed(async (get) => {
    const pickedEvent = await get(pickedEvent$);
    if (
      pickedEvent?.contextType !== "teams" ||
      pickedEvent.contextId === null
    ) {
      return null;
    }
    return await get(
      createTeamsLaunchContext({
        eventId: pickedEvent.id,
        chatThreadId: pickedEvent.chatThreadId,
        contextId: pickedEvent.contextId,
        userId: pickedEvent.userId,
        orgId,
      }),
    );
  });
}

export function createTelegramThreadContext(
  pickedEvent$: PickedThreadInputEventNode,
  orgId: string,
): Computed<Promise<TelegramThreadContext>> {
  return computed(async (get) => {
    const pickedEvent = await get(pickedEvent$);
    if (
      !pickedEvent ||
      pickedEvent.contextType !== "telegram" ||
      pickedEvent.contextId === null
    ) {
      return null;
    }
    return await get(
      createTelegramLaunchContext({
        eventId: pickedEvent.id,
        chatThreadId: pickedEvent.chatThreadId,
        contextId: pickedEvent.contextId,
        orgId,
        userId: pickedEvent.userId,
      }),
    );
  });
}

export function createAgentPhoneThreadContext(
  pickedEvent$: PickedThreadInputEventNode,
  orgId: string,
): Computed<Promise<AgentPhoneThreadContext>> {
  return computed(async (get) => {
    const pickedEvent = await get(pickedEvent$);
    if (
      !pickedEvent ||
      pickedEvent.contextType !== "agentphone" ||
      pickedEvent.contextId === null
    ) {
      return null;
    }
    return await get(
      createAgentPhoneLaunchContext({
        eventId: pickedEvent.id,
        chatThreadId: pickedEvent.chatThreadId,
        contextId: pickedEvent.contextId,
        orgId,
        userId: pickedEvent.userId,
      }),
    );
  });
}
