import "./polyfill.ts";
import { createStore } from "ccstate";
import { createDebugLoggers } from "./lib/debug-loggers.ts";
import { logger } from "./signals/log.ts";
import { SharedDatabaseMessagePortServer } from "./shared-database/message-port-server.ts";
import { initSharedDatabaseWorkerSentry } from "./shared-database/worker-sentry.ts";
import { requestTokenFromTabs$ } from "./shared-database/worker-context.ts";
import { bootstrapWorker$ } from "./shared-database/worker-signals.ts";
import type { DebugLoggers } from "./types/global-method.ts";

const L = logger("SharedDatabaseWorker");

interface SharedWorkerConnectEvent extends Event {
  readonly ports: readonly MessagePort[];
}

interface SharedWorkerOkouState {
  readonly loggers: DebugLoggers;
}

interface SharedWorkerGlobal {
  _okou: SharedWorkerOkouState | undefined;
  addEventListener(
    type: "connect",
    listener: (event: SharedWorkerConnectEvent) => void,
  ): void;
}

const workerGlobal = globalThis as typeof globalThis & SharedWorkerGlobal;

function main(): void {
  initSharedDatabaseWorkerSentry();
  workerGlobal._okou = {
    get loggers() {
      return createDebugLoggers();
    },
  };

  // SharedWorker termination tears down the whole global without an observable
  // abort hook, so this signal stays live for the lifetime of the Worker.
  const workerSignal = AbortSignal.any([]);
  const store = createStore();
  store.set(
    bootstrapWorker$,
    (signal) => {
      return store.set(requestTokenFromTabs$, signal);
    },
    workerSignal,
  );
  L.debug("worker.bootstrap");
  workerGlobal.addEventListener("connect", (event): void => {
    L.debug("worker.connect", { portCount: event.ports.length });
    for (const port of event.ports) {
      new SharedDatabaseMessagePortServer(store, port, workerSignal);
    }
  });
}

main();
