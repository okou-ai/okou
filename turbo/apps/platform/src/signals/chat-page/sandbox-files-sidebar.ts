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
  onDomEventFn,
  onRef,
  Reason,
  resetSignal,
  setLoop,
  tapError,
  withCleanup,
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
interface FilesFailure {
  readonly path: readonly string[];
  readonly error: FilesError;
}
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
const MAX_REFRESH_PAGES = 128;
const REFRESH_INTERVAL_MS = 5000;
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
    resetPolling$: resetSignal(),
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

function compareFilesEntries(a: FilesEntry, b: FilesEntry): number {
  return (
    Number(b.kind === "directory") - Number(a.kind === "directory") ||
    a.displayName.localeCompare(b.displayName) ||
    a.nameToken.localeCompare(b.nameToken)
  );
}

function mergeSortedEntries(
  previous: readonly FilesEntry[],
  additions: FilesEntry[],
): readonly FilesEntry[] {
  additions.sort(compareFilesEntries);
  const firstNew = additions.at(0);
  const previousLast = previous.at(-1);
  if (
    !firstNew ||
    !previousLast ||
    compareFilesEntries(previousLast, firstNew) <= 0
  ) {
    return [...previous, ...additions];
  }
  const pending = additions.values();
  let next = pending.next();
  const merged: FilesEntry[] = [];
  for (const entry of previous) {
    while (!next.done && compareFilesEntries(next.value, entry) < 0) {
      merged.push(next.value);
      next = pending.next();
    }
    merged.push(entry);
  }
  if (!next.done) {
    merged.push(next.value);
  }
  merged.push(...pending);
  return merged;
}

function appendPage(
  directory: FilesDirectory,
  result: ListResult,
): FilesDirectory {
  const seen = new Set(
    directory.entries.map((entry) => {
      return entry.nameToken;
    }),
  );
  const additions: FilesEntry[] = [];
  let entryBytes = directory.entryBytes;
  for (const entry of result.entries) {
    if (seen.has(entry.nameToken)) {
      continue;
    }
    seen.add(entry.nameToken);
    additions.push(entry);
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
    entries: mergeSortedEntries(directory.entries, additions),
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
        set(graph.virtual.reconcileFocus$);
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
        set(graph.virtual.reconcileFocus$);
        await set(cursors.release$, request, result, true, signal);
        return;
      }
      set(graph.directories$, candidate);
      set(graph.virtual.reconcileFocus$);
    },
  );
}

