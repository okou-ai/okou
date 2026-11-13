import { command, computed, state } from "ccstate";
import { boolean, record, string } from "zod";
import { authenticatedIdentity$ } from "../auth.ts";
import { localStorageSignals } from "../external/local-storage.ts";
import { jsonParseOr } from "../utils.ts";

const expansionSchema = record(string(), boolean());
const expansion$ = state<Readonly<Record<string, boolean>>>({});

/**
 * One Project folding or unfolding its chats. A chat list showing it moves its
 * rows from the layout before the fold to the one after, and ends the fold
 * once they rest; `id` tells successive folds apart.
 */
interface ProjectFold {
  readonly id: number;
  readonly projectId: string;
  /** True when the fold unfolds the Project's chats. */
  readonly expanded: boolean;
}
const fold$ = state<ProjectFold | null>(null);
const foldCount$ = state(0);
export const projectFold$ = computed((get) => {
  return get(fold$);
});
/** Ends the given fold; a later fold has already replaced an earlier one. */
export const endProjectFold$ = command(({ get, set }, id: number) => {
  if (get(fold$)?.id === id) {
    set(fold$, null);
  }
});
// The persisted key predates the Project naming; renaming it would discard
// every member's saved expansion state.
const expansionStorage$ = computed(async (get) => {
  const { orgId, userId } = await get(authenticatedIdentity$);
  return localStorageSignals(`project-folder-expansion:${orgId}:${userId}`);
});
const activeExpansionStorage$ = state<ReturnType<
  typeof localStorageSignals
> | null>(null);
export const expandedProjectIds$ = computed((get) => {
  return new Set(
    Object.entries(get(expansion$))
      .filter(([, expanded]) => {
        return expanded;
      })
      .map(([id]) => {
        return id;
      }),
  );
});
export const restoreProjectExpansion$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const storage = await get(expansionStorage$);
    signal.throwIfAborted();
    if (get(activeExpansionStorage$) === storage) {
      return;
    }
    const parsed = expansionSchema.safeParse(
      jsonParseOr<unknown>(get(storage.get$) ?? "{}", null),
    );
    set(expansion$, parsed.success ? parsed.data : {});
    set(fold$, null);
    set(activeExpansionStorage$, storage);
  },
);
const setProjectExpansion$ = command(
  ({ get, set }, next: Readonly<Record<string, boolean>>) => {
    set(expansion$, next);
    const storage = get(activeExpansionStorage$);
    if (storage) {
      set(storage.set$, JSON.stringify(next));
    }
  },
);
// Folding one Project is the change a chat list animates.
const setProjectExpanded$ = command(
  ({ get, set }, id: string, expanded: boolean) => {
    const previous = get(expansion$);
    set(setProjectExpansion$, { ...previous, [id]: expanded });
    if ((previous[id] ?? false) !== expanded) {
      const count = get(foldCount$) + 1;
      set(foldCount$, count);
      set(fold$, { id: count, projectId: id, expanded });
    }
  },
);
export const expandProject$ = command(
  ({ get, set }, id: string, options: { ifUnset?: boolean } = {}) => {
    if (options.ifUnset && get(expansion$)[id] !== undefined) {
      return;
    }
    set(setProjectExpanded$, id, true);
  },
);
export const collapseProject$ = command(({ set }, id: string) => {
  set(setProjectExpanded$, id, false);
});
export const toggleProject$ = command(({ get, set }, id: string) => {
  set(setProjectExpanded$, id, !get(expansion$)[id]);
});
