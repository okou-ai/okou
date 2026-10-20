import { serve } from "@hono/node-server";
import { on, once } from "node:events";
import { watch } from "node:fs";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { http, passthrough } from "msw";
import { z } from "zod";

import type { TestContext } from "../../../../__tests__/test-context";
import { createAppWithRoutes } from "../../../../app-factory-core";
import { server } from "../../../../mocks/server";
import { runnersRoutes } from "../../runners";
import { webhooksAgentCompleteRoutes } from "../../webhooks-agent-complete";
import { webhooksAgentEventsRoutes } from "../../webhooks-agent-events";
import { webhooksAgentHealthUsageTelemetryRoutes } from "../../webhooks-agent-health-usage-telemetry";
import {
  createDeferredPromise,
  isAbortError,
  settleIncludingAbort,
} from "../../../utils";

export interface NativeClaimCase {
  readonly runId: string;
  readonly controlDirectory: string;
  readonly runnerIds: readonly [string, string];
  readonly first: "a" | "b" | "both";
}

interface ClaimReceipt {
  readonly runId: string;
  readonly runnerId: string;
  readonly path: string;
  readonly authorization: string | null;
  readonly body: unknown;
  readonly enteredNs: string;
  forwardedNs?: string;
  completedNs?: string;
  status?: number;
  response?: unknown;
  running?: unknown;
  runningObservedNs?: string;
}

const claimantSchema = z.object({
  runnerIdentity: z.object({ runnerId: z.uuid() }),
});

async function regularFile(path: string): Promise<boolean> {
  const result = await settleIncludingAbort(lstat(path));
  if (result.ok) {
    const entry = result.value;
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new Error("Native claim readiness must be an owned regular file");
    }
    return true;
  }
  const error = result.error;
  if (error instanceof Error && "code" in error && error.code === "ENOENT") {
    return false;
  }
  throw error;
}

/** Transport controls delay requests, never choose an application response. */
function claimGate(
  input: NativeClaimCase,
  signal: AbortSignal,
  observeWinner?: (runId: string) => Promise<unknown>,
) {
  const entered = createDeferredPromise<void>(signal);
  const ready = createDeferredPromise<void>(signal);
  const firstFinished = createDeferredPromise<void>(signal);
  const resolve = (gate: ReturnType<typeof createDeferredPromise<void>>) => {
    if (!gate.settled()) {
      gate.resolve();
    }
  };
  // Deferred rejections remain joined even if construction or an earlier gate fails.
  const deferred = Promise.allSettled([
    entered.promise,
    ready.promise,
    firstFinished.promise,
  ]);
  const arrivals = new Set<string>();
  const receipts: ClaimReceipt[] = [];
  // Subscribe before reading readiness so a change during that read is queued.
  const watcher = watch(input.controlDirectory, { signal });
  const events = on(watcher, "change", { signal });
  const observe = async () => {
    if (await regularFile(join(input.controlDirectory, "failed.ready"))) {
      resolve(entered);
      resolve(firstFinished);
      return true;
    }
    return (
      (await regularFile(join(input.controlDirectory, "a.ready"))) &&
      (await regularFile(join(input.controlDirectory, "b.ready")))
    );
  };
  const monitor = (async () => {
    const observed = await settleIncludingAbort(async () => {
      if (await observe()) {
        resolve(ready);
        return;
      }
      for await (const _event of events) {
        if (await observe()) {
          resolve(ready);
          return;
        }
      }
    });
    await events.return?.();
    watcher.close();
    if (!observed.ok && !isAbortError(observed.error)) {
      throw observed.error;
    }
  })();
  // Failure/teardown releases observers so the listener can drain accepted work.
  const released = () => {
    resolve(ready);
    resolve(entered);
    resolve(firstFinished);
  };
  signal.addEventListener("abort", released, { once: true });
  return {
    receipts,
    monitor,
    deferred,
    entered: entered.promise,
    async forward(request: Request, dispatch: () => Promise<Response>) {
      const body: unknown = await request.clone().json();
      const parsed = claimantSchema.safeParse(body);
      if (!parsed.success) {
        return dispatch();
      }
      const runnerId = parsed.data.runnerIdentity.runnerId;
      const index = input.runnerIds.indexOf(runnerId);
      if (index === -1) {
        return dispatch();
      }
      if (arrivals.has(runnerId)) {
        throw new Error("Native claimant submitted its claim more than once");
      }
      arrivals.add(runnerId);
      const receipt: ClaimReceipt = {
        runId: input.runId,
        runnerId,
        path: new URL(request.url).pathname,
        authorization: request.headers.get("authorization"),
        body,
        enteredNs: process.hrtime.bigint().toString(),
      };
      receipts.push(receipt);
      if (arrivals.size === 2) {
        resolve(entered);
      }
      await Promise.all([entered.promise, ready.promise]);
      signal.throwIfAborted();
      const role = index === 0 ? "a" : "b";
      if (input.first !== "both" && input.first !== role) {
        await firstFinished.promise;
        signal.throwIfAborted();
      }
      receipt.forwardedNs = process.hrtime.bigint().toString();
      const result = await settleIncludingAbort(async () => {
        const response = await dispatch();
        receipt.status = response.status;
        receipt.response = await response.clone().json();
        if (response.status === 200 && observeWinner) {
          receipt.running = await observeWinner(input.runId);
          receipt.runningObservedNs = process.hrtime.bigint().toString();
        }
        receipt.completedNs = process.hrtime.bigint().toString();
        return response;
      });
      if (input.first === role) {
        resolve(firstFinished);
      }
      if (!result.ok) {
        throw result.error;
      }
      return result.value;
    },
  };
}

