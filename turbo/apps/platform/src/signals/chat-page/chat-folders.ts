import { command, computed, state } from "ccstate";
import { array, string } from "zod";
import {
  chatFoldersContract,
  chatFoldersChangedEvent,
  type ChatFolder,
  type ChatFolderCatalog,
} from "@okouai/api-contracts/contracts/chat-folders";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { currentChatAgentRecordId$ } from "../agent-chat.ts";
import { authenticatedSessionKey$ } from "../auth.ts";
import { runtimeAuthenticatedIdentity$ } from "../auth-context.ts";
import { apiClient$ } from "../api-client.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { localStorageSignals } from "../external/local-storage.ts";
import { accept } from "../../lib/accept.ts";
import { jsonParseOr, onRef } from "../utils.ts";
import { setAblyInvalidationLoop$ } from "../realtime.ts";

export const chatFoldersEnabled$ = computed((get) => {
  return get(featureSwitch$)[FeatureSwitchKey.ChatThreadFolders] === true;
});

const NAME_CONFLICT_OPTIONS = {
  expectedErrors: { 409: ["CONFLICT"] },
  showExpectedErrorToast: false,
} as const;

type FolderAction =
  | { readonly kind: "create"; readonly id: string; readonly name: string }
  | { readonly kind: "rename"; readonly id: string; readonly name: string }
  | { readonly kind: "delete"; readonly id: string }
  | {
      readonly kind: "move";
      readonly threadId: string;
      readonly folderId: string | null;
    }
  | {
      readonly kind: "reorder";
      readonly id: string;
      readonly beforeId: string | null;
      readonly afterId: string | null;
    };
export type FolderDialog =
  | { readonly kind: "create"; readonly id: string }
  | { readonly kind: "rename" | "delete"; readonly folder: ChatFolder }
  | { readonly kind: "move"; readonly threadId: string };

function createFolderExpansionSignals(owner: {
  readonly userId: string;
  readonly orgId: string;
  readonly agentId: string;
}) {
  const storage = localStorageSignals(
    `chat-folder-collapse:${owner.userId}:${owner.orgId}:${owner.agentId}`,
  );
  const collapsed$ = computed((get) => {
    const raw = get(storage.get$);
    if (!raw) {
      return new Set<string>();
    }
    const parsed = array(string()).safeParse(jsonParseOr<unknown>(raw, null));
    return new Set(parsed.success ? parsed.data : []);
  });
  const setExpanded$ = command(
    ({ get, set }, id: string, expanded: boolean) => {
      const next = new Set(get(collapsed$));
      if (expanded) {
        next.delete(id);
      } else {
        next.add(id);
      }
      set(storage.set$, JSON.stringify([...next]));
    },
  );
  return { collapsed$, setExpanded$ };
}

function createFolderCatalogSignals(agentId: string) {
  const revision$ = state(0);
  const reload$ = command(({ set }) => {
    set(revision$, (value) => {
      return value + 1;
    });
  });
  const catalog$ = computed(async (get): Promise<ChatFolderCatalog> => {
    get(revision$);
    const client = get(apiClient$)(chatFoldersContract);
    const result = await accept(
      client.list({
        params: { agentId: agentId },
      }),
      [200],
    );
    return result.body;
  });
  const subscribeOnRef$ = onRef(
    command(({ set }, _element: HTMLElement, signal: AbortSignal) => {
      set(
        setAblyInvalidationLoop$,
        {
          scope: "credential",
          topic: chatFoldersChangedEvent(agentId),
          invalidations: [reload$],
          options: { runOnSubscribe: true },
        },
        signal,
      );
    }),
  );
  return { catalog$, reload$, subscribeOnRef$ };
}

