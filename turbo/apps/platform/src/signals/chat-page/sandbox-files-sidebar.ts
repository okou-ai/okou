import { command, computed, state, type Command, type Computed } from "ccstate";
import type { z } from "zod";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import type {
  SandboxChannelPeer,
  SandboxChannelState,
} from "@okouai/core/sandbox-channel-peer";
import { SandboxChannelError } from "@okouai/api-contracts/contracts/sandbox-channel";
import {
  sandboxFsCategory,
  sandboxFsList,
  sandboxFsListClose,
  type sandboxFsListResultSchema,
} from "@okouai/api-contracts/contracts/sandbox-channel-fs";
import { createBrowserSandboxChannelPeer } from "../../lib/sandbox-channel-peer.ts";
import { apiClient$ } from "../api-client.ts";
import { authenticatedSessionKey$ } from "../auth.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { pageSignal$ } from "../page-signal.ts";
import {
  bestEffort,
  detach,
  onRef,
  Reason,
  resetSignal,
  tapError,
} from "../utils.ts";
import { createActiveRunSubscription } from "./active-run-subscription.ts";
import {
  liveRunIdsFromChatEvents,
  deriveServerRunStateFromChatEvents,
} from "./chat-event-state.ts";
import type { ChatEvent } from "./chat-event-types.ts";
import {
  createSandboxFilesVirtualListSignals,
  filesDirectoryKey,
} from "./sandbox-files-virtual-list.ts";

export type FilesEntry = z.infer<
  typeof sandboxFsListResultSchema
>["entries"][number];
export type FilesError = "unavailable" | "updateRequired" | "stale" | "limit";
export interface FilesDirectory {
  readonly id: number;
  readonly path: readonly string[];
  readonly revision: number;
  readonly entries: readonly FilesEntry[];
  /** Encoded entry bytes plus a conservative allowance for virtual row keys. */
  readonly entryBytes: number;
  readonly loading: boolean;
  readonly listingId: string | null;
  readonly cursor: string | null;
  readonly error: FilesError | null;
}
interface Connection {
  readonly peer: SandboxChannelPeer;
  readonly epoch: number;
  readonly sessionKey: string;
}
const MAX_ENTRIES = 4096;
const MAX_BYTES = 4 * 1024 * 1024;
function beneath(path: readonly string[], parent: readonly string[]): boolean {
  return parent.every((token, index) => {
    return path[index] === token;
  });
}
function filesError(error: unknown): FilesError {
  if (error instanceof SandboxChannelError) {
    switch (error.code) {
      case "unsupported_schema":
      case "unsupported_category":
      case "category_version_mismatch":
      case "unknown_operation": {
        return "updateRequired";
      }
      case "directory_changed":
      case "cursor_expired": {
        return "stale";
      }
      case "limit_exceeded": {
        return "limit";
      }
    }
  }
  return "unavailable";
}
function withinBudget(
  directories: ReadonlyMap<string, FilesDirectory>,
): boolean {
  const retained = [...directories.values()];
  return (
    retained.reduce((count, item) => {
      return count + item.entries.length;
    }, 0) <= MAX_ENTRIES &&
    // Reserve space for terminal error/loading changes without exceeding the cap.
    retained.reduce((bytes, directory) => {
      return (
        bytes +
        directory.entryBytes +
        new TextEncoder().encode(JSON.stringify({ ...directory, entries: [] }))
          .byteLength
      );
    }, 0) +
      retained.length * 32 <=
      MAX_BYTES
  );
}

interface ListingRequest {
  readonly connection: Connection;
  readonly key: string;
  readonly directory: FilesDirectory;
  readonly more: boolean;
  readonly params: z.infer<typeof sandboxFsList.params>;
}
type ListResult = z.infer<typeof sandboxFsListResultSchema>;

