import { command, computed, state } from "ccstate";

const expanded$ = state<ReadonlySet<string>>(new Set());
const archived$ = state<ReadonlySet<string>>(new Set());
const limits$ = state<Readonly<Record<string, number>>>({});
export const expandedProjectIds$ = computed((get) => {
  return get(expanded$);
});
export const archivedProjectIds$ = computed((get) => {
  return get(archived$);
});
export const projectThreadLimits$ = computed((get) => {
  return get(limits$);
});
export const expandProject$ = command(({ get, set }, id: string) => {
  set(expanded$, new Set([...get(expanded$), id]));
});
export const toggleProject$ = command(({ get, set }, id: string) => {
  const next = new Set(get(expanded$));
  if (!next.delete(id)) {
    next.add(id);
  }
  set(expanded$, next);
});
export const toggleProjectArchive$ = command(({ get, set }, id: string) => {
  const next = new Set(get(archived$));
  if (!next.delete(id)) {
    next.add(id);
  }
  set(archived$, next);
  set(expandProject$, id);
});
export const showMoreProjectThreads$ = command(({ get, set }, id: string) => {
  set(limits$, { ...get(limits$), [id]: (get(limits$)[id] ?? 20) + 20 });
});