function createChatFolderSignals(owner: {
  readonly userId: string;
  readonly orgId: string;
  readonly agentId: string;
}) {
  const { collapsed$, setExpanded$ } = createFolderExpansionSignals(owner);
  const { catalog$, reload$, subscribeOnRef$ } = createFolderCatalogSignals(
    owner.agentId,
  );
  const dialog$ = state<FolderDialog | null>(null);
  const setDialog$ = command(({ set }, dialog: FolderDialog | null) => {
    set(dialog$, dialog);
  });
  const mutate$ = command(
    async ({ get, set }, action: FolderAction, signal: AbortSignal) => {
      const client = get(apiClient$)(chatFoldersContract);
      const pendingDialog = get(dialog$);
      signal.throwIfAborted();
      switch (action.kind) {
        case "create": {
          await accept(
            client.create({
              params: { agentId: owner.agentId },
              body: { id: action.id, name: action.name },
              fetchOptions: { signal },
            }),
            [201],
            signal,
            NAME_CONFLICT_OPTIONS,
          );
          signal.throwIfAborted();
          set(setExpanded$, action.id, true);
          break;
        }
        case "rename": {
          await accept(
            client.rename({
              params: { id: action.id },
              body: { name: action.name },
              fetchOptions: { signal },
            }),
            [204],
            signal,
            NAME_CONFLICT_OPTIONS,
          );
          signal.throwIfAborted();
          break;
        }
        case "delete": {
          await accept(
            client.delete({
              params: { id: action.id },
              fetchOptions: { signal },
            }),
            [204],
          );
          signal.throwIfAborted();
          break;
        }
        case "move": {
          await accept(
            client.moveThread({
              params: { id: action.threadId },
              body: { folderId: action.folderId },
              fetchOptions: { signal },
            }),
            [204],
          );
          signal.throwIfAborted();
          if (action.folderId) {
            set(setExpanded$, action.folderId, true);
          }
          break;
        }
        case "reorder": {
          await accept(
            client.reorder({
              params: { id: action.id },
              body: { beforeId: action.beforeId, afterId: action.afterId },
              fetchOptions: { signal },
            }),
            [204],
          );
          signal.throwIfAborted();
          break;
        }
      }
      signal.throwIfAborted();
      set(reload$);
      await get(catalog$);
      signal.throwIfAborted();
      if (get(dialog$) === pendingDialog) {
        set(dialog$, null);
      }
    },
  );
  return {
    owner,
    catalog$,
    collapsed$,
    dialog$: computed((get) => {
      return get(dialog$);
    }),
    setDialog$,
    setExpanded$,
    mutate$,
    reload$,
    subscribeOnRef$,
  };
}
export type ChatFolderSignals = ReturnType<typeof createChatFolderSignals>;

const folderRegistry$ = computed((get) => {
  get(authenticatedSessionKey$);
  return new Map<string, ChatFolderSignals>();
});
export const currentChatFolders$ = computed(
  async (get): Promise<ChatFolderSignals | null> => {
    get(authenticatedSessionKey$);
    if (!get(chatFoldersEnabled$)) {
      return null;
    }
    const identity = await get(runtimeAuthenticatedIdentity$);
    const agentId = await get(currentChatAgentRecordId$);
    if (!agentId) {
      return null;
    }
    const registry = get(folderRegistry$);
    const key = JSON.stringify([identity.userId, identity.orgId, agentId]);
    const existing = registry.get(key);
    if (existing) {
      return existing;
    }
    const signals = createChatFolderSignals({ ...identity, agentId });
    registry.set(key, signals);
    return signals;
  },
);
export const currentChatFolderCatalog$ = computed(async (get) => {
  const folders = await get(currentChatFolders$);
  return folders ? await get(folders.catalog$) : null;
});

export const revealChatFolderThread$ = command(
  async ({ get, set }, threadId: string, signal: AbortSignal) => {
    const folders = await get(currentChatFolders$);
    signal.throwIfAborted();
    if (!folders) {
      return;
    }
    const catalog = await get(folders.catalog$);
    signal.throwIfAborted();
    const membership = catalog.memberships.find((item) => {
      return item.chatThreadId === threadId;
    });
    if (membership) {
      set(folders.setExpanded$, membership.folderId, true);
    }
  },
);

export const CHAT_FOLDER_DRAG_TYPE = "application/x-okou-chat-folder";
export const CHAT_THREAD_FOLDER_DRAG_TYPE =
  "application/x-okou-chat-thread-folder";