function createFilesGraph(chatEvents$: Computed<ChatEvent[]>) {
  const directories$ = state<ReadonlyMap<string, FilesDirectory>>(new Map());
  const directoriesView$ = computed((get) => {
    return get(directories$);
  });
  return {
    directories$,
    directoriesView$,
    virtual: createSandboxFilesVirtualListSignals(directoriesView$),
    connection$: state<Connection | null>(null),
    phase$: state<"connecting" | "ready" | FilesError>("connecting"),
    revision$: state(0),
    epoch$: state(0),
    mountVersion$: state(0),
    mounted$: state(false),
    ownerKey$: state<string | null>(null),
    resetDemand$: resetSignal(),
    limit$: state(false),
    activeRunId$: computed((get) => {
      return liveRunIdsFromChatEvents(get(chatEvents$)).at(-1) ?? null;
    }),
    pending$: computed((get) => {
      return deriveServerRunStateFromChatEvents(get(chatEvents$)) === "queued";
    }),
  };
}
type FilesGraph = ReturnType<typeof createFilesGraph>;

function createCursorCommands(graph: FilesGraph) {
  const live$ = command(({ get }, connection: Connection) => {
    return (
      connection === get(graph.connection$) &&
      connection.sessionKey === get(authenticatedSessionKey$) &&
      get(featureSwitch$)[FeatureSwitchKey.SandboxFilesSidebar]
    );
  });
  const current$ = command(({ get, set }, request: ListingRequest) => {
    return (
      set(live$, request.connection) &&
      get(graph.directories$).get(request.key)?.revision ===
        request.directory.revision
    );
  });
  const close$ = command(
    async (
      { get },
      peer: SandboxChannelPeer,
      epoch: number,
      cursor: string,
      signal: AbortSignal,
    ): Promise<void> => {
      if (
        epoch !== get(graph.connection$)?.epoch ||
        signal.aborted ||
        peer.state !== "ready"
      ) {
        return;
      }
      await bestEffort(
        peer.call(sandboxFsListClose, { cursor }, signal),
        signal,
      );
    },
  );
  const release$ = command(
    async (
      { set },
      request: ListingRequest,
      result: ListResult,
      includePrevious: boolean,
      signal: AbortSignal,
    ): Promise<void> => {
      const { connection, directory } = request;
      if (result.nextCursor) {
        await set(
          close$,
          connection.peer,
          connection.epoch,
          result.nextCursor,
          signal,
        );
      }
      if (
        includePrevious &&
        directory.cursor &&
        directory.cursor !== result.nextCursor
      ) {
        await set(
          close$,
          connection.peer,
          connection.epoch,
          directory.cursor,
          signal,
        );
      }
    },
  );
  return { live$, current$, close$, release$ };
}
type CursorCommands = ReturnType<typeof createCursorCommands>;

function createPrepareListingCommand(graph: FilesGraph) {
  return command(
    (
      { get, set },
      path: readonly string[],
      more: boolean,
    ): ListingRequest | null => {
      const connection = get(graph.connection$);
      if (
        !connection ||
        connection.peer.state !== "ready" ||
        !get(featureSwitch$)[FeatureSwitchKey.SandboxFilesSidebar] ||
        connection.sessionKey !== get(authenticatedSessionKey$)
      ) {
        return null;
      }
      for (let index = 0; index < path.length; index++) {
        const parent = get(graph.directories$).get(
          filesDirectoryKey(path.slice(0, index)),
        );
        if (
          !parent?.entries.some((entry) => {
            return (
              entry.nameToken === path[index] && entry.kind === "directory"
            );
          })
        ) {
          return null;
        }
      }
      const key = filesDirectoryKey(path);
      const previous = get(graph.directories$).get(key);
      if (previous?.loading) {
        return null;
      }
      let params: z.infer<typeof sandboxFsList.params> = { path: [...path] };
      if (more) {
        if (!previous?.cursor) {
          return null;
        }
        params = { cursor: previous.cursor };
      }
      const revision = get(graph.revision$) + 1;
      set(graph.revision$, revision);
      let directory: FilesDirectory = {
        id: revision,
        path,
        revision,
        entries: [],
        entryBytes: 0,
        loading: true,
        listingId: null,
        cursor: null,
        error: null,
      };
      if (more && previous) {
        directory = { ...previous, revision, loading: true, error: null };
      }
      const loading = new Map(get(graph.directories$)).set(key, directory);
      if (!withinBudget(loading)) {
        set(graph.limit$, true);
        return null;
      }
      set(graph.directories$, loading);
      return { connection, key, directory, more, params };
    },
  );
}

