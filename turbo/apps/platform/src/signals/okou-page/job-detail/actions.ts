import { command } from "ccstate";
import { detachedNavigateTo$ } from "../../route.ts";
import { deleteAgent$ } from "./delete.ts";

export const deleteAgentAndReturnToList$ = command(
  async ({ set }, signal: AbortSignal) => {
    await set(deleteAgent$, signal);
    // This is the existing terminal navigation boundary. Keep deletion owned by
    // the page; navigation creates its own destination route lifetime.
    set(detachedNavigateTo$, "/agents");
  },
);