function createFailListingCommand(graph: FilesGraph, cursors: CursorCommands) {
  return command(
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
      set(graph.virtual.reconcileFocus$);
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
}

function createListingCommands(graph: FilesGraph, cursors: CursorCommands) {
  const prepare$ = createPrepareListingCommand(graph);
  const publish$ = createPublishListingCommand(graph, cursors);
  const fail$ = createFailListingCommand(graph, cursors);
  const automaticRefresh$ = createAutomaticRefreshCommand(graph, cursors);
  const load$ = command(
    async (
      { get, set },
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
        async (error) => {
          if (
            more &&
            error instanceof SandboxChannelError &&
            error.code === "cursor_expired" &&
            set(cursors.current$, request)
          ) {
            // Start a fresh listing once, preserving expansion and loaded coverage.
            set(
              graph.directories$,
              new Map(get(graph.directories$)).set(request.key, {
                ...request.directory,
                loading: false,
              }),
            );
            await set(automaticRefresh$, path, signal);
          } else {
            await set(fail$, request, error, signal);
          }
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
      set(graph.virtual.reconcileFocus$);
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
  return { load$, discard$, automaticRefresh$ };
}
type ListingCommands = ReturnType<typeof createListingCommands>;

function createCollectFreshListingCommand(cursors: CursorCommands) {
  const close$ = command(
    async (
      { set },
      request: ListingRequest,
      handles: readonly (string | null | undefined)[],
      signal: AbortSignal,
    ): Promise<void> => {
      for (const cursor of new Set(handles)) {
        if (cursor) {
          await set(
            cursors.close$,
            request.connection.peer,
            request.connection.epoch,
            cursor,
            signal,
          );
        }
      }
    },
  );
  return command(
    async (
      { set },
      request: ListingRequest,
      signal: AbortSignal,
    ): Promise<FilesDirectory | FilesError | null> => {
      const { connection, directory } = request;
      let fresh: FilesDirectory = {
        ...directory,
        entries: [],
        entryBytes: 0,
        cursor: null,
        listingId: null,
        loading: false,
      };
      let failure: FilesError = "unavailable";
      for (let page = 0; page < MAX_REFRESH_PAGES; page++) {
        signal.throwIfAborted();
        if (!set(cursors.current$, request)) {
          await set(close$, request, [fresh.cursor], signal);
          return null;
        }
        const result = await tapError(
          connection.peer.call(
            sandboxFsList,
            fresh.cursor
              ? { cursor: fresh.cursor }
              : { path: [...directory.path] },
            signal,
          ),
          (error) => {
            failure = filesError(error);
          },
        );
        signal.throwIfAborted();
        if (!set(cursors.current$, request)) {
          await set(
            close$,
            request,
            [fresh.cursor, result?.nextCursor],
            signal,
          );
          return null;
        }
        if (
          !result ||
          (fresh.listingId && fresh.listingId !== result.listingId)
        ) {
          await set(
            close$,
            request,
            [fresh.cursor, result?.nextCursor],
            signal,
          );
          return result ? "stale" : failure;
        }
        fresh = appendPage(fresh, result);
        if (
          fresh.entries.length > MAX_ENTRIES ||
          fresh.entryBytes > MAX_BYTES
        ) {
          await set(close$, request, [fresh.cursor], signal);
          return "limit";
        }
        if (!fresh.cursor || fresh.entries.length >= directory.entries.length) {
          return fresh;
        }
      }
      await set(close$, request, [fresh.cursor], signal);
      return "limit";
    },
  );
}

function pruneRefreshedDescendants(
  next: Map<string, FilesDirectory>,
  fresh: FilesDirectory,
) {
  const orphaned: FilesDirectory[] = [];
  for (const [childKey, child] of next) {
    if (
      child.path.length > fresh.path.length &&
      beneath(child.path, fresh.path) &&
      !fresh.entries.some((entry) => {
        return (
          entry.kind === "directory" &&
          entry.nameToken === child.path[fresh.path.length]
        );
      })
    ) {
      next.delete(childKey);
      orphaned.push(child);
    }
  }
  return orphaned;
}

function createAutomaticRefreshCommand(
  graph: FilesGraph,
  cursors: CursorCommands,
) {
  const collect$ = createCollectFreshListingCommand(cursors);
  return command(
    async (
      { get, set },
      path: readonly string[],
      signal: AbortSignal,
    ): Promise<void> => {
      signal.throwIfAborted();
      const connection = get(graph.connection$);
      const key = filesDirectoryKey(path);
      const previous = get(graph.directories$).get(key);
      if (
        !connection ||
        !previous ||
        previous.loading ||
        previous.error ||
        !set(cursors.live$, connection)
      ) {
        return;
      }
      const revision = get(graph.revision$) + 1;
      set(graph.revision$, revision);
      const directory = { ...previous, revision, loading: true };
      const request: ListingRequest = {
        connection,
        key,
        directory,
        more: false,
        params: { path: [...path] },
      };
      set(
        graph.directories$,
        new Map(get(graph.directories$)).set(key, directory),
      );
      if (previous.cursor) {
        await set(
          cursors.close$,
          connection.peer,
          connection.epoch,
          previous.cursor,
          signal,
        );
      }
      const fresh = await set(collect$, request, signal);
      signal.throwIfAborted();
      if (fresh === null) {
        return;
      }
      if (!set(cursors.current$, request)) {
        if (typeof fresh !== "string" && fresh.cursor) {
          await set(
            cursors.close$,
            connection.peer,
            connection.epoch,
            fresh.cursor,
            signal,
          );
        }
        return;
      }
      const next = new Map(get(graph.directories$));
      const orphaned =
        typeof fresh === "string"
          ? []
          : pruneRefreshedDescendants(next.set(key, fresh), fresh);
      if (typeof fresh === "string" || !withinBudget(next)) {
        if (typeof fresh !== "string" && fresh.cursor) {
          await set(
            cursors.close$,
            connection.peer,
            connection.epoch,
            fresh.cursor,
            signal,
          );
        }
        if (set(cursors.current$, request)) {
          set(
            graph.directories$,
            new Map(get(graph.directories$)).set(key, {
              ...directory,
              loading: false,
              cursor: null,
              error: typeof fresh === "string" ? fresh : "limit",
            }),
          );
          set(graph.virtual.reconcileFocus$);
        }
        return;
      }
      set(graph.directories$, next);
      set(graph.virtual.reconcileFocus$);
      for (const child of orphaned) {
        if (child.cursor) {
          await set(
            cursors.close$,
            connection.peer,
            connection.epoch,
            child.cursor,
            signal,
          );
        }
      }
    },
  );
}

function createPollingCommands(
  graph: FilesGraph,
  refresh$: Command<Promise<void>, [readonly string[], AbortSignal]>,
) {
  const busy$ = state(false);
  const refreshOffset$ = state(0);
  const refreshVisible$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      const paths = new Map<string, readonly string[]>([
        [filesDirectoryKey([]), []],
      ]);
      for (const row of get(graph.virtual.window$).rows) {
        paths.set(filesDirectoryKey(row.path), row.path);
        if (row.type === "entry" && row.expanded) {
          const child = [...row.path, row.entry.nameToken];
          paths.set(filesDirectoryKey(child), child);
        }
      }
      const children = [...paths.values()].filter((path) => {
        return path.length > 0;
      });
      const offset = get(refreshOffset$) % Math.max(1, children.length);
      const selected = [
        ...children.slice(offset),
        ...children.slice(0, offset),
      ].slice(0, 7);
      set(refreshOffset$, (offset + 7) % Math.max(1, children.length));
      for (const path of [[], ...selected]) {
        await set(refresh$, path, signal);
      }
    },
  );
  const tick$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      if (signal.aborted || document.hidden || get(busy$)) {
        return;
      }
      set(busy$, true);
      await withCleanup(set(refreshVisible$, signal), () => {
        set(busy$, false);
      });
    },
  );
  return command(({ set }, signal: AbortSignal): void => {
    const owner = set(graph.resetPolling$, signal);
    setLoop(
      async (loopSignal) => {
        await set(tick$, loopSignal);
        return false;
      },
      REFRESH_INTERVAL_MS,
      owner,
      {
        retryTransientErrors: false,
        testIntervalMs: REFRESH_INTERVAL_MS,
      },
    );
    document.addEventListener(
      "visibilitychange",
      onDomEventFn(() => {
        return set(tick$, owner);
      }),
      { signal: owner },
    );
  });
}