function appendPage(
  directory: FilesDirectory,
  result: ListResult,
): FilesDirectory {
  const entries = new Map(
    directory.entries.map((entry) => {
      return [entry.nameToken, entry];
    }),
  );
  let entryBytes = directory.entryBytes;
  for (const entry of result.entries) {
    if (entries.has(entry.nameToken)) {
      continue;
    }
    entries.set(entry.nameToken, entry);
    entryBytes +=
      new TextEncoder().encode(JSON.stringify(entry)).byteLength +
      1 +
      entry.nameToken.length +
      96;
  }
  return {
    ...directory,
    entryBytes,
    loading: false,
    entries: [...entries.values()].sort((a, b) => {
      return (
        Number(b.kind === "directory") - Number(a.kind === "directory") ||
        a.displayName.localeCompare(b.displayName) ||
        a.nameToken.localeCompare(b.nameToken)
      );
    }),
    listingId: result.listingId,
    cursor: result.nextCursor,
  };
}

function createPublishListingCommand(
  graph: FilesGraph,
  cursors: CursorCommands,
) {
  return command(
    async (
      { get, set },
      request: ListingRequest,
      result: ListResult,
      signal: AbortSignal,
    ): Promise<void> => {
      if (!set(cursors.live$, request.connection)) {
        return;
      }
      if (!set(cursors.current$, request)) {
        await set(cursors.release$, request, result, false, signal);
        return;
      }
      const { key, directory } = request;
      if (request.more && result.listingId !== directory.listingId) {
        set(
          graph.directories$,
          new Map(get(graph.directories$)).set(key, {
            ...directory,
            loading: false,
            cursor: null,
            error: "stale",
          }),
        );
        await set(cursors.release$, request, result, true, signal);
        return;
      }
      const candidate = new Map(get(graph.directories$)).set(
        key,
        appendPage(directory, result),
      );
      if (!withinBudget(candidate)) {
        set(
          graph.directories$,
          new Map(get(graph.directories$)).set(key, {
            ...directory,
            loading: false,
            cursor: null,
            error: "limit",
          }),
        );
        await set(cursors.release$, request, result, true, signal);
        return;
      }
      set(graph.directories$, candidate);
    },
  );
}

