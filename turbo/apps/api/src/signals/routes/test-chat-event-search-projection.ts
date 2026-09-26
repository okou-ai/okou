import { testChatEventSearchProjectionContract } from "@okouai/api-contracts/contracts/test-chat-event-search-projection";
import { command } from "ccstate";

import { request$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import { projectChatEventSearchTestScope$ } from "../services/cron-project-chat-event-search.service";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-endpoint-helpers";

const projectBody$ = bodyResultOf(
  testChatEventSearchProjectionContract.project,
);

const projectChatEventSearchTestRoute$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!isTestEndpointAllowed(get(request$))) {
      return testEndpointNotFoundResponse();
    }
    const bodyResult = await get(projectBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    const result = await set(
      projectChatEventSearchTestScope$,
      { chatThreadIds: bodyResult.data.chat_thread_ids },
      signal,
    );
    signal.throwIfAborted();
    return {
      status: 200 as const,
      body: { success: true as const, ...result },
    };
  },
);

export const testChatEventSearchProjectionRoutes: readonly RouteEntry[] = [
  {
    route: testChatEventSearchProjectionContract.project,
    handler: projectChatEventSearchTestRoute$,
  },
];
