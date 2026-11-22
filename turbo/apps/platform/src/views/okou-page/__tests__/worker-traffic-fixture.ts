import { vi } from "vitest";
import {
  sharedDatabaseClientMessageSchema,
  sharedDatabaseWorkerMessageSchema,
} from "../../../shared-database/protocol.ts";

/** Observe both endpoints of each real channel, keeping native delivery and teardown. */
export function observeWorkerTraffic(signal: AbortSignal) {
  const NativeChannel = MessageChannel;
  const delivered: unknown[] = [];
  const endpoints: (() => unknown[])[] = [];
  vi.stubGlobal(
    "MessageChannel",
    class extends NativeChannel {
      constructor() {
        super();
        for (const port of [this.port1, this.port2]) {
          port.addEventListener(
            "message",
            (event) => {
              delivered.push(event.data);
            },
            { signal },
          );
          const observed = vi.spyOn(port, "postMessage");
          endpoints.push(() => {
            return observed.mock.calls.map(([raw]) => {
              return raw;
            });
          });
        }
      }
    },
  );
  const messages = () => {
    return endpoints.flatMap((read) => {
      return read();
    });
  };
  return {
    received: () => {
      return delivered.flatMap((raw) => {
        const { data } = sharedDatabaseWorkerMessageSchema.safeParse(raw);
        return data ? [data] : [];
      });
    },
    requests: () => {
      return messages().flatMap((raw) => {
        const { data } = sharedDatabaseClientMessageSchema.safeParse(raw);
        return data ? [data] : [];
      });
    },
  };
}
