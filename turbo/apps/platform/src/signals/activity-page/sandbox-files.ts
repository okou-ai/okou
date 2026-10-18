import { command, computed, state, type Command } from "ccstate";
import { runsByIdContract } from "@okouai/api-contracts/contracts/run-routes";
import type { RunStatus } from "@okouai/api-contracts/contracts/runs";
import type { z } from "zod";
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
import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import { authenticatedSessionKey$ } from "../auth.ts";
import { pageSignal$ } from "../page-signal.ts";
import {
  bestEffort,
  detach,
  onDomEventFn,
  onRejection,
  onRef,
  Reason,
  resetSignal,
  setLoop,
  tapError,
  withCleanup,
} from "../utils.ts";
import { activityDetail$, currentRunId$ } from "./activity-signals.ts";
import {
  createSandboxFilesVirtualListSignals,
  filesDirectoryKey,
} from "./sandbox-files-virtual-list.ts";
import {
  FILES_HOME_LOCATION,
  FILES_VIEW_BYTES,
  filesLocationTokens,
  retainFilesViewPreferences,
  type FilesLocation,
  type FilesViewPreference,
} from "./sandbox-files-location.ts";
import { createSandboxFileDownloadSignals } from "./sandbox-file-download.ts";
import { createSandboxFilePreviewSignals } from "./sandbox-file-preview.ts";

export type FilesEntry = z.infer<
  typeof sandboxFsListResultSchema
