import { testChatEventRetentionContract } from "@okouai/api-contracts/contracts/test-chat-event-retention";
import { command, computed, state } from "ccstate";

import { request$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import { retainChatEvents$ } from "../services/cron-retain-chat-events.service";
import {
  createWebChatSessionPromptObjects,
  type WebChatSessionPromptInput,
} from "../services/web-chat-session-prompt.service";
import { recordChatEventRetentionCompleted } from "./cron-retain-chat-events";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-endpoint-helpers";

const retentionBody$ = bodyResultOf(testChatEventRetentionContract.retain);
const sessionPromptBody$ = bodyResultOf(
  testChatEventRetentionContract.sessionPrompt,
);
const internalSessionPromptInput$ = state<
  WebChatSessionPromptInput | undefined
>(undefined);
const sessionPromptInput$ = computed((get) => {
  return Promise.resolve(get(internalSessionPromptInput$));
});
const { prompt$ } = createWebChatSessionPromptObjects(sessionPromptInput$);

const retainChatEventFixturesRoute$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!isTestEndpointAllowed(get(request$))) {
      return testEndpointNotFoundResponse();
    }
    const bodyResult = await get(retentionBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    const result = await set(
      retainChatEvents$,
      {
        kind: "fixtures",
        chatThreadIds: bodyResult.data.chat_thread_ids,
      },
      signal,
    );
    signal.throwIfAborted();
    recordChatEventRetentionCompleted(result);
    return {
      status: 200 as const,
      body: { success: true as const, ...result },
    };
  },
);

const resolveSessionPromptFixturesRoute$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!isTestEndpointAllowed(get(request$))) {
      return testEndpointNotFoundResponse();
    }
    const bodyResult = await get(sessionPromptBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    set(internalSessionPromptInput$, {
      threadId: bodyResult.data.chat_thread_id,
      sessionAction: "rotated",
      context: {
        generationTemplatePrompt: "",
        computerUseHostDisplayName: null,
        triggerSource: "web",
        agentRunSource: null,
        // This fixture resolves the rotated prior-round replay, not the
        // surface note, so it has no feature-switch context to resolve one.
        integrationNote: "",
      },
    });
    const prompt = await get(prompt$);
    signal.throwIfAborted();
    if (prompt === undefined) {
      throw new Error("Session prompt fixture input was not initialized");
    }
    return {
      status: 200 as const,
      body: { prompt },
    };
  },
);

export const testChatEventRetentionRoutes: readonly RouteEntry[] = [
  {
    route: testChatEventRetentionContract.retain,
    handler: retainChatEventFixturesRoute$,
  },
  {
    route: testChatEventRetentionContract.sessionPrompt,
    handler: resolveSessionPromptFixturesRoute$,
  },
];
