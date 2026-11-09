import { command, computed, state } from "ccstate";

// Archived chats stay in their Project but are hidden from it unless the
// member asks to see them for that Project.
const archivedShown$ = state<ReadonlySet<string>>(new Set());

export const projectsShowingArchived$ = computed((get) => {
  return get(archivedShown$);
});

export const toggleProjectArchived$ = command(({ get, set }, id: string) => {
  const next = new Set(get(archivedShown$));
  if (!next.delete(id)) {
    next.add(id);
  }
  set(archivedShown$, next);
});