function createConnectionCommands(graph: FilesGraph, listing: ListingCommands) {
  const startPolling$ = createPollingCommands(graph, listing.automaticRefresh$);
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
        set(graph.resetPolling$);
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
        set(startPolling$, signal);
        detach(
          set(listing.load$, [], false, signal),
          Reason.Daemon,
          "load sandbox home for the current epoch",
        );
      } else if (state === "failed" || state === "closed") {
        set(graph.resetPolling$);
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
  const refreshRequest$ = state<{ readonly connection: Connection } | null>(
    null,
  );
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
  const reload$ = command(
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
  const refresh$ = command(
    async (
      { get, set },
      path: readonly string[],
      signal: AbortSignal,
    ): Promise<void> => {
      const connection = get(graph.connection$);
      if (!connection || get(refreshRequest$)?.connection === connection) {
        return;
      }
      const request = { connection };
      set(refreshRequest$, request);
      await withCleanup(set(reload$, path, signal), () => {
        if (get(refreshRequest$) === request) {
          set(refreshRequest$, null);
        }
      });
    },
  );
  const refreshing$ = computed((get) => {
    const request = get(refreshRequest$);
    return (
      get(graph.phase$) === "connecting" ||
      get(graph.directoriesView$).get(filesDirectoryKey([]))?.loading ===
        true ||
      (request !== null && request.connection === get(graph.connection$))
    );
  });
  const more$ = command(
    ({ set }, path: readonly string[], signal: AbortSignal) => {
      return set(listing.load$, path, true, signal);
    },
  );
  return { toggle$, refresh$, refreshing$, more$ };
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
    virtual: graph.virtual,
    phase$: computed((get) => {
      return get(graph.phase$);
    }),
    failure$: computed((get): FilesFailure | null => {
      for (const directory of get(graph.directories$).values()) {
        if (directory.error) {
          return { path: directory.path, error: directory.error };
        }
      }
      return get(graph.limit$) ? { path: [], error: "limit" } : null;
    }),
  };
}
export type SandboxFilesSidebarSignals = ReturnType<
  typeof createSandboxFilesSidebarSignals
>;
