import { projectsContract } from "@okouai/api-contracts/contracts/projects";
import { initClient } from "@okouai/api-contracts/contracts/trpc-contract";
import { getClientConfig, handleError } from "../core/client-factory";
import { replayChatThreadEvents } from "@okouai/core/chat-thread-event-replay";

export async function getProject(id: string) {
  const client = initClient(projectsContract, await getClientConfig());
  const r = await client.get({ params: { id } });
  if (r.status === 200) {
    return r.body;
  }
  handleError(r, "Project unavailable");
}
export async function createProject(body: {
  id: string;
  eventId: string;
  name: string;
  fromThreadId?: string;
}) {
  const client = initClient(projectsContract, await getClientConfig());
  const r = await client.create({ body });
  if (r.status === 201) {
    return r.body;
  }
  handleError(r, "Failed to create Project");
}
export async function renameProject(
  id: string,
  body: { eventId: string; name: string },
) {
  const client = initClient(projectsContract, await getClientConfig());
  const r = await client.update({ params: { id }, body });
  if (r.status === 200) {
    return r.body;
  }
  handleError(r, "Failed to rename Project");
}
export async function deleteProject(id: string, eventId: string) {
  const client = initClient(projectsContract, await getClientConfig());
  const r = await client.delete({ params: { id }, body: { eventId } });
  if (r.status === 204) {
    return;
  }
  handleError(r, "Failed to delete Project");
}
export async function moveChatToProject(
  id: string,
  projectId: string | null,
  eventId: string,
) {
  const client = initClient(projectsContract, await getClientConfig());
  const r = await client.membership({
    params: { id },
    body: { projectId, eventId },
  });
  if (r.status === 200) {
    return r.body;
  }
  handleError(r, "Project or chat unavailable");
}

/** Traverse every Project page, including archived/muted history, without the cache's display limit. */
export async function listProjectThreads(id: string) {
  await getProject(id);
  const client = initClient(projectsContract, await getClientConfig());
  const threads = [];
  let after: string | undefined;
  do {
    const r = await client.threads({
      params: { id },
      query: { after, limit: 100, archived: "all" },
    });
    if (r.status !== 200) {
      handleError(r, "Failed to list Project chats");
    }
    threads.push(...r.body.threads);
    const next = r.body.nextAfter;
    if (next !== null && next === after) {
      throw new Error("Project chat cursor did not advance");
    }
    after = next ?? undefined;
  } while (after !== undefined);
  return replayChatThreadEvents(threads, []);
}
