import { command, state, type Command } from "ccstate";
import { waitForBrowserPaint } from "../utils.ts";

interface MountedWorkspace {
  readonly root: HTMLDivElement;
  readonly prepareChatList$: Command<object, [number]>;
  readonly cancelChatList$: Command<void, [object]>;
  readonly synchronize$: Command<
    Promise<void>,
    [object | undefined, AbortSignal]
  >;
  readonly signal: AbortSignal;
}

const mountedWorkspace$ = state<MountedWorkspace | null>(null);

/** The workspace mount owns its geometry resources, not a render receipt. */
export const mountWorkspaceLayout$ = command(
  (
    { get, set },
    root: HTMLDivElement,
    chatList: Pick<MountedWorkspace, "prepareChatList$" | "cancelChatList$">,
    synchronize$: Command<Promise<void>, [object | undefined, AbortSignal]>,
    signal: AbortSignal,
  ): void => {
    const workspace = {
      root,
      ...chatList,
      synchronize$,
      signal,
    };
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

const refreshMountedWorkspace$ = command(
  async (
    { get, set },
    chatListTargetWidth: number | undefined,
    signal: AbortSignal,
  ): Promise<void> => {
    signal.throwIfAborted();
    const workspace = get(mountedWorkspace$);
    if (!workspace) {
      return;
    }
    const ownerSignal = AbortSignal.any([signal, workspace.signal]);
    ownerSignal.throwIfAborted();
    const preparation =
      chatListTargetWidth === undefined
        ? undefined
        : set(workspace.prepareChatList$, chatListTargetWidth);
    const cancelPreparation = () => {
      if (
        preparation !== undefined &&
        get(mountedWorkspace$) === workspace &&
        !workspace.signal.aborted
      ) {
        set(workspace.cancelChatList$, preparation);
      }
    };
    ownerSignal.addEventListener("abort", cancelPreparation, { once: true });
    await waitForBrowserPaint(ownerSignal);
    signal.throwIfAborted();
    ownerSignal.throwIfAborted();
    ownerSignal.removeEventListener("abort", cancelPreparation);
    if (get(mountedWorkspace$) !== workspace || !workspace.root.isConnected) {
      return;
    }
    await set(workspace.synchronize$, preparation, ownerSignal);
    signal.throwIfAborted();
  },
);

/** Invoked by the command that changes a mounted workspace's geometry. */
export const refreshWorkspaceLayout$ = command(
  ({ set }, signal: AbortSignal) => {
    return set(refreshMountedWorkspace$, undefined, signal);
  },
);

/** Visibility intent establishes admission before the first paint await. */
export const refreshChatListLayout$ = command(
  ({ set }, targetWidth: number, signal: AbortSignal) => {
    return set(refreshMountedWorkspace$, targetWidth, signal);
  },
);
