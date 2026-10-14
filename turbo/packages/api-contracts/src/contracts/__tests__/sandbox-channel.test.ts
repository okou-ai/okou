import { describe, expect, it } from "vitest";
import {
  SANDBOX_CHANNEL_LIMITS,
  SandboxChannelError,
  decodeSandboxChannelFrame,
  encodeSandboxChannelFrame,
  sandboxChannelRemoteError,
  type SandboxChannelOperation,
} from "../sandbox-channel";
import {
  sandboxFsList,
  sandboxFsListClose,
  SANDBOX_FS_LIMITS,
} from "../sandbox-channel-fs";
import {
  sandboxDiagnosticsEcho,
  sandboxDiagnosticsPeerEcho,
  sandboxDiagnosticsNotice,
  SANDBOX_DIAGNOSTICS_MAX_BYTES,
} from "../sandbox-channel-diagnostics";
import fixtures from "../../../../../../crates/guest-contracts/tests/fixtures/sandbox-channel.json";

const frame = (value: unknown) => {
  return new TextEncoder().encode(JSON.stringify(value));
};
const operations = new Map<string, SandboxChannelOperation>([
  ["fs.list", sandboxFsList],
  ["fs.list.close", sandboxFsListClose],
  ["diagnostics.echo", sandboxDiagnosticsEcho],
  ["diagnostics.peer.echo", sandboxDiagnosticsPeerEcho],
]);

describe("cross-language sandbox channel vectors", () => {
  for (const test of fixtures.frames) {
    it(test.name, () => {
      if (test.valid) {
        const decoded = decodeSandboxChannelFrame(frame(test.wire));
        expect(
          decodeSandboxChannelFrame(encodeSandboxChannelFrame(decoded)),
        ).toEqual(test.wire);
      } else
        expect(() => {
          return decodeSandboxChannelFrame(frame(test.wire));
        }).toThrow(SandboxChannelError);
    });
  }
  for (const test of fixtures.payloads) {
    it(test.name, () => {
      if (test.direction === "event") {
        expect(
          sandboxDiagnosticsNotice.data.safeParse(test.value).success,
        ).toBe(test.valid);
        return;
      }
      const operation = operations.get(test.operation);
      if (!operation)
        throw new Error(`Missing fixture operation ${test.operation}`);
      expect(
        (test.direction === "params"
          ? operation.params
          : operation.result
        ).safeParse(test.value).success,
      ).toBe(test.valid);
    });
  }
});

it("inspects the schema before attempting a current-envelope decode", () => {
  expect(() => {
    return decodeSandboxChannelFrame(frame({ schemaVersion: 2, future: true }));
  }).toThrow(expect.objectContaining({ code: "unsupported_schema" }));
});

it("rejects invalid UTF-8, scalar strings, nonfinite JSON and excessive depth", () => {
  expect(() => {
    return decodeSandboxChannelFrame(Uint8Array.of(0xff));
  }).toThrow(SandboxChannelError);
  for (const text of [
    '{"schemaVersion":1,"type":"request","id":"00000000-0000-4000-8000-000000000001","category":"fs","categoryVersion":1,"operation":"list","params":{"path":[],"__proto__":{"probe":true}}}',
    '{"schemaVersion":1,"type":"request","id":"00000000-0000-4000-8000-000000000001","category":"fs","categoryVersion":1,"operation":"list","params":{"x":"\\ud800"}}',
    '{"schemaVersion":1,"type":"request","id":"00000000-0000-4000-8000-000000000001","category":"fs","categoryVersion":1,"operation":"list","params":{"x":1e999}}',
  ])
    expect(() => {
      return decodeSandboxChannelFrame(new TextEncoder().encode(text));
    }).toThrow(SandboxChannelError);
  let nested: unknown = 0;
  for (let i = 0; i < SANDBOX_CHANNEL_LIMITS.maxJsonDepth + 1; i++)
    nested = [nested];
  expect(() => {
    return decodeSandboxChannelFrame(
      frame({
        schemaVersion: 1,
        type: "request",
        id: "00000000-0000-4000-8000-000000000001",
        category: "fs",
        categoryVersion: 1,
        operation: "list",
        params: { nested },
      }),
    );
  }).toThrow(SandboxChannelError);
});

