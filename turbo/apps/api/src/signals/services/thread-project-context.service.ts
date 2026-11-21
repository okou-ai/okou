import { computed, type Computed } from "ccstate";
import { and, eq, inArray } from "drizzle-orm";
import { projects } from "@okouai/db/schema/project";
import { db$ } from "../external/db";
import { userMessageReferences } from "./chat-user-message.service";
import type { PickedThreadInputEvent } from "./thread-run-prompt/types";

export interface ThreadProjectContext {
  readonly current: { readonly id: string; readonly name: string } | null;
  readonly references: readonly {
    readonly projectId: string;
    readonly nameSnapshot: string;
    readonly currentName: string | null;
  }[];
}

/** Project authority is observed for the actual picked input, before rendering. */
export function createThreadProjectContext(
  pickedEvent$: Computed<Promise<PickedThreadInputEvent | null>>,
  owner: { readonly userId: string; readonly orgId: string },
): Computed<Promise<ThreadProjectContext | null>> {
  return computed(async (get) => {
    const picked = await get(pickedEvent$);
    if (
      !picked ||
      (picked.contextType !== "web" && picked.contextType !== "agent_run")
    ) {
      return null;
    }
    const refs = picked.userMessage
      ? userMessageReferences(picked.userMessage).projects
      : [];
    const available = new Map(
      picked.preparation.projectReferences?.map((project) => {
        return [project.id, project] as const;
      }),
    );
    const ids = [
      ...new Set([
        ...refs.map((ref) => {
          return ref.projectId.toLowerCase();
        }),
        ...(picked.thread.projectId ? [picked.thread.projectId] : []),
      ]),
    ].filter((id) => {
      return !available.has(id);
    });
    const rows = ids.length
      ? await get(db$)
          .select({ id: projects.id, name: projects.name })
          .from(projects)
          .where(
            and(
              eq(projects.userId, owner.userId),
              eq(projects.orgId, owner.orgId),
              inArray(projects.id, ids),
            ),
          )
      : [];
    for (const row of rows) {
      available.set(row.id, row);
    }
    return {
      current: picked.thread.projectId
        ? (available.get(picked.thread.projectId) ?? null)
        : null,
      references: refs.map((ref) => {
        return {
          projectId: ref.projectId,
          nameSnapshot: ref.nameSnapshot,
          currentName: available.get(ref.projectId.toLowerCase())?.name ?? null,
        };
      }),
    };
  });
}
