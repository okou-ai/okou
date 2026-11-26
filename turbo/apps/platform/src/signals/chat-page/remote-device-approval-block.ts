import { remoteDevicesContract } from "@okouai/api-contracts/client/remote-devices";
import { remoteDeviceApprovalSchema } from "@okouai/api-contracts/validators/remote-device-approval";
import { command, computed, state } from "ccstate";
import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import {
  hash$,
  historyState$,
  pathname$,
  replaceSearchParams$,
  searchParams$,
} from "../route.ts";
import { onRef } from "../utils.ts";
import {
  invalidateRemoteDeviceDirectory$,
  remoteDeviceDirectory$,
} from "../remote-devices.ts";
import {
  chatActionCallbackFromUrl,
  runChatActionCallback$,
} from "./action-callback.ts";
import {
  chatActionIdMatches,
  type ChatActionContext,
  type ChatActionParseResult,
} from "./chat-action-context.ts";
import { createCardSignalsRegistry } from "./card-signal-map.ts";
import { currentLeftThread$ } from "./chat-thread-pane-state.ts";
import { parseTrustedPlatformUrl } from "./trusted-platform-url.ts";

export interface RemoteDeviceApprovalDescriptor {
  readonly originalUrl: string;
  readonly deviceId: string;
  readonly actionId: string;
  readonly reason: string;
  readonly threadId: string;
  readonly callbackPrompt: string | null;
}

export function parseRemoteDeviceApprovalUrl(
  value: string,
  context: ChatActionContext | undefined,
): ChatActionParseResult<RemoteDeviceApprovalDescriptor> {
  const url = parseTrustedPlatformUrl(value);
  const threadId = url?.pathname.match(/^\/chats\/([^/]+)$/u)?.[1];
  if (!url || !threadId || !url.searchParams.has("remoteDeviceApproval")) {
    return { status: "unrelated" };
  }
  const parsed = remoteDeviceApprovalSchema.safeParse({
    deviceId: url.searchParams.get("remoteDeviceApproval")?.toLowerCase(),
    actionId: url.searchParams.get("actionId")?.toLowerCase(),
    reason: url.searchParams.get("reason"),
  });
  const callback = context ? chatActionCallbackFromUrl(url, context) : null;
  if (
    !context ||
    !chatActionIdMatches(threadId, context.threadId) ||
    !parsed.success ||
    !callback
  ) {
    return { status: "invalid", originalUrl: value };
  }
  return {
    status: "valid",
    descriptor: {
      ...parsed.data,
      originalUrl: value,
      threadId: context.threadId,
      callbackPrompt: callback.callbackPrompt,
    },
  };
}

function createRemoteDeviceApprovalSignals(
  action: RemoteDeviceApprovalDescriptor,
) {
  const outcome$ = state<"requested" | "cancelled" | "allowed" | "continued">(
    "requested",
  );
  const device$ = computed(async (get) => {
    return (await get(remoteDeviceDirectory$)).find(({ id }) => {
      return id === action.deviceId;
    });
  });
  const cancel$ = command(({ get, set }) => {
    if (get(outcome$) === "requested") {
      set(outcome$, "cancelled");
    }
  });
  const confirm$ = command(async ({ get, set }, signal: AbortSignal) => {
    if (get(outcome$) === "requested") {
      await accept(
        get(apiClient$)(remoteDevicesContract).approve({
          params: { threadId: action.threadId },
          body: { deviceId: action.deviceId },
          fetchOptions: { signal },
        }),
        [200],
        signal,
      );
      set(outcome$, "allowed");
      set(invalidateRemoteDeviceDirectory$);
    }
    if (get(outcome$) === "allowed" && action.callbackPrompt) {
      await set(
        runChatActionCallback$,
        {
          threadId: action.threadId,
          callbackPrompt: action.callbackPrompt,
          callbackIds: {
            clientEventId: action.actionId,
            chatThreadSortEventId: action.actionId,
          },
        },
        signal,
      );
      set(outcome$, "continued");
    }
  });
  return { action, device$, outcome$, cancel$, confirm$ };
}

export type RemoteDeviceApprovalSignals = ReturnType<
  typeof createRemoteDeviceApprovalSignals
>;

export function createRemoteDeviceApprovalRegistry() {
  return createCardSignalsRegistry((action: RemoteDeviceApprovalDescriptor) => {
    return action.originalUrl;
  }, createRemoteDeviceApprovalSignals);
}

export const remoteDeviceApprovalLink$ = computed((get) => {
  const threadId = get(currentLeftThread$)?.threadId;
  const params = get(searchParams$);
  if (!threadId || !params.has("remoteDeviceApproval")) {
    return null;
  }
  const link = `${get(pathname$)}?${params.toString()}`;
  const result = parseRemoteDeviceApprovalUrl(link, { threadId });
  return result.status === "valid" ? result.descriptor : null;
});

const linkSignals$ = state<RemoteDeviceApprovalSignals | null>(null);
export const remoteDeviceApprovalLinkSignals$ = computed((get) => {
  return get(linkSignals$);
});

export const mountRemoteDeviceApprovalLink$ = onRef(
  command(({ get, set }, _element: HTMLElement, signal: AbortSignal) => {
    const action = get(remoteDeviceApprovalLink$);
    if (!action) {
      return;
    }
    const signals = createRemoteDeviceApprovalSignals(action);
    set(linkSignals$, signals);
    signal.addEventListener(
      "abort",
      () => {
        if (get(linkSignals$) === signals) {
          set(linkSignals$, null);
        }
      },
      { once: true },
    );
  }),
);

export const closeRemoteDeviceApprovalLink$ = command(({ get, set }) => {
  const params = new URLSearchParams(get(searchParams$));
  for (const key of [
    "remoteDeviceApproval",
    "reason",
    "actionId",
    "callbackPrompt",
    "threadId",
  ]) {
    params.delete(key);
  }
  set(replaceSearchParams$, params, get(historyState$), get(hash$));
});