it("accepts mathematically integral JSON version representations", () => {
  const raw =
    '{"schemaVersion":1.0,"type":"hello","id":"00000000-0000-4000-8000-000000000001","categories":{"fs":1e0}}';
  expect(
    decodeSandboxChannelFrame(new TextEncoder().encode(raw)),
  ).toMatchObject({ schemaVersion: 1, categories: { fs: 1 } });
});

it("rejects a UTF-8 byte-order mark without rewriting the wire frame", () => {
  const hello = {
    schemaVersion: 1,
    type: "hello",
    id: "00000000-0000-4000-8000-000000000001",
    categories: { fs: 1 },
  };
  expect(() => {
    return decodeSandboxChannelFrame(
      new TextEncoder().encode(`\uFEFF${JSON.stringify(hello)}`),
    );
  }).toThrow(expect.objectContaining({ code: "invalid_request" }));
});

it("counts the entire encoded message and preserves explicit null results", () => {
  expect(() => {
    return decodeSandboxChannelFrame(
      new Uint8Array(SANDBOX_CHANNEL_LIMITS.maxFrameBytes + 1),
    );
  }).toThrow(expect.objectContaining({ code: "limit_exceeded" }));
  expect(() => {
    return decodeSandboxChannelFrame(
      frame({
        schemaVersion: 1,
        type: "event",
        id: "00000000-0000-4000-8000-000000000001",
        category: "diagnostics",
        categoryVersion: 1,
        event: "notice",
        data: { message: "x".repeat(SANDBOX_CHANNEL_LIMITS.maxFrameBytes) },
      }),
    );
  }).toThrow(SandboxChannelError);
  const nullResponse = decodeSandboxChannelFrame(
    frame({
      schemaVersion: 1,
      type: "response",
      id: "00000000-0000-4000-8000-000000000001",
      requestId: "00000000-0000-4000-8000-000000000002",
      result: null,
    }),
  );
  expect(nullResponse).toHaveProperty("result", null);
});

it("bounds typed category paths, names, pages and decoded echo bytes", () => {
  const token = btoa("a".repeat(SANDBOX_FS_LIMITS.maxNameBytes)).replace(
    /=+$/,
    "",
  );
  expect(
    sandboxFsList.params.safeParse({
      path: Array.from({ length: 17 }, () => {
        return token;
      }),
    }).success,
  ).toBe(false);
  expect(
    sandboxFsList.result.safeParse({
      listingId: "L",
      entries: Array.from({ length: SANDBOX_FS_LIMITS.maxEntries + 1 }, () => {
        return {
          nameToken: "YQ",
          displayName: "a",
          kind: "file",
        };
      }),
      nextCursor: null,
    }).success,
  ).toBe(false);
  expect(
    sandboxFsList.result.safeParse({
      listingId: "L",
      entries: Array.from({ length: 13 }, () => {
        return {
          nameToken: "YQ",
          displayName: "x".repeat(4096),
          kind: "file",
        };
      }),
      nextCursor: null,
    }).success,
  ).toBe(false);
  expect(
    sandboxDiagnosticsEcho.params.safeParse({
      payload: btoa("x".repeat(SANDBOX_DIAGNOSTICS_MAX_BYTES)),
    }).success,
  ).toBe(true);
  expect(
    sandboxDiagnosticsEcho.params.safeParse({
      payload: btoa("x".repeat(SANDBOX_DIAGNOSTICS_MAX_BYTES + 1)),
    }).success,
  ).toBe(false);
});

it("unknown remote error codes remain a safe generic business failure", () => {
  expect(sandboxChannelRemoteError({ code: "future_error" })).toMatchObject({
    code: "unavailable",
    message: "Sandbox channel: unavailable",
  });
});
