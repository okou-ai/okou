import { command, computed, state } from "ccstate";
import { boolean, record, string } from "zod";
import { authenticatedIdentity$ } from "../auth.ts";
import { localStorageSignals } from "../external/local-storage.ts";
import { jsonParseOr } from "../utils.ts";

const expansionSchema = record(string(), boolean());
const expansion$ = state<Readonly<Record<string, boolean>>>({});
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
export const expandProject$ = command(
  ({ get, set }, id: string, options: { ifUnset?: boolean } = {}) => {
    const previous = get(expansion$);
    if (options.ifUnset && previous[id] !== undefined) {
      return;
    }
    set(setProjectExpansion$, { ...previous, [id]: true });
  },
);
export const collapseProject$ = command(({ get, set }, id: string) => {
  set(setProjectExpansion$, { ...get(expansion$), [id]: false });
});
export const toggleProject$ = command(({ get, set }, id: string) => {
  const previous = get(expansion$);
  set(setProjectExpansion$, { ...previous, [id]: !previous[id] });
});
