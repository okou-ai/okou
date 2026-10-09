import { command, computed, state, type Command, type Computed } from "ccstate";
import {
  renameDialogSession$,
  type RenameDialogSession,
} from "../okou-page/sidebar-state.ts";

export interface ChatThreadRenameMenuSignals {
  readonly open$: Computed<boolean>;
  readonly finalFocus$: Computed<false | undefined>;
  readonly setOpen$: Command<void, [boolean]>;
}

export function createChatThreadRenameMenuSignals(): ChatThreadRenameMenuSignals {
  const internalMenu$ = state<{
    readonly open: boolean;
    readonly session: RenameDialogSession | null;
  }>({ open: false, session: null });

  return {
    open$: computed((get) => {
      const menu = get(internalMenu$);
      return menu.open && menu.session === get(renameDialogSession$);
    }),
    // Keep the handoff through teardown, even if Rename closes before the menu.
    finalFocus$: computed((get) => {
      return get(internalMenu$).session === get(renameDialogSession$)
        ? undefined
        : false;
    }),
    setOpen$: command(({ get, set }, open: boolean) => {
      set(internalMenu$, {
        open,
        session: open ? get(renameDialogSession$) : get(internalMenu$).session,
      });
    }),
  };
}