/** A fixture-owned listener for the existing production Runner/callback routes. */
export async function startNativeClaimApi(
  context: TestContext,
  cases: readonly NativeClaimCase[],
  observeWinner?: (runId: string) => Promise<unknown>,
) {
  const stop = new AbortController();
  const signal = AbortSignal.any([context.signal, stop.signal]);
  const failures: unknown[] = [];
  const gates = new Map<string, ReturnType<typeof claimGate>>();
  const constructed = await settleIncludingAbort(() => {
    for (const entry of cases) {
      if (gates.has(entry.runId)) {
        throw new Error("Duplicate native API claim case");
      }
      const gate = claimGate(entry, signal, observeWinner);
      gates.set(entry.runId, gate);
      void gate.monitor.catch((error: unknown) => {
        failures.push(error);
        stop.abort();
      });
    }
  });
  if (!constructed.ok) {
    stop.abort();
    await Promise.allSettled(
      [...gates.values()].flatMap((gate) => {
        return [gate.monitor, gate.deferred];
      }),
    );
    throw constructed.error;
  }
  const accepted = new Set<Promise<Response>>();
  let listener: ReturnType<typeof serve> | undefined;
  const listening = await settleIncludingAbort(
    (async () => {
      const app = createAppWithRoutes({
        signal,
        routes: [
          ...runnersRoutes,
          ...webhooksAgentCompleteRoutes,
          ...webhooksAgentEventsRoutes,
          ...webhooksAgentHealthUsageTelemetryRoutes,
        ],
      });
      listener = serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request) {
          const path = new URL(request.url).pathname;
          const gate = cases.find((entry) => {
            return path === `/api/runners/jobs/${entry.runId}/claim`;
          });
          const dispatch = async () => {
            return await app.request(request);
          };
          const work =
            request.method === "POST" && gate
              ? (gates.get(gate.runId)?.forward(request, dispatch) ??
                dispatch())
              : dispatch();
          accepted.add(work);
          void work.then(
            () => {
              accepted.delete(work);
            },
            (error: unknown) => {
              accepted.delete(work);
              failures.push(error);
            },
          );
          return work;
        },
      });
      if (!listener.listening) {
        await once(listener, "listening", { signal });
      }
      const address = listener.address();
      if (!address || typeof address === "string") {
        throw new Error("Native API fixture did not bind a TCP listener");
      }
      const url = `http://127.0.0.1:${address.port}`;
      server.use(
        http.all(`${url}/*`, () => {
          return passthrough();
        }),
      );
      return { listener, url };
    })(),
  );
  if (!listening.ok) {
    stop.abort();
    const joined = await Promise.allSettled([
      ...(listener?.listening
        ? [promisify(listener.close.bind(listener))()]
        : []),
      ...accepted,
      ...[...gates.values()].flatMap((gate) => {
        return [gate.monitor, gate.deferred];
      }),
    ]);
    throw new AggregateError(
      [
        listening.error,
        ...joined.flatMap((result) => {
          return result.status === "rejected" ? [result.reason] : [];
        }),
      ],
      "Native API fixture setup failed",
    );
  }
  const live = listening.value;
  return {
    url: live.url,
    async waitForClaims(runId: string) {
      const gate = gates.get(runId);
      if (!gate) {
        throw new Error("Unknown native claim case");
      }
      await gate.entered;
    },
    receipts() {
      return [...gates.values()].flatMap((gate) => {
        return gate.receipts;
      });
    },
    async finish() {
      stop.abort();
      const joined = await Promise.allSettled([
        promisify(live.listener.close.bind(live.listener))(),
        ...accepted,
        ...[...gates.values()].flatMap((gate) => {
          return [gate.monitor, gate.deferred];
        }),
      ]);
      for (const result of joined) {
        if (result.status === "rejected") {
          failures.push(result.reason);
        }
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, "Native API fixture failed");
      }
    },
  };
}