>["entries"][number];
export type FilesError = "unavailable" | "updateRequired" | "stale" | "limit";
interface FilesFailure {
  readonly path: readonly string[];
  readonly error: FilesError;
  readonly location?: FilesLocation;
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
  readonly runId: string;
}
interface NavigationRequest {
  readonly connection: Connection;
  readonly location: FilesLocation;
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
      MAX_BYTES - FILES_VIEW_BYTES
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

function createFilesGraph() {
  const directories$ = state<ReadonlyMap<string, FilesDirectory>>(new Map());
  const directoriesView$ = computed((get) => {
    return get(directories$);
  });
  const targetRunId$ = state<string | null>(null);
  const status$ = state<RunStatus | null>(null);
  return {
    download: createSandboxFileDownloadSignals(),
    preview: createSandboxFilePreviewSignals(),
    targetRunId$,
    status$,
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
    location$: state<FilesLocation>(FILES_HOME_LOCATION),
    locationOwner$: state<string | null>(null),
    preferences$: state<ReadonlyMap<string, FilesViewPreference>>(new Map()),
    navigation$: state<NavigationRequest | null>(null),
    navigationFailure$: state<{
      readonly location: FilesLocation;
      readonly error: FilesError;
    } | null>(null),
    activeRunId$: computed((get) => {
      const status = get(status$);
      return status === null || status === "running" ? get(targetRunId$) : null;
    }),
    pending$: computed((get) => {
      const status = get(status$);
      return status === "queued" || status === "pending";
    }),
  };
}
type FilesGraph = ReturnType<typeof createFilesGraph>;

function createCursorCommands(graph: FilesGraph) {
  const live$ = command(({ get }, connection: Connection) => {
    return (
      connection === get(graph.connection$) &&
      connection.runId === get(currentRunId$) &&
      connection.sessionKey === get(authenticatedSessionKey$)
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
        connection.runId !== get(currentRunId$) ||
        connection.peer.state !== "ready" ||
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
      let params: z.infer<typeof sandboxFsList.params> = {
        path: [...filesLocationTokens(get(graph.location$)), ...path],
      };
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
            fresh.cursor ? { cursor: fresh.cursor } : request.params,
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
        params: {
          path: [...filesLocationTokens(get(graph.location$)), ...path],
        },
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

function createNavigationSnapshotCommands(
  graph: FilesGraph,
  cursors: CursorCommands,
) {
  const remember$ = command(({ get, set }) => {
    const directories = get(graph.directories$);
    const root = directories.get(filesDirectoryKey([]));
    if (!root?.listingId) {
      return;
    }
    set(
      graph.preferences$,
      retainFilesViewPreferences(
        get(graph.preferences$),
        get(graph.location$),
        {
          rootEntries: root.entries.length,
          expanded: [...directories.values()]
            .filter((directory) => {
              return directory.path.length > 0;
            })
            .sort((a, b) => {
              return a.path.length - b.path.length;
            })
            .slice(0, 7)
            .map((directory) => {
              return {
                path: directory.path,
                entries: directory.entries.length,
              };
            }),
          scrollTop: get(graph.virtual.scroll.scrollMetrics$).scrollTop,
        },
      ),
    );
  });
  const current$ = command(({ get, set }, request: NavigationRequest) => {
    return (
      get(graph.navigation$) === request &&
      set(cursors.live$, request.connection)
    );
  });
  const close$ = command(
    async (
      { set },
      connection: Connection,
      handles: readonly string[],
      signal: AbortSignal,
    ): Promise<void> => {
      for (const handle of new Set(handles)) {
        await set(
          cursors.close$,
          connection.peer,
          connection.epoch,
          handle,
          signal,
        );
      }
    },
  );
  return { remember$, current$, close$ };
}
type NavigationSnapshotCommands = ReturnType<
  typeof createNavigationSnapshotCommands
>;

function createNavigationRestoreCommand(
  graph: FilesGraph,
  listing: ListingCommands,
  snapshot: NavigationSnapshotCommands,
) {
  const { current$ } = snapshot;
  const restoreDirectory$ = command(
    async (
      { get, set },
      request: NavigationRequest,
      path: readonly string[],
      entries: number,
      signal: AbortSignal,
    ): Promise<void> => {
      if (!set(current$, request)) {
        return;
      }
      const key = filesDirectoryKey(path);
      if (!get(graph.directories$).has(key)) {
        await set(listing.load$, path, false, signal);
      }
      for (let page = 0; page < MAX_REFRESH_PAGES; page++) {
        signal.throwIfAborted();
        const directory = get(graph.directories$).get(key);
        if (
          !set(current$, request) ||
          !directory?.cursor ||
          directory.error ||
          directory.entries.length >= entries
        ) {
          return;
        }
        await set(listing.load$, path, true, signal);
      }
    },
  );
  const restore$ = command(
    async (
      { get, set },
      request: NavigationRequest,
      preference: FilesViewPreference | undefined,
      focus: boolean,
      signal: AbortSignal,
    ): Promise<void> => {
      if (preference) {
        await set(
          restoreDirectory$,
          request,
          [],
          preference.rootEntries,
          signal,
        );
        for (const directory of preference.expanded) {
          if (!set(current$, request)) {
            return;
          }
          await set(
            restoreDirectory$,
            request,
            directory.path,
            directory.entries,
            signal,
          );
        }
      }
      if (
        set(current$, request) &&
        get(graph.virtual.scroll.scrollMetrics$).scrollTop === 0
      ) {
        set(graph.virtual.restore$, preference?.scrollTop ?? 0, focus, signal);
      }
    },
  );
  return restore$;
}

function createNavigationPerformCommand(
  graph: FilesGraph,
  snapshot: NavigationSnapshotCommands,
  restore$: ReturnType<typeof createNavigationRestoreCommand>,
) {
  const { current$, close$ } = snapshot;
  const perform$ = command(
    async (
      { get, set },
      request: NavigationRequest,
      location: FilesLocation,
      signal: AbortSignal,
    ): Promise<void> => {
      const handles: string[] = [];
      const frozen = new Map<string, FilesDirectory>();
      for (const [key, directory] of get(graph.directories$)) {
        const revision = get(graph.revision$) + 1;
        set(graph.revision$, revision);
        if (directory.cursor) {
          handles.push(directory.cursor);
        }
        frozen.set(key, {
          ...directory,
          revision,
          loading: false,
          cursor: null,
          error:
            directory.cursor || directory.loading ? "stale" : directory.error,
        });
      }
      set(graph.directories$, frozen);
      set(graph.virtual.reconcileFocus$);
      // Free the old view's finite cursor slots before requesting a new one.
      // Its readable rows remain; invalidated requests can only close results.
      await set(close$, request.connection, handles, signal);
      if (!set(current$, request)) {
        return;
      }
      const result = await tapError(
        request.connection.peer.call(
          sandboxFsList,
          { path: filesLocationTokens(location) },
          signal,
        ),
        (error) => {
          if (set(current$, request)) {
            set(graph.navigationFailure$, {
              location,
              error: filesError(error),
            });
          }
        },
      );
      signal.throwIfAborted();
      if (!result) {
        return;
      }
      if (!set(current$, request)) {
        if (result.nextCursor) {
          await set(close$, request.connection, [result.nextCursor], signal);
        }
        return;
      }
      const revision = get(graph.revision$) + 1;
      set(graph.revision$, revision);
      const directory = appendPage(
        {
          id: revision,
          revision,
          path: [],
          entries: [],
          entryBytes: 0,
          loading: false,
          listingId: null,
          cursor: null,
          error: null,
        },
        result,
      );
      const next = new Map([[filesDirectoryKey([]), directory]]);
      if (!withinBudget(next)) {
        set(graph.navigationFailure$, { location, error: "limit" });
        if (result.nextCursor) {
          await set(close$, request.connection, [result.nextCursor], signal);
        }
        return;
      }
      const preference = get(graph.preferences$).get(
        filesDirectoryKey(filesLocationTokens(location)),
      );
      set(graph.location$, location);
      set(graph.directories$, next);
      set(graph.limit$, false);
      set(graph.navigationFailure$, null);
      set(graph.virtual.reset$);
      set(graph.virtual.restore$, 0, true, signal);
      await set(restore$, request, preference, false, signal);
    },
  );
  return perform$;
}

function createNavigationInitializeCommand(
  graph: FilesGraph,
  listing: ListingCommands,
  snapshot: NavigationSnapshotCommands,
  restore$: ReturnType<typeof createNavigationRestoreCommand>,
) {
  const { current$ } = snapshot;
  const initialize$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      const connection = get(graph.connection$);
      if (!connection) {
        return;
      }
      const request = {
        connection,
        location: get(graph.location$),
      };
      set(graph.navigation$, request);
      await withCleanup(
        (async () => {
          await set(listing.load$, [], false, signal);
          if (
            set(current$, request) &&
            !get(graph.directories$).get(filesDirectoryKey([]))?.error
          ) {
            await set(
              restore$,
              request,
              get(graph.preferences$).get(
                filesDirectoryKey(filesLocationTokens(get(graph.location$))),
              ),
              false,
              signal,
            );
          }
        })(),
        () => {
          if (get(graph.navigation$) === request) {
            set(graph.navigation$, null);
          }
        },
      );
    },
  );
  return initialize$;
}

function createNavigationEnterCommand(
  graph: FilesGraph,
  navigate$: Command<Promise<void>, [FilesLocation, AbortSignal]>,
) {
  const enter$ = command(
    async (
      { get, set },
      origin: FilesLocation,
      path: readonly string[],
      signal: AbortSignal,
    ): Promise<void> => {
      if (
        filesDirectoryKey(filesLocationTokens(origin)) !==
        filesDirectoryKey(filesLocationTokens(get(graph.location$)))
      ) {
        return;
      }
      const location = [...get(graph.location$)];
      for (let index = 0; index < path.length; index++) {
        const entry = get(graph.directories$)
          .get(filesDirectoryKey(path.slice(0, index)))
          ?.entries.find((candidate) => {
            return (
              candidate.nameToken === path[index] &&
              candidate.kind === "directory"
            );
          });
        if (!entry) {
          return;
        }
        location.push({
          nameToken: entry.nameToken,
          displayName: entry.displayName,
        });
      }
      await set(navigate$, location, signal);
    },
  );
  return enter$;
}

function createNavigationCommands(
  graph: FilesGraph,
  listing: ListingCommands,
  cursors: CursorCommands,
) {
  const snapshot = createNavigationSnapshotCommands(graph, cursors);
  const { remember$ } = snapshot;
  const restore$ = createNavigationRestoreCommand(graph, listing, snapshot);
  const perform$ = createNavigationPerformCommand(graph, snapshot, restore$);
  const navigate$ = command(
    async (
      { get, set },
      location: FilesLocation,
      signal: AbortSignal,
    ): Promise<void> => {
      signal.throwIfAborted();
      const connection = get(graph.connection$);
      if (
        !connection ||
        connection.peer.state !== "ready" ||
        !set(cursors.live$, connection)
      ) {
        return;
      }
      const locationKey = filesDirectoryKey(filesLocationTokens(location));
      const pending = get(graph.navigation$);
      if (
        (pending?.connection === connection &&
          filesDirectoryKey(filesLocationTokens(pending.location)) ===
            locationKey) ||
        (!pending &&
          !get(graph.navigationFailure$) &&
          !get(graph.limit$) &&
          locationKey ===
            filesDirectoryKey(filesLocationTokens(get(graph.location$))) &&
          get(graph.directories$).get(filesDirectoryKey([]))?.listingId)
      ) {
        return;
      }
      if (
        new TextEncoder().encode(JSON.stringify(location)).byteLength >
        FILES_VIEW_BYTES / 2 - 1024
      ) {
        set(graph.navigation$, null);
        set(graph.navigationFailure$, null);
        set(graph.limit$, true);
        return;
      }
      set(remember$);
      const preferences = new Map(get(graph.preferences$));
      for (const key of preferences.keys()) {
        if (
          new TextEncoder().encode(
            JSON.stringify({
              current: get(graph.location$),
              target: location,
              preferences: [...preferences],
            }),
          ).byteLength <= FILES_VIEW_BYTES
        ) {
          break;
        }
        preferences.delete(key);
      }
      set(graph.preferences$, preferences);
      const request = { connection, location };
      set(graph.navigation$, request);
      set(graph.navigationFailure$, null);
      await withCleanup(set(perform$, request, location, signal), () => {
        if (get(graph.navigation$) === request) {
          set(graph.navigation$, null);
        }
      });
    },
  );
  return {
    navigate$,
    initialize$: createNavigationInitializeCommand(
      graph,
      listing,
      snapshot,
      restore$,
    ),
    remember$,
    enter$: createNavigationEnterCommand(graph, navigate$),
  };
}
type NavigationCommands = ReturnType<typeof createNavigationCommands>;

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
      if (
        signal.aborted ||
        document.hidden ||
        get(busy$) ||
        get(graph.navigation$)
      ) {
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

function createConnectionCommands(
  graph: FilesGraph,
  listing: ListingCommands,
  navigation: NavigationCommands,
) {
  const startPolling$ = createPollingCommands(graph, listing.automaticRefresh$);
  const peerState$ = command(
    (
      { get, set },
      owner: { readonly peer: SandboxChannelPeer; readonly runId: string },
      state: SandboxChannelState,
      error: unknown,
      signal: AbortSignal,
    ): void => {
      const { peer, runId } = owner;
      if (signal.aborted || runId !== get(currentRunId$)) {
        return;
      }
      if (state === "connecting" || state === "reconnecting") {
        set(graph.resetPolling$);
        set(navigation.remember$);
        set(graph.navigation$, null);
        set(graph.navigationFailure$, null);
        set(graph.directories$, new Map());
        set(graph.virtual.reset$);
        set(graph.limit$, false);
        const epoch = get(graph.epoch$) + 1;
        set(graph.epoch$, epoch);
        const sessionKey = get(graph.ownerKey$);
        if (!sessionKey || sessionKey !== get(authenticatedSessionKey$)) {
          return;
        }
        set(graph.connection$, { peer, epoch, sessionKey, runId });
        set(graph.phase$, "connecting");
      } else if (state === "ready") {
        if (get(graph.connection$)?.peer !== peer) {
          return;
        }
        set(graph.phase$, "ready");
        set(startPolling$, signal);
        detach(
          set(navigation.initialize$, signal),
          Reason.Daemon,
          "load the current sandbox directory for this epoch",
        );
      } else if (state === "failed" || state === "closed") {
        set(graph.resetPolling$);
        set(graph.navigation$, null);
        set(graph.navigationFailure$, null);
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
        runId !== get(currentRunId$) ||
        !get(graph.ownerKey$) ||
        get(graph.ownerKey$) !== get(authenticatedSessionKey$)
      ) {
        return;
      }
      const peer = createBrowserSandboxChannelPeer(runId, get(apiClient$), {
        categories: [sandboxFsCategory],
        onStateChange: (state, error) => {
          set(peerState$, { peer, runId }, state, error, signal);
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

function isTerminalRun(status: RunStatus | null): boolean {
  return (
    status !== null &&
    status !== "queued" &&
    status !== "pending" &&
    status !== "running"
  );
}

function createRunLifecycleCommands(
  graph: FilesGraph,
  startRun$: Command<void, [string, AbortSignal]>,
) {
  const resetRun$ = resetSignal();
  const started$ = state(false);
  const owned$ = command(({ get }, runId: string, signal: AbortSignal) => {
    return (
      !signal.aborted &&
      get(graph.mounted$) &&
      get(currentRunId$) === runId &&
      get(graph.targetRunId$) === runId &&
      get(graph.ownerKey$) === get(authenticatedSessionKey$)
    );
  });
  const stop$ = command(({ set }) => {
    set(graph.download.cancel$);
    set(graph.preview.close$);
    set(resetRun$);
    set(started$, false);
    set(graph.resetPolling$);
    set(graph.connection$, null);
    set(graph.navigation$, null);
    set(graph.navigationFailure$, null);
    set(graph.directories$, new Map());
    set(graph.limit$, false);
  });
  const load$ = command(
    async ({ get, set }, runId: string, signal: AbortSignal) => {
      if (!set(owned$, runId, signal) || isTerminalRun(get(graph.status$))) {
        return true;
      }
      const result = await accept(
        get(apiClient$)(runsByIdContract).getById({
          params: { id: runId },
          fetchOptions: { signal },
        }),
        [200],
        signal,
      );
      if (!set(owned$, runId, signal)) {
        return true;
      }
      if (result.body.runId !== runId) {
        throw new Error("Activity Files status returned a different Run");
      }
      const status = result.body.status;
      set(graph.status$, status);
      if (status === "running") {
        if (!get(started$)) {
          set(started$, true);
          set(startRun$, runId, set(resetRun$, signal));
        }
      } else {
        set(stop$);
      }
      return isTerminalRun(status);
    },
  );
  return { owned$, stop$, load$ };
}

function createRunObservationCommands(
  graph: FilesGraph,
  lifecycle: ReturnType<typeof createRunLifecycleCommands>,
) {
  const checking$ = state<number | null>(null);
  const version$ = state(0);
  const failed$ = state(false);
  const fail$ = command(({ set }, runId: string, signal: AbortSignal) => {
    if (!set(lifecycle.owned$, runId, signal)) {
      return;
    }
    set(lifecycle.stop$);
    set(graph.status$, null);
    set(graph.phase$, "unavailable");
    set(failed$, true);
  });
  const check$ = command(
    async (
      { get, set },
      runId: string,
      version: number,
      signal: AbortSignal,
    ) => {
      if (get(version$) !== version) {
        return true;
      }
      if (get(checking$) === version) {
        return false;
      }
      set(checking$, version);
      return await withCleanup(
        onRejection(set(lifecycle.load$, runId, signal), () => {
          set(fail$, runId, signal);
        }),
        () => {
          if (get(checking$) === version) {
            set(checking$, null);
          }
        },
      );
    },
  );
  const start$ = command(
    async ({ get, set }, runId: string, signal: AbortSignal) => {
      const version = get(version$) + 1;
      set(version$, version);
      set(failed$, false);
      const detail = await onRejection(get(activityDetail$), () => {
        set(fail$, runId, signal);
      });
      signal.throwIfAborted();
      if (!set(lifecycle.owned$, runId, signal) || get(failed$)) {
        return;
      }
      if (detail?.id === runId && isTerminalRun(detail.status)) {
        set(graph.status$, detail.status);
        return;
      }
      setLoop(
        async (loopSignal) => {
          if (get(failed$)) {
            return true;
          }
          return await set(check$, runId, version, loopSignal);
        },
        REFRESH_INTERVAL_MS,
        signal,
        {
          retryTransientErrors: false,
          testIntervalMs: REFRESH_INTERVAL_MS,
        },
      );
      document.addEventListener(
        "visibilitychange",
        onDomEventFn(async () => {
          if (!document.hidden && !get(failed$)) {
            await set(check$, runId, version, signal);
          }
        }),
        { signal },
      );
    },
  );
  return { start$, stop$: lifecycle.stop$ };
}

function createDemandCommands(
  graph: FilesGraph,
  startRun$: Command<void, [string, AbortSignal]>,
  rememberView$: Command<void, []>,
) {
  const section$ = state<HTMLElement | null>(null);
  const observation = createRunObservationCommands(
    graph,
    createRunLifecycleCommands(graph, startRun$),
  );
  const mount$ = onRef(
    command(({ get, set }, element: HTMLElement, signal: AbortSignal) => {
      const sessionKey = get(authenticatedSessionKey$);
      const runId = get(currentRunId$);
      if (!sessionKey || !runId) {
        return;
      }
      set(graph.virtual.scroll.attachSection$, element, signal);
      set(section$, element);
      set(graph.ownerKey$, sessionKey);
      const locationOwner = `${sessionKey}:${runId}`;
      if (get(graph.locationOwner$) !== locationOwner) {
        set(graph.locationOwner$, locationOwner);
        set(graph.location$, FILES_HOME_LOCATION);
        set(graph.preferences$, new Map());
        set(graph.navigationFailure$, null);
      }
      set(graph.targetRunId$, runId);
      set(graph.status$, null);
      set(graph.phase$, "connecting");
      const version = get(graph.mountVersion$) + 1;
      set(graph.mountVersion$, version);
      set(graph.mounted$, true);
      const owner = set(graph.resetDemand$, signal, get(pageSignal$));
      set(graph.download.installOwner$, owner);
      set(graph.preview.installOwner$, owner, element);
      signal.addEventListener(
        "abort",
        () => {
          if (get(graph.mountVersion$) !== version) {
            return;
          }
          set(rememberView$);
          set(graph.resetDemand$);
          set(observation.stop$);
          set(graph.mounted$, false);
          set(section$, null);
          set(graph.targetRunId$, null);
          set(graph.status$, null);
          set(graph.navigation$, null);
          set(graph.navigationFailure$, null);
          set(graph.directories$, new Map());
          if (sessionKey !== get(authenticatedSessionKey$)) {
            set(graph.location$, FILES_HOME_LOCATION);
            set(graph.preferences$, new Map());
            set(graph.locationOwner$, null);
          }
        },
        { once: true },
      );
      detach(
        set(observation.start$, runId, owner),
        Reason.Daemon,
        "visible Activity Files status",
      );
    }),
  );
  const retry$ = command(({ get, set }, signal: AbortSignal): void => {
    signal.throwIfAborted();
    if (get(graph.mounted$)) {
      const runId = get(graph.targetRunId$);
      if (runId) {
        set(observation.stop$);
        set(graph.status$, null);
        set(graph.phase$, "connecting");
        const owner = set(graph.resetDemand$, signal, get(pageSignal$));
        set(graph.download.installOwner$, owner);
        set(graph.preview.installOwner$, owner, get(section$));
        detach(
          set(observation.start$, runId, owner),
          Reason.Daemon,
          "retry Activity Files status",
        );
      }
    }
  });
  return { mount$, retry$ };
}

function createFilesReadCommand(
  graph: FilesGraph,
  mode: "download" | "preview",
) {
  return command(
    async (
      { get, set },
      target: {
        readonly origin: FilesLocation;
        readonly path: readonly string[];
        readonly nameToken: string;
        readonly trigger?: HTMLElement;
      },
      signal: AbortSignal,
    ): Promise<void> => {
      signal.throwIfAborted();
      const { origin, path, nameToken, trigger } = target;
      const connection = get(graph.connection$);
      if (
        !connection ||
        !get(graph.mounted$) ||
        get(graph.phase$) !== "ready" ||
        get(graph.navigation$) ||
        connection.runId !== get(currentRunId$) ||
        connection.sessionKey !== get(authenticatedSessionKey$) ||
        filesDirectoryKey(filesLocationTokens(origin)) !==
          filesDirectoryKey(filesLocationTokens(get(graph.location$)))
      ) {
        return;
      }
      const entry = get(graph.directories$)
        .get(filesDirectoryKey(path))
        ?.entries.find((candidate) => {
          return candidate.nameToken === nameToken && candidate.kind === "file";
        });
      if (!entry) {
        return;
      }
      const request = {
        runId: connection.runId,
        sessionKey: connection.sessionKey,
        path: [...filesLocationTokens(origin), ...path, nameToken],
        name: entry.displayName,
      };
      if (mode === "preview") {
        await set(graph.preview.open$, request, trigger, signal);
      } else {
        await set(graph.download.start$, request, signal);
      }
    },
  );
}

function createFilesActions(
  graph: FilesGraph,
  listing: ListingCommands,
  navigation: NavigationCommands,
) {
  const download$ = createFilesReadCommand(graph, "download");
  const preview$ = createFilesReadCommand(graph, "preview");
  const refreshRequest$ = state<{ readonly connection: Connection } | null>(
    null,
  );
  const toggle$ = command(
    async (
      { get, set },
      path: readonly string[],
      signal: AbortSignal,
    ): Promise<void> => {
      if (get(graph.navigation$)) {
        return;
      }
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
      const failedNavigation = get(graph.navigationFailure$);
      if (failedNavigation) {
        await set(navigation.navigate$, failedNavigation.location, signal);
        return;
      }
      const connection = get(graph.connection$);
      const location = get(graph.location$);
      await set(listing.discard$, path, signal);
      signal.throwIfAborted();
      if (
        connection &&
        connection === get(graph.connection$) &&
        location === get(graph.location$) &&
        !get(graph.navigation$) &&
        !get(graph.navigationFailure$)
      ) {
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
      get(graph.navigation$)?.connection === get(graph.connection$) ||
      get(graph.directoriesView$).get(filesDirectoryKey([]))?.loading ===
        true ||
      (request !== null && request.connection === get(graph.connection$))
    );
  });
  const more$ = command(
    ({ get, set }, path: readonly string[], signal: AbortSignal) => {
      if (get(graph.navigation$)) {
        return Promise.resolve();
      }
      return set(listing.load$, path, true, signal);
    },
  );
  return { toggle$, refresh$, refreshing$, more$, download$, preview$ };
}

/** Construct the Activity graph without network work; its visible ref owns demand. */
function createSandboxFilesSignals() {
  const graph = createFilesGraph();
  const cursors = createCursorCommands(graph);
  const listing = createListingCommands(graph, cursors);
  const navigation = createNavigationCommands(graph, listing, cursors);
  const connection = createConnectionCommands(graph, listing, navigation);
  return {
    download: graph.download,
    preview: graph.preview,
    ...createDemandCommands(graph, connection.startRun$, navigation.remember$),
    ...createFilesActions(graph, listing, navigation),
    enter$: navigation.enter$,
    navigate$: navigation.navigate$,
    location$: computed((get) => {
      return get(graph.location$);
    }),
    navigating$: computed((get) => {
      const request = get(graph.navigation$);
      return request !== null && request.connection === get(graph.connection$);
    }),
    activeRunId$: graph.activeRunId$,
    pending$: graph.pending$,
    virtual: graph.virtual,
    phase$: computed((get) => {
      return get(graph.phase$);
    }),
    failure$: computed((get): FilesFailure | null => {
      const navigationFailure = get(graph.navigationFailure$);
      if (navigationFailure) {
        return { path: [], ...navigationFailure };
      }
      if (get(graph.navigation$)) {
        return null;
      }
      for (const directory of get(graph.directories$).values()) {
        if (directory.error) {
          return { path: directory.path, error: directory.error };
        }
      }
      return get(graph.limit$) ? { path: [], error: "limit" } : null;
    }),
  };
}
export type SandboxFilesSignals = ReturnType<typeof createSandboxFilesSignals>;
export const activityFiles = createSandboxFilesSignals();
