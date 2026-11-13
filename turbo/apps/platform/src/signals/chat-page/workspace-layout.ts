import { command, state, type Command } from "ccstate";
import { waitForBrowserPaint } from "../utils.ts";

interface MountedWorkspace {
  readonly root: HTMLDivElement;
  readonly synchronize$: Command<Promise<void>, [AbortSignal]>;
  readonly signal: AbortSignal;
}

const mountedWorkspace$ = state<MountedWorkspace | null>(null);

/** The workspace mount owns its geometry resources, not a render receipt. */
export const mountWorkspaceLayout$ = command(
  (
    { get, set },
    root: HTMLDivElement,
    synchronize$: Command<Promise<void>, [AbortSignal]>,
    signal: AbortSignal,
  ): void => {
    const workspace = { root, synchronize$, signal };
    set(mountedWorkspace$, workspace);
    signal.addEventListener(
      "abort",
      () => {
        if (get(mountedWorkspace$) === workspace) {
          set(mountedWorkspace$, null);
        }
      },
      { once: true },
    );
  },
);

/** Invoked by the command that changes a mounted workspace's geometry. */
export const refreshWorkspaceLayout$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<void> => {
    signal.throwIfAborted();
    const workspace = get(mountedWorkspace$);
    if (!workspace) {
      return;
    }
    const ownerSignal = AbortSignal.any([signal, workspace.signal]);
    await waitForBrowserPaint(ownerSignal);
    signal.throwIfAborted();
    ownerSignal.throwIfAborted();
    if (get(mountedWorkspace$) !== workspace || !workspace.root.isConnected) {
      return;
    }
    await set(workspace.synchronize$, ownerSignal);
    signal.throwIfAborted();
  },
);
