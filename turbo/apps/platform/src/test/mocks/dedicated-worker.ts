import { detach, Reason } from "../../signals/utils.ts";

/** Browser transport boundary; page tests still run the real export command. */
export function mockDedicatedWorker(
  respond: (message: unknown) => Promise<unknown>,
  signal: AbortSignal,
): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  class DedicatedWorkerMock extends EventTarget {
    private terminated = false;

    postMessage(message: unknown): void {
      detach(
        this.deliver(message),
        Reason.DomCallback,
        "mock dedicated worker response",
      );
    }

    private async deliver(message: unknown): Promise<void> {
      const data = await respond(message);
      if (!this.terminated && !signal.aborted) {
        this.dispatchEvent(new MessageEvent("message", { data }));
      }
    }

    terminate(): void {
      this.terminated = true;
    }
  }
  Object.defineProperty(globalThis, "Worker", {
    configurable: true,
    writable: true,
    value: DedicatedWorkerMock,
  });
  return () => {
    if (descriptor) {
      Object.defineProperty(globalThis, "Worker", descriptor);
    } else {
      Reflect.deleteProperty(globalThis, "Worker");
    }
  };
}
