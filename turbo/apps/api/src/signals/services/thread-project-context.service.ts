import { computed, type Computed } from "ccstate";
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
    const { currentProject: current, projectReferences } = picked.preparation;
    const available = new Map(
      projectReferences.map((project) => {
        return [project.id, project] as const;
      }),
    );
    if (current) {
      available.set(current.id, current);
    }
    return {
      current,
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
