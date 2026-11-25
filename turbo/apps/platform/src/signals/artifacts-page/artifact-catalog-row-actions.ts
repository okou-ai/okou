import { command, computed, state } from "ccstate";
import type { ArtifactSummary } from "@okouai/api-contracts/contracts/artifact-catalog";
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
      ({ get, set }, artifact: ArtifactSummary, signal: AbortSignal) => {
        const row = get(activeRow$);
        const session = get(session$);
        if (row?.artifactId === artifact.id && session) {
          // The owner-scoped list supplies the confirmation; DELETE checks access.
          set(confirmationActive$, true);
          set(session.requestFromSummary$, artifact, row.trigger, signal);
        }
      },
    ),
    dismiss$,
  };
}

/** One open row menu/confirmation, independent of every preview surface. */
export const artifactCatalogRowDeletionScope =
  createArtifactCatalogRowDeletionScope();