function createListingCommands(graph: FilesGraph, cursors: CursorCommands) {
  const prepare$ = createPrepareListingCommand(graph);
  const publish$ = createPublishListingCommand(graph, cursors);
  const fail$ = command(
    async (
      { get, set },
      request: ListingRequest,
      error: unknown,
      signal: AbortSignal,
    ): Promise<void> => {
      if (!set(cursors.current$, request)) {
        return;
      }
      const { key, directory, connection } = request;
      set(
        graph.directories$,
        new Map(get(graph.directories$)).set(key, {
          ...directory,
          loading: false,
          cursor: null,
          error: filesError(error),
        }),
      );
      if (directory.cursor) {
        await set(
          cursors.close$,
          connection.peer,
          connection.epoch,
          directory.cursor,
          signal,
        );
      }
    },
  );
  const load$ = command(
    async (
      { set },
      path: readonly string[],
      more: boolean,
      signal: AbortSignal,
    ): Promise<void> => {
      signal.throwIfAborted();
      const request = set(prepare$, path, more);
      if (!request) {
        return;
      }
      // Directory collapse/refresh invalidate publication, leaving sent requests
      // alive for terminal cursor inspection. The peer owns epoch cancellation.
      const result = await tapError(
        request.connection.peer.call(sandboxFsList, request.params, signal),
        (error) => {
          return set(fail$, request, error, signal);
        },
      );
      signal.throwIfAborted();
      if (result) {
        await set(publish$, request, result, signal);
      }
    },
  );
  const discard$ = command(
    async (
      { get, set },
      path: readonly string[],
      signal: AbortSignal,
    ): Promise<void> => {
      signal.throwIfAborted();
      const connection = get(graph.connection$);
      const retained = new Map(get(graph.directories$));
      const handles = new Set<string>();
      for (const [key, directory] of retained) {
        if (!beneath(directory.path, path)) {
          continue;
        }
        retained.delete(key);
        if (directory.cursor) {
          handles.add(directory.cursor);
        }
      }
      set(graph.directories$, retained);
      if (path.length === 0) {
        set(graph.virtual.reset$);
      }
      set(graph.limit$, false);
      if (connection) {
        for (const handle of handles) {
          await set(
            cursors.close$,
            connection.peer,
            connection.epoch,
            handle,
            signal,
          );
        }
      }
    },
  );
  return { load$, discard$ };
}
type ListingCommands = ReturnType<typeof createListingCommands>;

function createConnectionCommands(graph: FilesGraph, listing: ListingCommands) {
  const peerState$ = command(
    (
      { get, set },
      peer: SandboxChannelPeer,
      state: SandboxChannelState,
      error: unknown,
      signal: AbortSignal,
    ): void => {
      if (signal.aborted) {
        return;
      }
      if (state === "connecting" || state === "reconnecting") {
        set(graph.directories$, new Map());
        set(graph.virtual.reset$);
        set(graph.limit$, false);
        const epoch = get(graph.epoch$) + 1;
        set(graph.epoch$, epoch);
        const sessionKey = get(graph.ownerKey$);
        if (!sessionKey || sessionKey !== get(authenticatedSessionKey$)) {
          return;
        }
        set(graph.connection$, { peer, epoch, sessionKey });
        set(graph.phase$, "connecting");
      } else if (state === "ready") {
        if (get(graph.connection$)?.peer !== peer) {
          return;
        }
        set(graph.phase$, "ready");
        detach(
          set(listing.load$, [], false, signal),
          Reason.Daemon,
          "load sandbox home for the current epoch",
        );
      } else if (state === "failed" || state === "closed") {
        if (get(graph.connection$)?.peer !== peer) {
          return;
        }
        set(graph.connection$, null);
        set(graph.directories$, new Map());
        set(graph.phase$, filesError(error));
      }
    },
  );
  const connect$ = command(
    async (
      _context,
      peer: SandboxChannelPeer,
      signal: AbortSignal,
    ): Promise<void> => {
      await bestEffort(peer.connect(signal), signal);
    },
  );
  const startRun$ = command(
    ({ get, set }, runId: string, signal: AbortSignal): void => {
      if (
        signal.aborted ||
        !get(featureSwitch$)[FeatureSwitchKey.SandboxFilesSidebar] ||
        !get(graph.ownerKey$) ||
        get(graph.ownerKey$) !== get(authenticatedSessionKey$)
      ) {
        return;
      }
      const peer = createBrowserSandboxChannelPeer(runId, get(apiClient$), {
        categories: [sandboxFsCategory],
        onStateChange: (state, error) => {
          set(peerState$, peer, state, error, signal);
        },
      });
      signal.addEventListener(
        "abort",
        () => {
          if (get(graph.connection$)?.peer === peer) {
            set(graph.connection$, null);
            set(graph.directories$, new Map());
            set(graph.limit$, false);
          }
        },
        { once: true },
      );
      detach(
        set(connect$, peer, signal),
        Reason.Daemon,
        "visible sandbox files connection",
      );
    },
  );
  return { startRun$ };
}

