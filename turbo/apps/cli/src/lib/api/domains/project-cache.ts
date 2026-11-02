import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  projectsContract,
  projectEventQueryResultSchema,
  projectSnapshotArchiveSchema,
} from "@okouai/api-contracts/contracts/projects";
import { initClient } from "@okouai/api-contracts/contracts/trpc-contract";
import { replayProjectEvents } from "@okouai/core/project-event-replay";
import { getClientConfig, handleError } from "../core/client-factory";
import { decodeSandboxTokenPayload, getApiUrl } from "../config";

async function loadProjectCache(path: string) {
  let state = projectEventQueryResultSchema.parse({
    snapshot: null,
    events: [],
  });
  try {
    const raw: unknown = JSON.parse(await readFile(path, "utf8"));
    state = projectEventQueryResultSchema.parse(raw);
  } catch (error) {
    if (!(
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    )) {
      throw error;
    }
  }
  return state;
}

/** Owner-scoped metadata only; signed download URLs are never persisted. */
export async function readCachedProjects() {
  const token = decodeSandboxTokenPayload();
  if (!token) {
    throw new Error("OKOU_TOKEN does not contain a Project cache scope");
  }
  const scope = createHash("sha256")
    .update(`${await getApiUrl()}\0${token.orgId}\0${token.userId}`)
    .digest("hex");
  const path = join(
    process.env.XDG_CACHE_HOME?.trim() || join(homedir(), ".cache"),
    "okou",
    "projects",
    `${scope}.json`,
  );
  let state = projectEventQueryResultSchema.parse({
    snapshot: null,
    events: [],
  });
  state = await loadProjectCache(path);
  const client = initClient(projectsContract, await getClientConfig());
  let refreshed = false;
  for (;;) {
    if (state.snapshot === null) {
      const r = await client.snapshot();
      if (r.status !== 200) {
        handleError(r, "Failed to load Projects");
      }
      let snapshot: unknown = r.body;
      if ("url" in r.body) {
        const response = await fetch(r.body.url);
        if (!response.ok) {
          throw new Error(
            `Project snapshot download failed (${response.status})`,
          );
        }
        snapshot = await response.json();
      }
      state = {
        snapshot: projectSnapshotArchiveSchema.parse(snapshot),
        events: [],
      };
      refreshed = true;
    }
    const since = state.events.at(-1)?.seqId ?? state.snapshot!.latestSeqId;
    const page = await client.events({ query: { sinceSeqId: since } });
    if (page.status === 410) {
      if (refreshed) {
        throw new Error("Project cursor expired immediately after snapshot");
      }
      state = { snapshot: null, events: [] };
      continue;
    }
    if (page.status !== 200) {
      handleError(page, "Failed to synchronize Projects");
    }
    const events = page.body.events.filter((event) => {
      return event.seqId > since;
    });
    if (page.body.hasMore && events.length === 0) {
      throw new Error("Project event cursor did not advance");
    }
    state = { snapshot: state.snapshot, events: [...state.events, ...events] };
    if (!page.body.hasMore) {
      break;
    }
  }
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
  await rename(temporary, path);
  return replayProjectEvents(state.snapshot?.projects ?? [], state.events);
}
