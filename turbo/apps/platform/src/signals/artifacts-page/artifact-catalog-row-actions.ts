import { command, computed, state } from "ccstate";
import { createArtifactDeletionSession } from "../artifact-deletion.ts";
import { onRef, resetSignal } from "../utils.ts";

function createArtifactCatalogRowDeletionScope() {
  const activeRow$ = state<{
    readonly artifactId: string;
    readonly trigger: HTMLElement;
  } | null>(null);
  const session$ = computed((get) => {
    const row = get(activeRow$);
    return row
      ? createArtifactDeletionSession(row.artifactId, "catalog-row")
      : null;
  });
  const confirmationActive$ = state(false);
  const resetSessionSignal$ = resetSignal();
  const dismiss$ = command(({ set }) => {
    set(resetSessionSignal$);
    set(confirmationActive$, false);
    set(activeRow$, null);
  });

  return {
    session$,
    detail$: computed(async (get) => {
      const session = get(session$);
      return session ? await get(session.detail$) : null;
    }),
    // Every row may mount this ref; only the opened row owns a session.
    menuTriggerRef$: onRef(
      command(
        ({ get, set }, element: HTMLButtonElement, signal: AbortSignal) => {
          signal.addEventListener(
            "abort",
            () => {
              if (
                get(activeRow$)?.trigger === element &&
                !get(confirmationActive$)
              ) {
                set(dismiss$);
              }
            },
            { once: true },
          );
        },
      ),
    ),
    menuOpenChanged$: command(
      (
        { get, set },
        artifactId: string,
        change: {
          readonly open: boolean;
          readonly trigger: Element | undefined;
          readonly selectingDelete: boolean;
        },
        signal: AbortSignal,
      ) => {
        const { open, trigger, selectingDelete } = change;
        if (!open) {
          // Selection hands this session to the confirmation after the menu exits.
          if (get(activeRow$)?.artifactId === artifactId) {
            if (selectingDelete) {
              set(confirmationActive$, true);
            } else if (!get(confirmationActive$)) {
              set(dismiss$);
            }
          }
          return;
        }
        if (!(trigger instanceof HTMLElement)) {
          return;
        }
        const sessionSignal = set(resetSessionSignal$, signal);
        set(confirmationActive$, false);
        set(activeRow$, { artifactId, trigger });
        const session = get(session$)!;
        set(session.initialize$, sessionSignal);
        sessionSignal.addEventListener(
          "abort",
          () => {
            if (get(session$) === session) {
              set(activeRow$, null);
            }
          },
          { once: true },
        );
      },
    ),
    requestFromMenu$: command(
      async ({ get, set }, artifactId: string, signal: AbortSignal) => {
        const row = get(activeRow$);
        const session = get(session$);
        if (row?.artifactId === artifactId && session) {
          // Confirmation outlives its transient result row and menu trigger.
          set(confirmationActive$, true);
          await set(session.request$, row.trigger, signal);
          signal.throwIfAborted();
          if (get(session$) === session && !get(session.target$)) {
            set(dismiss$);
          }
        }
      },
    ),
    dismiss$,
  };
}

/** One open row menu/confirmation, independent of every preview surface. */
export const artifactCatalogRowDeletionScope =
  createArtifactCatalogRowDeletionScope();
