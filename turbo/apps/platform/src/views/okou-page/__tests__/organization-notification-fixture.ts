import { vi } from "vitest";
import type { TestContext } from "../../../signals/__tests__/test-helpers.ts";
import type { SharedDatabaseWorkerMessage } from "../../../shared-database/protocol.ts";

/** Wait for a provider notification to arrive at the tab's real message port. */
export function observeOrganizationNotification(
  context: TestContext,
  name: string,
  orgId: string,
) {
  const delivered = context.mocks.deferred<void>();
  const NativeChannel = MessageChannel;
  vi.stubGlobal(
    "MessageChannel",
    class extends NativeChannel {
      constructor() {
        super();
        const receive = (event: MessageEvent<SharedDatabaseWorkerMessage>) => {
          const message = event.data;
          if (
            message.type !== "realtime-event" ||
            message.message.name !== name
          ) {
            return;
          }
          const data = message.message.data;
          if (
            typeof data === "object" &&
            data !== null &&
            "orgId" in data &&
            data.orgId === orgId &&
            !delivered.settled()
          ) {
            delivered.resolve();
          }
        };
        this.port2.addEventListener("message", receive);
        context.signal.addEventListener(
          "abort",
          () => {
            return this.port2.removeEventListener("message", receive);
          },
          { once: true },
        );
      }
    },
  );
  return delivered.promise;
}
