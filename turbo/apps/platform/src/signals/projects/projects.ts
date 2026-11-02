import { createProjectOperationId } from "@okouai/core/project-operation-id";
import { expandProject$ } from "./project-folders.ts";
import { now } from "../../lib/time.ts";
import { command, computed, state } from "ccstate";
import { projectsContract } from "@okouai/api-contracts/client/projects";
import { chatThreadsContract } from "@okouai/api-contracts/client/chat-threads";
import type { projectEventQueryResultSchema } from "@okouai/api-contracts/validators/projects";
import { replayProjectEvents } from "@okouai/core/project-event-replay";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import type { infer as zInfer } from "zod";
import { installedSharedDatabaseBridge$ } from "../shared-database-bridge-state.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { apiClient$ } from "../api-client.ts";
import { accept } from "../../lib/accept.ts";
import { detachedNavigateTo$, searchParams$, pathParams$ } from "../route.ts";
import { currentChatAgentRecordId$ } from "../agent-chat.ts";
import {
  catchUpChatThreadEventSource$,
  eventDrivenChatThreads$,
} from "../chat-page/chat-thread-event-sourcing.ts";

export const projectsEnabled$ = computed((get) => {
  return get(featureSwitch$)[FeatureSwitchKey.Projects] ?? false;
});
const state$ = state<zInfer<typeof projectEventQueryResultSchema>>({
  snapshot: null,
  events: [],
});
export const projects$ = computed((get) => {
  const value = get(state$);
  return get(projectsEnabled$)
    ? replayProjectEvents(value.snapshot?.projects ?? [], value.events)
    : [];
});
export const syncProjects$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!get(projectsEnabled$)) {
      set(state$, { snapshot: null, events: [] });
      return;
    }
    const result = await get(installedSharedDatabaseBridge$).query(
      {
        dataKey: { kind: "project-event" },
        afterSeqId: null,
        consistency: "catch-up",
      },
      signal,
    );
    signal.throwIfAborted();
    set(state$, result);
  },
);
export const hydrateProjects$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(state$, { snapshot: null, events: [] });
    if (!get(projectsEnabled$)) {
      return;
    }
    set(
      state$,
      await get(installedSharedDatabaseBridge$).query(
        {
          dataKey: { kind: "project-event" },
          afterSeqId: null,
          consistency: "cache-only",
        },
        signal,
      ),
    );
    await set(syncProjects$, signal);
    const threadId = get(pathParams$)?.threadId;
    const projectId =
      typeof threadId === "string"
        ? get(eventDrivenChatThreads$).find((thread) => {
            return thread.id === threadId;
          })?.projectId
        : get(searchParams$).get("project");
    if (projectId) {
      set(expandProject$, projectId);
    }
  },
);
function operation() {
  return createProjectOperationId(now(), crypto.randomUUID());
}
export const createProject$ = command(
  async (
    { get, set },
    name: string,
    fromThreadId: string | undefined,
    signal: AbortSignal,
  ) => {
    const eventId = operation();
    const result = await accept(
      get(apiClient$)(projectsContract).create({
        body: { id: eventId, eventId, name, fromThreadId },
        fetchOptions: { signal },
      }),
      [201],
      signal,
    );
    await set(syncProjects$, signal);
    await set(catchUpChatThreadEventSource$, signal);
    set(expandProject$, result.body.id);
    return result.body;
  },
);
export const renameProject$ = command(
  async ({ get, set }, id: string, name: string, signal: AbortSignal) => {
    await accept(
      get(apiClient$)(projectsContract).update({
        params: { id },
        body: { name, eventId: operation() },
        fetchOptions: { signal },
      }),
      [200],
      signal,
    );
    await set(syncProjects$, signal);
  },
);
export const deleteProject$ = command(
  async ({ get, set }, id: string, signal: AbortSignal) => {
    await accept(
      get(apiClient$)(projectsContract).delete({
        params: { id },
        body: { eventId: operation() },
        fetchOptions: { signal },
      }),
      [204],
      signal,
    );
    await set(syncProjects$, signal);
    await set(catchUpChatThreadEventSource$, signal);
  },
);
export const moveProjectThread$ = command(
  async (
    { get, set },
    threadId: string,
    projectId: string | null,
    signal: AbortSignal,
  ) => {
    await accept(
      get(apiClient$)(projectsContract).membership({
        params: { id: threadId },
        body: { projectId, eventId: operation() },
        fetchOptions: { signal },
      }),
      [200],
      signal,
    );
    await set(catchUpChatThreadEventSource$, signal);
    if (projectId) {
      set(expandProject$, projectId);
    }
  },
);
export const newProjectThread$ = command(
  async ({ get, set }, projectId: string, signal: AbortSignal) => {
    const agentId =
      get(searchParams$).get("projectAgent") ??
      (await get(currentChatAgentRecordId$));
    if (!agentId) {
      throw new Error("Select an Agent before starting a conversation");
    }
    const response = await accept(
      get(apiClient$)(chatThreadsContract).create({
        body: {
          agentId,
          projectId,
          clientThreadId: crypto.randomUUID(),
          eventId: operation(),
        },
        fetchOptions: { signal },
      }),
      [201],
      signal,
    );
    await set(catchUpChatThreadEventSource$, signal);
    set(expandProject$, projectId);
    set(detachedNavigateTo$, "/chats/:threadId", {
      pathParams: { threadId: response.body.id },
      searchParams: new URLSearchParams({
        project: projectId,
        projectAgent: agentId,
      }),
    });
  },
);
