import { describe, expect, it } from "vitest";
import {
  CLIENT_REQUEST_ID_HEADER,
  CLIENT_SESSION_ID_HEADER,
  CLIENT_TYPE_DESKTOP,
  CLIENT_TYPE_HEADER,
  CLIENT_VERSION_HEADER,
} from "@okouai/api-contracts/contracts/client-headers";
import { createDesktopClientHeaderInjector } from "./desktop-client-headers";

function uuidSequence(...values: readonly string[]): () => string {
  let index = 0;
  return () => {
    const value = values[index];
    index += 1;
    if (!value) {
      throw new Error("UUID sequence exhausted");
    }
    return value;
  };
}

describe("createDesktopClientHeaderInjector", () => {
  it("adds desktop client headers with a stable session id and per-request ids", () => {
    const addClientHeaders = createDesktopClientHeaderInjector({
      clientVersion: "1.2.3",
      createUuid: uuidSequence("session-id", "request-id-1", "request-id-2"),
    });
    const first = new Headers([
      [CLIENT_VERSION_HEADER, "caller-version"],
      [CLIENT_TYPE_HEADER, "caller-type"],
      [CLIENT_SESSION_ID_HEADER, "caller-session-id"],
      [CLIENT_REQUEST_ID_HEADER, "caller-request-id"],
    ]);
    const second = new Headers();

    addClientHeaders(first);
    addClientHeaders(second);

    expect(first.get(CLIENT_VERSION_HEADER)).toBe("1.2.3");
    expect(first.get(CLIENT_TYPE_HEADER)).toBe(CLIENT_TYPE_DESKTOP);
    expect(first.get(CLIENT_SESSION_ID_HEADER)).toBe("session-id");
    expect(first.get(CLIENT_REQUEST_ID_HEADER)).toBe("request-id-1");
    expect(second.get(CLIENT_VERSION_HEADER)).toBe("1.2.3");
    expect(second.get(CLIENT_TYPE_HEADER)).toBe(CLIENT_TYPE_DESKTOP);
    expect(second.get(CLIENT_SESSION_ID_HEADER)).toBe("session-id");
    expect(second.get(CLIENT_REQUEST_ID_HEADER)).toBe("request-id-2");
  });
});