function createDemandCommands(
  graph: FilesGraph,
  chatEvents$: Computed<ChatEvent[]>,
  startRun$: Command<void, [string, AbortSignal]>,
  closeSidebar$: Command<void, []>,
) {
  const subscription = createActiveRunSubscription(
    chatEvents$,
    graph.activeRunId$,
    startRun$,
  );
  const mount$ = onRef(
    command(({ get, set }, _element: HTMLElement, signal: AbortSignal) => {
      if (!get(featureSwitch$)[FeatureSwitchKey.SandboxFilesSidebar]) {
        return;
      }
      const sessionKey = get(authenticatedSessionKey$);
      if (!sessionKey) {
        return;
      }
      set(graph.ownerKey$, sessionKey);
      const version = get(graph.mountVersion$) + 1;
      set(graph.mountVersion$, version);
      set(graph.mounted$, true);
      const owner = set(graph.resetDemand$, signal, get(pageSignal$));
      signal.addEventListener(
        "abort",
        () => {
          if (get(graph.mountVersion$) !== version) {
            return;
          }
          set(graph.resetDemand$);
          set(graph.mounted$, false);
          set(graph.directories$, new Map());
          if (
            !get(featureSwitch$)[FeatureSwitchKey.SandboxFilesSidebar] ||
            sessionKey !== get(authenticatedSessionKey$)
          ) {
            set(closeSidebar$);
          }
        },
        { once: true },
      );
      set(subscription.subscribe$, owner);
    }),
  );
  const retry$ = command(({ get, set }, signal: AbortSignal): void => {
    signal.throwIfAborted();
    if (
      get(graph.mounted$) &&
      get(featureSwitch$)[FeatureSwitchKey.SandboxFilesSidebar]
    ) {
      set(subscription.restart$, signal);
    }
  });
  return { mount$, retry$ };
}

function createFilesActions(graph: FilesGraph, listing: ListingCommands) {
  const toggle$ = command(
    async (
      { get, set },
      path: readonly string[],
      signal: AbortSignal,
    ): Promise<void> => {
      if (get(graph.directories$).has(filesDirectoryKey(path))) {
        await set(listing.discard$, path, signal);
      } else {
        await set(listing.load$, path, false, signal);
      }
    },
  );
  const refresh$ = command(
    async (
      { get, set },
      path: readonly string[],
      signal: AbortSignal,
    ): Promise<void> => {
      const connection = get(graph.connection$);
      await set(listing.discard$, path, signal);
      signal.throwIfAborted();
      if (connection && connection === get(graph.connection$)) {
        await set(listing.load$, path, false, signal);
      }
    },
  );
  const more$ = command(
    ({ set }, path: readonly string[], signal: AbortSignal) => {
      return set(listing.load$, path, true, signal);
    },
  );
  return { toggle$, refresh$, more$ };
}

/** Construct the thread graph without network work; its visible ref owns demand. */
export function createSandboxFilesSidebarSignals(
  chatEvents$: Computed<ChatEvent[]>,
  closeSidebar$: Command<void, []>,
) {
  const graph = createFilesGraph(chatEvents$);
  const listing = createListingCommands(graph, createCursorCommands(graph));
  const connection = createConnectionCommands(graph, listing);
  return {
    ...createDemandCommands(
      graph,
      chatEvents$,
      connection.startRun$,
      closeSidebar$,
    ),
    ...createFilesActions(graph, listing),
    activeRunId$: graph.activeRunId$,
    pending$: graph.pending$,
    directories$: graph.directoriesView$,
    virtual: graph.virtual,
    phase$: computed((get) => {
      return get(graph.phase$);
    }),
    limit$: computed((get) => {
      return get(graph.limit$);
    }),
  };
}
export type SandboxFilesSidebarSignals = ReturnType<
  typeof createSandboxFilesSidebarSignals
>;
