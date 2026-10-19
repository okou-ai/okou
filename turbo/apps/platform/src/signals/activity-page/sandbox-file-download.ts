import { command, computed, state } from "ccstate";
import type { SandboxChannelPeer } from "@okouai/core/sandbox-channel-peer";
import {
  sandboxFsCategory,
  sandboxFsOpen,
  sandboxFsRead,
  sandboxFsFinish,
  SANDBOX_FS_LIMITS,
} from "@okouai/api-contracts/contracts/sandbox-channel-fs";
import { SandboxChannelError } from "@okouai/api-contracts/contracts/sandbox-channel";
import { toast } from "@okouai/ui/components/ui/sonner";
import { i18n } from "../../i18n/index.ts";
import { createBrowserSandboxChannelPeer } from "../../lib/sandbox-channel-peer.ts";
import {
  canStreamSandboxDownload,
  downloadWorker,
  FileDownloadError,
  SandboxFileDownload,
} from "../../lib/sandbox-file-download.ts";
import { apiClient$ } from "../api-client.ts";
import { authenticatedSessionKey$ } from "../auth.ts";
import { onRejection, resetSignal, tapError, withCleanup } from "../utils.ts";
import { currentRunId$ } from "./activity-signals.ts";

interface DownloadRequest {
  readonly runId: string;
  readonly sessionKey: string;
  readonly path: readonly string[];
  readonly name: string;
}
interface DownloadJob extends DownloadRequest {
  readonly generation: number;
}
interface DownloadSource {
  readonly peer: SandboxChannelPeer;
  bridge: SandboxFileDownload | null;
  complete: boolean;
}

function failureMessage(error: unknown): string {
  if (error instanceof SandboxChannelError) {
    if (error.code === "file_changed") {
      return i18n.t(($) => {
        return $.activity.detail.files.downloadChanged;
      });
    }
    if (
      [
        "unsupported_category",
        "category_version_mismatch",
        "unknown_operation",
        "unsupported_schema",
      ].includes(error.code)
    ) {
      return i18n.t(($) => {
        return $.activity.detail.files.downloadUpdateRequired;
      });
    }
  }
  if (error instanceof FileDownloadError && error.code === "updateRequired") {
    return i18n.t(($) => {
      return $.activity.detail.files.downloadUpdateRequired;
    });
  }
  return i18n.t(($) => {
    return $.activity.detail.files.downloadFailed;
  });
}

function createDownloadGraph() {
  const mounted$ = state(false);
  const generation$ = state(0);
  const identity$ = state<{
    readonly runId: string | null;
    readonly sessionKey: string | null;
  } | null>(null);
  const job$ = state<DownloadJob | null>(null);
  const url$ = state<string | null>(null);
  const reset$ = resetSignal();
  const owned$ = command(({ get }, job: DownloadJob) => {
    return (
      get(job$) === job &&
      get(generation$) === job.generation &&
      get(mounted$) &&
      get(currentRunId$) === job.runId &&
      get(authenticatedSessionKey$) === job.sessionKey
    );
  });
  const check$ = command(({ set }, job: DownloadJob, signal: AbortSignal) => {
    signal.throwIfAborted();
    if (!set(owned$, job)) {
      throw new DOMException("Stale file download", "AbortError");
    }
  });
  return {
    mounted$,
    generation$,
    identity$,
    job$,
    url$,
    reset$,
    owned$,
    check$,
  };
}
type DownloadGraph = ReturnType<typeof createDownloadGraph>;

function downloadChunkLength(size: bigint, offset: bigint): number {
  const remaining = size - offset;
  return remaining > BigInt(SANDBOX_FS_LIMITS.maxChunkBytes)
    ? SANDBOX_FS_LIMITS.maxChunkBytes
    : Number(remaining);
}

function createStreamCommand(graph: DownloadGraph) {
  return command(
    async (
      { set },
      job: DownloadJob,
      source: DownloadSource,
      signal: AbortSignal,
    ) => {
      set(graph.check$, job, signal);
      const worker = await downloadWorker(signal);
      set(graph.check$, job, signal);
      await source.peer.connect(signal);
      set(graph.check$, job, signal);
      const opened = await source.peer.call(
        sandboxFsOpen,
        { path: [...job.path], mode: "download" },
        signal,
      );
      set(graph.check$, job, signal);
      if (
        opened.truncated ||
        opened.fileSize !== opened.selectedSize ||
        opened.nameToken !== job.path.at(-1)
      ) {
        throw new FileDownloadError("unavailable");
      }
      const size = BigInt(opened.fileSize);
      if (size === 0n) {
        await source.peer.call(
          sandboxFsFinish,
          { handle: opened.handle },
          signal,
        );
        signal.throwIfAborted();
      }
      set(graph.check$, job, signal);
      if (source.peer.state !== "ready") {
        throw new FileDownloadError("unavailable");
      }
      const bridge = new SandboxFileDownload(source.peer, signal);
      source.bridge = bridge;
      const url = await bridge.prepare(worker, opened.fileSize, job.name);
      signal.throwIfAborted();
      set(graph.check$, job, signal);
      source.complete = size === 0n;
      set(graph.url$, url);
      let offset = 0n;
      while (offset < size) {
        const message = await bridge.next();
        signal.throwIfAborted();
        set(graph.check$, job, signal);
        const length = downloadChunkLength(size, offset);
        if (
          message.type !== "pull" ||
          message.offset !== offset.toString() ||
          message.length !== length ||
          !length
        ) {
          throw new FileDownloadError("unavailable");
        }
        const result = await source.peer.call(
          sandboxFsRead,
          { handle: opened.handle, offset: offset.toString(), length },
          signal,
        );
        set(graph.check$, job, signal);
        if (result.offset !== offset.toString() || result.length !== length) {
          throw new FileDownloadError("unavailable");
        }
        const decoded = atob(result.data);
        const bytes = new Uint8Array(decoded.length);
        for (let index = 0; index < decoded.length; index++) {
          bytes[index] = decoded.charCodeAt(index);
        }
        const next = offset + BigInt(length);
        const final = next === size;
        if (final) {
          await source.peer.call(
            sandboxFsFinish,
            { handle: opened.handle },
            signal,
          );
          signal.throwIfAborted();
        }
        set(graph.check$, job, signal);
        // MessagePort traffic alone lets Firefox retire an actively streaming
        // worker. A real chunk also dispatches a worker event; its no-port
        // message grants no authority and does not reset the worker idle timer.
        worker.postMessage({ type: "progress", id: bridge.id });
        bridge.chunk(offset.toString(), bytes, final);
        source.complete = final;
        offset = next;
      }
      const completion = await bridge.next();
      signal.throwIfAborted();
      set(graph.check$, job, signal);
      if (
        completion.type !== "complete" ||
        !source.complete ||
        offset !== size
      ) {
        throw new FileDownloadError("unavailable");
      }
    },
  );
}

