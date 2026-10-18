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
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { createBrowserSandboxChannelPeer } from "../../lib/sandbox-channel-peer.ts";
import { now } from "../../lib/time.ts";
import {
  canStreamSandboxDownload,
  downloadWorker,
  FileDownloadError,
  SandboxFileDownload,
} from "../../lib/sandbox-file-download.ts";
import { apiClient$ } from "../api-client.ts";
import { authenticatedSessionKey$ } from "../auth.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { onRejection, resetSignal, tapError, withCleanup } from "../utils.ts";
import { currentRunId$ } from "./activity-signals.ts";

type Phase =
  | "starting"
  | "streaming"
  | "cancelling"
  | "complete"
  | "cancelled"
  | "changed"
  | "updateRequired"
  | "failed";
interface FileDownloadView {
  readonly name: string;
  readonly phase: Phase;
  readonly received: string;
  readonly total: string;
  readonly url: string | null;
}
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
  handedOff: boolean;
}

function failurePhase(error: unknown): Phase {
  if (error instanceof FileDownloadError) {
    return error.code === "cancelled"
      ? "cancelled"
      : error.code === "updateRequired"
        ? "updateRequired"
        : "failed";
  }
  if (error instanceof SandboxChannelError) {
    if (error.code === "file_changed") {
      return "changed";
    }
    if (
      [
        "unsupported_category",
        "category_version_mismatch",
        "unknown_operation",
        "unsupported_schema",
      ].includes(error.code)
    ) {
      return "updateRequired";
    }
  }
  return "failed";
}

function createDownloadGraph() {
  const mounted$ = state(false);
  const generation$ = state(0);
  const identity$ = state<{
    readonly runId: string | null;
    readonly sessionKey: string | null;
  } | null>(null);
  const job$ = state<DownloadJob | null>(null);
  const view$ = state<FileDownloadView | null>(null);
  const reset$ = resetSignal();
  const owned$ = command(({ get }, job: DownloadJob) => {
    return (
      get(job$) === job &&
      get(generation$) === job.generation &&
      get(mounted$) &&
      get(currentRunId$) === job.runId &&
      get(authenticatedSessionKey$) === job.sessionKey &&
      get(featureSwitch$)[FeatureSwitchKey.OkouDebug]
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
    view$,
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
      const publish = (received: bigint, phase: Phase) => {
        set(graph.view$, {
          name: job.name,
          phase,
          received: received.toString(),
          total: opened.fileSize,
          url,
        });
      };
      publish(0n, "streaming");
      let offset = 0n;
      let progressPublishedAt = -Infinity;
      for (;;) {
        const message = await bridge.next();
        signal.throwIfAborted();
        set(graph.check$, job, signal);
        if (message.type === "complete") {
          if (!source.complete || offset !== size) {
            throw new FileDownloadError("unavailable");
          }
          source.handedOff = true;
          publish(size, "complete");
          return;
        }
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
        const bytes = Uint8Array.from(atob(result.data), (char) => {
          return char.charCodeAt(0);
        });
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
        worker.postMessage({ type: "progress", version: 1, id: bridge.id });
        bridge.chunk(offset.toString(), bytes, final);
        source.complete = final;
        source.handedOff = final;
        offset = next;
        const timestamp = now();
        if (final || timestamp - progressPublishedAt >= 100) {
          progressPublishedAt = timestamp;
          publish(offset, final ? "complete" : "streaming");
        }
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
        handedOff: false,
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
              const previous = get(graph.view$);
              if (!previous) {
                throw new Error("Active file download has no view");
              }
              set(graph.view$, {
                ...previous,
                url: null,
                phase: signal.aborted
                  ? source.handedOff
                    ? "complete"
                    : "cancelled"
                  : failurePhase(source.bridge?.failure ?? error),
              });
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
  const cancel$ = command(({ get, set }) => {
    const view = get(graph.view$);
    // Final bytes have been accepted; the browser owns their physical saving.
    if (view?.phase === "complete") {
      return;
    }
    if (get(graph.job$) && view) {
      set(graph.view$, { ...view, phase: "cancelling" });
    }
    set(graph.reset$);
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
    set(graph.view$, null);
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
      if (
        get(graph.job$) ||
        !get(graph.mounted$) ||
        !canStreamSandboxDownload()
      ) {
        return;
      }
      const job: DownloadJob = {
        ...request,
        generation: get(graph.generation$),
      };
      set(graph.job$, job);
      set(graph.view$, {
        name: request.name,
        phase: "starting",
        received: "0",
        total: "0",
        url: null,
      });
      const transfer = set(graph.reset$, signal);
      await withCleanup(set(perform$, job, transfer), () => {
        if (get(graph.job$) === job) {
          set(graph.job$, null);
        }
      });
    },
  );
  return {
    installOwner$,
    start$,
    cancel$,
    available$: computed(() => {
      return canStreamSandboxDownload();
    }),
    busy$: computed((get) => {
      return get(graph.job$) !== null;
    }),
    view$: computed((get) => {
      const identity = get(graph.identity$);
      const job = get(graph.job$);
      if (
        !get(graph.mounted$) ||
        !identity ||
        identity.runId !== get(currentRunId$) ||
        identity.sessionKey !== get(authenticatedSessionKey$) ||
        !get(featureSwitch$)[FeatureSwitchKey.OkouDebug] ||
        (job &&
          (get(graph.generation$) !== job.generation ||
            job.runId !== get(currentRunId$) ||
            job.sessionKey !== get(authenticatedSessionKey$)))
      ) {
        return null;
      }
      return get(graph.view$);
    }),
  };
}

export type SandboxFileDownloadSignals = ReturnType<
  typeof createSandboxFileDownloadSignals
>;
