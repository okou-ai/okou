import { command } from "ccstate";
import { eq } from "drizzle-orm";
import { chatThreadMetadataContract } from "@okouai/api-contracts/contracts/chat-threads";
import { modelSettingsSchema } from "@okouai/api-contracts/contracts/model-reasoning-effort";
import { chatThreads } from "@okouai/db/schema/chat-thread";

import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { pathParamsOf } from "../context/request";
import { writeDb$ } from "../external/db";
import { notFound } from "../../lib/error";
import { chatThreadServiceTierFromCodex } from "../services/chat-thread-event.service";
import { withChatThreadContentWrite } from "../services/chat-thread-content-erasure-admission.service";
import type { RouteEntry } from "../route-entry";

const getInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(authContext$);
  const params = get(pathParamsOf(chatThreadMetadataContract.get));
  signal.throwIfAborted();

  const result = await withChatThreadContentWrite(
    set(writeDb$),
    {
      chatThreadId: params.id,
      authorize: (identity) => {
        return identity.userId === auth.userId && identity.agentId !== null;
      },
      threadLock: "update",
    },
    async (tx, identity) => {
      if (identity.agentId === null) {
        return null;
      }
      const [thread] = await tx
        .select({
          id: chatThreads.id,
          title: chatThreads.title,
          selectedModel: chatThreads.selectedModel,
          modelSettings: chatThreads.modelSettings,
          codexServiceTier: chatThreads.codexServiceTier,
          pinnedAt: chatThreads.pinnedAt,
          computerUseHostId: chatThreads.computerUseHostId,
          cloudBrowserEnabled: chatThreads.cloudBrowserEnabled,
          selectedVideoModel: chatThreads.selectedVideoModel,
          selectedImageModel: chatThreads.selectedImageModel,
        })
        .from(chatThreads)
        .where(eq(chatThreads.id, identity.chatThreadId))
        .limit(1);
      if (!thread) {
        return null;
      }
      return {
        id: thread.id,
        agentId: identity.agentId,
        title: thread.title,
        selectedModel: thread.selectedModel,
        modelSettings: modelSettingsSchema.parse(thread.modelSettings),
        serviceTier: chatThreadServiceTierFromCodex(thread.codexServiceTier),
        pinnedAt: thread.pinnedAt?.toISOString() ?? null,
        computerUseHostId: thread.computerUseHostId,
        cloudBrowserEnabled: thread.cloudBrowserEnabled,
        selectedVideoModel: thread.selectedVideoModel,
        selectedImageModel: thread.selectedImageModel,
      };
    },
    signal,
  );
  signal.throwIfAborted();

  if (result.outcome !== "written" || result.value === null) {
    return notFound("Chat thread not found");
  }

  return { status: 200 as const, body: result.value };
});

export const chatThreadGetRoutes: readonly RouteEntry[] = [
  {
    route: chatThreadMetadataContract.get,
    handler: authRoute({ requiredCapability: "chat-thread:read" }, getInner$),
  },
];