function createTransferCommand(graph: DownloadGraph) {
  const stream$ = createStreamCommand(graph);
  return command(
    async ({ get, set }, job: DownloadJob, signal: AbortSignal) => {
      const source: DownloadSource = {
        bridge: null,
        complete: false,
        peer: createBrowserSandboxChannelPeer(job.runId, get(apiClient$), {
          categories: [sandboxFsCategory],
          onStateChange: (phase) => {
            if (
              !source.complete &&
              ["reconnecting", "failed", "closed"].includes(phase)
            ) {
              source.bridge?.fail(new FileDownloadError("unavailable"));
              if (phase === "reconnecting") {
                source.peer.close();
              }
            }
          },
        }),
      };
      await withCleanup(
        tapError(
          onRejection(set(stream$, job, source, signal), (error) => {
            if (set(graph.owned$, job)) {
              set(graph.url$, null);
              const failure = source.bridge?.failure ?? error;
              if (
                !signal.aborted &&
                !(
                  failure instanceof FileDownloadError &&
                  failure.code === "cancelled"
                )
              ) {
                toast.error(failureMessage(failure));
              }
            }
          }),
        ),
        () => {
          source.bridge?.close();
          source.peer.close();
        },
      );
    },
  );
}

export function createSandboxFileDownloadSignals() {
  const graph = createDownloadGraph();
  const perform$ = createTransferCommand(graph);
  const cancel$ = command(({ set }) => {
    set(graph.reset$);
    set(graph.url$, null);
  });
  const installOwner$ = command(({ get, set }, signal: AbortSignal) => {
    signal.throwIfAborted();
    set(cancel$);
    const generation = get(graph.generation$) + 1;
    set(graph.generation$, generation);
    set(graph.mounted$, true);
    set(graph.identity$, {
      runId: get(currentRunId$),
      sessionKey: get(authenticatedSessionKey$),
    });
    signal.addEventListener(
      "abort",
      () => {
        if (get(graph.generation$) === generation) {
          set(graph.mounted$, false);
          set(graph.identity$, null);
          set(cancel$);
        }
      },
      { once: true },
    );
  });
  const start$ = command(
    async (
      { get, set },
      request: DownloadRequest,
      signal: AbortSignal,
    ): Promise<void> => {
      signal.throwIfAborted();
      if (get(graph.job$) || !get(graph.mounted$)) {
        return;
      }
      if (!canStreamSandboxDownload()) {
        toast.error(
          i18n.t(($) => {
            return $.activity.detail.files.downloadUnsupported;
          }),
        );
        return;
      }
      const job: DownloadJob = {
        ...request,
        generation: get(graph.generation$),
      };
      set(graph.job$, job);
      set(graph.url$, null);
      const transfer = set(graph.reset$, signal);
      await withCleanup(set(perform$, job, transfer), () => {
        if (get(graph.job$) === job) {
          set(graph.job$, null);
        }
      });
    },
  );
  const current$ = computed((get) => {
    const identity = get(graph.identity$);
    const job = get(graph.job$);
    if (
      !get(graph.mounted$) ||
      !identity ||
      identity.runId !== get(currentRunId$) ||
      identity.sessionKey !== get(authenticatedSessionKey$) ||
      (job &&
        (get(graph.generation$) !== job.generation ||
          job.runId !== get(currentRunId$) ||
          job.sessionKey !== get(authenticatedSessionKey$)))
    ) {
      return false;
    }
    return true;
  });
  return {
    installOwner$,
    start$,
    cancel$,
    busy$: computed((get) => {
      return get(graph.job$) !== null;
    }),
    preparingPath$: computed((get) => {
      return get(current$) && !get(graph.url$)
        ? (get(graph.job$)?.path ?? null)
        : null;
    }),
    url$: computed((get) => {
      return get(current$) ? get(graph.url$) : null;
    }),
  };
}

export type SandboxFileDownloadSignals = ReturnType<
  typeof createSandboxFileDownloadSignals
>;
