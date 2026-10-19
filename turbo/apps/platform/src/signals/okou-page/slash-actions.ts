import { command, computed, state } from "ccstate";
import type { UserTemplateKind } from "@okouai/api-contracts/contracts/user-templates";
import {
  currentLeftThread$,
  currentRightThread$,
} from "../chat-page/chat-thread-panes.ts";
import {
  customTemplateCatalog$,
  slashCustomTemplatesEnabled$,
} from "./custom-template-library.ts";

/**
 * Starts choosing messages to share in the open thread the composer belongs
 * to. The sharing flow lives on the thread's panel, which the composer does
 * not hold, so this finds it among the open panes.
 */
export const startComposerThreadSharing$ = command(
  ({ get, set }, threadId: string, signal: AbortSignal) => {
    const thread = [get(currentLeftThread$), get(currentRightThread$)].find(
      (candidate) => {
        return candidate?.threadId === threadId;
      },
    );
    return thread ? set(thread.sharing.start$, signal) : undefined;
  },
);

// The template type the slash-actions Templates list shows. It outlives one
// opening of the menu, so returning to Templates shows the type last chosen.
const slashTemplateTabState$ = state<string | null>(null);

export const slashTemplateTab$ = computed((get) => {
  return get(slashTemplateTabState$);
});

export const setSlashTemplateTab$ = command(({ set }, tab: string) => {
  set(slashTemplateTabState$, tab);
});

/**
 * How many custom templates of each kind the slash menu lists beside the
 * built-in ones. Empty, without reading the catalog, while it lists none.
 */
export const slashCustomTemplateCounts$ = computed(
  async (get): Promise<ReadonlyMap<UserTemplateKind, number>> => {
    const counts = new Map<UserTemplateKind, number>();
    if (!get(slashCustomTemplatesEnabled$)) {
      return counts;
    }
    for (const template of await get(customTemplateCatalog$)) {
      counts.set(template.kind, (counts.get(template.kind) ?? 0) + 1);
    }
    return counts;
  },
);
