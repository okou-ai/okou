import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync, zstdCompressSync } from "node:zlib";

import {
  PI_API_FIRST_TURN_SESSION_MAX_BYTES,
  RESUME_SESSION_HISTORY_MAX_BYTES,
  type PiApiFirstTurnConfig,
  type PiApiFirstTurnManifest,
  type PiApiFirstTurnOwnershipTransferMode,
} from "@okouai/api-contracts/contracts/runners";
import { MAX_EVENT_SEQUENCE_NUMBER } from "@okouai/api-contracts/contracts/runs";
import { MemoryPiSession } from "@okouai/pi-agent-runtime/node";
import { afterEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../mocks/server";

import {
  resolvePiApiFirstTurnHandoff,
  type HandoffRuntime,
} from "./pi-api-first-turn-handoff";

import { runInIsolatedProcess } from "../../../../scripts/run-isolated-test.mjs";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const LANGFUSE_PARENT = {
  traceId: "1".repeat(32),
  spanId: "2".repeat(16),
  traceFlags: 1,
  sessionId: SESSION_ID,
} as const;
const H0_HASH = "b".repeat(64);
const temporaryDirectories: string[] = [];

function sessionJsonl(sessionId = SESSION_ID, pendingTool = true): string {
  const session = MemoryPiSession.create({
    cwd: "/home/user/workspace",
    id: sessionId,
  });
  session.appendMessage({
    role: "user",
    content: "continued from API",
    timestamp: 1,
  });
  session.appendMessage({
    role: "assistant",
    content: pendingTool
      ? [
          {
            type: "toolCall",
            id: "tool-1",
            name: "read",
            arguments: { path: "/home/user/workspace/README.md" },
          },
        ]
      : [{ type: "text", text: "complete" }],
    api: "openai-responses",
    provider: "deepseek",
    model: "deepseek-v4-flash",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: pendingTool ? "toolUse" : "stop",
    timestamp: 2,
  });
  return session.toJsonl();
}

const HANDOFF_SESSION_JSONL = sessionJsonl();
const SETTLED_SESSION_JSONL = sessionJsonl(SESSION_ID, false);
const EMPTY_SESSION_JSONL = MemoryPiSession.create({
  cwd: "/home/user/workspace",
  id: SESSION_ID,
}).toJsonl();
type PendingToolManifest = Extract<
  PiApiFirstTurnManifest,
  { readonly mode: "pending-tool-continuation" }
>;

function manifest(
  jsonl: string,
  overrides: Partial<PendingToolManifest> = {},
): PendingToolManifest {
  const bytes = Buffer.from(jsonl);
  return {
    schemaVersion: 3,
    outcome: "ownership-transfer",
    mode: "pending-tool-continuation",
    baseSession: { sessionId: SESSION_ID, sha256: H0_HASH },
    session: {
      sessionId: SESSION_ID,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      rawSize: bytes.length,
    },
    sandboxEventSequenceStart: 4,
    ...overrides,
  };
}

function legacyManifest(jsonl: string, schemaVersion: 1 | 2): object {
  const bytes = Buffer.from(jsonl);
  return {
    schemaVersion,
    outcome: "handoff",
    baseSession: { sessionId: SESSION_ID, sha256: H0_HASH },
    session: {
      sessionId: SESSION_ID,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      rawSize: bytes.length,
    },
    ...(schemaVersion === 2 ? { sandboxEventSequenceStart: 4 } : {}),
  };
}

function manifestV3(
  jsonl: string,
  mode: PiApiFirstTurnOwnershipTransferMode,
  sandboxEventSequenceStart: number,
  baseSessionSha256: string | null = H0_HASH,
): PiApiFirstTurnManifest {
  const bytes = Buffer.from(jsonl);
  return {
    schemaVersion: 3,
    outcome: "ownership-transfer",
    mode,
    baseSession: { sessionId: SESSION_ID, sha256: baseSessionSha256 },
    session: {
      sessionId: SESSION_ID,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      rawSize: bytes.length,
    },
    sandboxEventSequenceStart,
  };
}

function config(
  deadlineAt: number,
  sandboxEventSequenceStart = 1,
  baseSessionSha256: string | null = H0_HASH,
): PiApiFirstTurnConfig {
  return {
    schemaVersion: 1,
    resourceSnapshotDigest: "a".repeat(64),
    manifestUrl: "https://handoff.example/manifest.json",
    sessionUrl: "https://handoff.example/session.jsonl",
    deadlineAt,
    baseSession: { sessionId: SESSION_ID, sha256: baseSessionSha256 },
    sandboxEventSequenceStart,
  };
}

function fixedRuntime(fetchMock: typeof fetch, now = 1_000): HandoffRuntime {
  return {
    fetch: fetchMock,
    now: () => {
      return now;
    },
    async sleep() {},
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

describe("Pi API first-turn handoff loader", () => {
  it.each(["identity", "gzip", "zstd"] as const)(
    "restores large %s H0 directly from a V4 history reference",
    async (encoding) => {
      const sessionDir = await mkdtemp(join(tmpdir(), "pi-large-handoff-"));
      temporaryDirectories.push(sessionDir);
      const jsonl = SETTLED_SESSION_JSONL.replace(
        "continued from API",
        "x".repeat(PI_API_FIRST_TURN_SESSION_MAX_BYTES),
      );
      const raw = Buffer.from(jsonl);
      const encoded =
        encoding === "gzip"
          ? gzipSync(raw)
          : encoding === "zstd"
            ? zstdCompressSync(raw)
            : raw;
      const hash = createHash("sha256").update(raw).digest("hex");
      const pointer = {
        ...manifestV3(jsonl, "sandbox-first", 1, hash),
        schemaVersion: 4,
        history: {
          url: "https://history.example/checkpoint",
          encoding,
          encodedSize: encoded.length,
        },
      };
      const downloadedUrls: string[] = [];
      server.use(
        http.get("https://handoff.example/manifest.json", ({ request }) => {
          downloadedUrls.push(request.url);
          return HttpResponse.json(pointer);
        }),
        http.get(pointer.history.url, ({ request }) => {
          downloadedUrls.push(request.url);
          return new HttpResponse(encoded, {
            headers: { "content-length": String(encoded.length) },
          });
        }),
      );
      const restored = await resolvePiApiFirstTurnHandoff({
        config: config(5_000, 1, hash),
        sessionDir,
        sessionId: SESSION_ID,
        runtime: fixedRuntime(fetch),
      });
      expect((await readFile(restored.sessionFile)).equals(raw)).toBe(true);
      expect(restored.boundaryControl).toStrictEqual({
        schemaVersion: 2,
        sandboxEventSequenceStart: 1,
        ownershipTransferMode: "sandbox-first",
      });
      expect(downloadedUrls).toStrictEqual([
        "https://handoff.example/manifest.json",
        pointer.history.url,
      ]);
    },
  );

  it.each([
    "raw size",
    "encoded size",
    "hash",
    "unsettled",
    "malformed",
    "over limit",
  ] as const)("rejects an invalid V4 checkpoint: %s", async (fault) => {
    const sessionDir = await mkdtemp(join(tmpdir(), "pi-invalid-handoff-"));
    temporaryDirectories.push(sessionDir);
    const jsonl =
      fault === "unsettled"
        ? HANDOFF_SESSION_JSONL
        : fault === "malformed"
          ? `${SETTLED_SESSION_JSONL}{malformed\n`
          : SETTLED_SESSION_JSONL;
    const hash = createHash("sha256").update(jsonl).digest("hex");
    const encoded = gzipSync(jsonl);
    const base = manifestV3(jsonl, "sandbox-first", 1, hash);
    const pointer = {
      ...base,
      schemaVersion: 4,
      session: {
        ...base.session,
        rawSize:
          fault === "raw size"
            ? 1
            : fault === "over limit"
              ? RESUME_SESSION_HISTORY_MAX_BYTES + 1
              : base.session.rawSize,
        sha256: fault === "hash" ? H0_HASH : hash,
      },
      history: {
        url: "https://history.example/checkpoint",
        encoding: "gzip",
        encodedSize: encoded.length + (fault === "encoded size" ? 1 : 0),
      },
    };
    server.use(
      http.get("https://handoff.example/manifest.json", () => {
        return HttpResponse.json(pointer);
      }),
      http.get(pointer.history.url, () => {
        return new HttpResponse(encoded);
      }),
    );
    await expect(
      resolvePiApiFirstTurnHandoff({
        config: config(5_000, 1, hash),
        sessionDir,
        sessionId: SESSION_ID,
        runtime: fixedRuntime(fetch),
      }),
    ).rejects.toMatchObject({
      code:
        fault === "over limit"
          ? "PI_HANDOFF_MANIFEST_INVALID"
          : fault === "encoded size" || fault === "hash"
            ? "PI_HANDOFF_H1_HASH_MISMATCH"
            : "PI_HANDOFF_H1_INVALID",
    });
    await expect(
      readFile(join(sessionDir, `api-first-turn-${SESSION_ID}.jsonl`)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("polls 404, validates H0/H1 identity, and atomically restores native JSONL", async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), "pi-handoff-loader-"));
    temporaryDirectories.push(sessionDir);
    const jsonl = HANDOFF_SESSION_JSONL;
    const pointer = manifest(jsonl, { langfuseParent: LANGFUSE_PARENT });
    let now = 1_000;
    let manifestRequests = 0;
    const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.endsWith("manifest.json")) {
        manifestRequests += 1;
        return manifestRequests === 1
          ? new Response(null, { status: 404 })
          : Response.json(pointer);
      }
      return new Response(jsonl, {
        headers: { "content-length": String(Buffer.byteLength(jsonl)) },
      });
    });
    const runtime: HandoffRuntime = {
      fetch: fetchMock as typeof fetch,
      now: () => {
        return now;
      },
      async sleep(milliseconds) {
        now += milliseconds;
      },
    };

    const restored = await resolvePiApiFirstTurnHandoff({
      config: config(5_000),
      sessionDir,
      sessionId: SESSION_ID,
      runtime,
    });

    expect(restored.sessionFile).toContain(
      `api-first-turn-${SESSION_ID}.jsonl`,
    );
    expect(await readFile(restored.sessionFile, "utf8")).toBe(jsonl);
    expect(restored.boundaryControl).toStrictEqual({
      schemaVersion: 2,
      sandboxEventSequenceStart: 4,
      ownershipTransferMode: "pending-tool-continuation",
    });
    expect(restored.ownershipTransferMode).toBe("pending-tool-continuation");
    expect(restored.langfuseParent).toStrictEqual(LANGFUSE_PARENT);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("accepts a sandbox-first manifest after the API budget but before coordination expires", async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), "pi-handoff-loader-"));
    temporaryDirectories.push(sessionDir);
    const apiDeadlineAt = 46_000;
    const coordinationDeadlineAt = 56_000;
    let now = 1_000;
    const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      if (String(input).endsWith("manifest.json")) {
        return now < apiDeadlineAt
          ? new Response(null, { status: 404 })
          : Response.json(
              manifestV3(EMPTY_SESSION_JSONL, "sandbox-first", 1, null),
            );
      }
      return new Response(EMPTY_SESSION_JSONL);
    });
    const runtime: HandoffRuntime = {
      fetch: fetchMock as typeof fetch,
      now: () => {
        return now;
      },
      async sleep(milliseconds) {
        now += milliseconds;
      },
    };

    const restored = await resolvePiApiFirstTurnHandoff({
      config: config(coordinationDeadlineAt, 1, null),
      sessionDir,
      sessionId: SESSION_ID,
      runtime,
    });

    expect(now).toBeGreaterThanOrEqual(apiDeadlineAt);
    expect(now).toBeLessThan(coordinationDeadlineAt);
    expect(restored.ownershipTransferMode).toBe("sandbox-first");
    expect(await readFile(restored.sessionFile, "utf8")).toBe(
      EMPTY_SESSION_JSONL,
    );
  });

  it("keeps accepting the previous 45-second wire deadline", async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), "pi-handoff-loader-"));
    temporaryDirectories.push(sessionDir);
    const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      return String(input).endsWith("manifest.json")
        ? Response.json(
            manifestV3(EMPTY_SESSION_JSONL, "sandbox-first", 1, null),
          )
        : new Response(EMPTY_SESSION_JSONL);
    });

    const restored = await resolvePiApiFirstTurnHandoff({
      config: config(46_000, 1, null),
      sessionDir,
      sessionId: SESSION_ID,
      runtime: fixedRuntime(fetchMock as typeof fetch),
    });

    expect(restored.ownershipTransferMode).toBe("sandbox-first");
    expect(await readFile(restored.sessionFile, "utf8")).toBe(
      EMPTY_SESSION_JSONL,
    );
  });

  it.each([1, 2] as const)(
    "rejects retired manifest V%s before downloading a session",
    async (schemaVersion) => {
      const fetchMock = vi.fn(async () => {
        return Response.json(
          legacyManifest(HANDOFF_SESSION_JSONL, schemaVersion),
        );
      });

      await expect(
        resolvePiApiFirstTurnHandoff({
          config: config(5_000),
          sessionDir: "/unused",
          sessionId: SESSION_ID,
          runtime: fixedRuntime(fetchMock as typeof fetch),
        }),
      ).rejects.toMatchObject({ code: "PI_HANDOFF_MANIFEST_INVALID" });
      expect(fetchMock).toHaveBeenCalledOnce();
    },
  );

  it.each([
    {
      mode: "sandbox-first" as const,
      jsonl: EMPTY_SESSION_JSONL,
      baseSessionSha256: null,
    },
    {
      mode: "pending-tool-continuation" as const,
      jsonl: HANDOFF_SESSION_JSONL,
      baseSessionSha256: H0_HASH,
    },
    {
      mode: "settled-session-continuation" as const,
      jsonl: SETTLED_SESSION_JSONL,
      baseSessionSha256: H0_HASH,
    },
  ])("restores and types a V3 $mode", async (fixture) => {
    const sessionDir = await mkdtemp(join(tmpdir(), "pi-handoff-loader-"));
    temporaryDirectories.push(sessionDir);
    const sandboxEventSequenceStart = 4;
    const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      return String(input).endsWith("manifest.json")
        ? Response.json(
            manifestV3(
              fixture.jsonl,
              fixture.mode,
              sandboxEventSequenceStart,
              fixture.baseSessionSha256,
            ),
          )
        : new Response(fixture.jsonl);
    });

    const restored = await resolvePiApiFirstTurnHandoff({
      config: config(5_000, 1, fixture.baseSessionSha256),
      sessionDir,
      sessionId: SESSION_ID,
      runtime: fixedRuntime(fetchMock as typeof fetch),
    });

    expect(restored.boundaryControl).toStrictEqual({
      schemaVersion: 2,
      sandboxEventSequenceStart,
      ownershipTransferMode: fixture.mode,
    });
    expect(restored.ownershipTransferMode).toBe(fixture.mode);
    expect(await readFile(restored.sessionFile, "utf8")).toBe(fixture.jsonl);
  });

  it.each([
    {
      mode: "sandbox-first" as const,
      jsonl: SETTLED_SESSION_JSONL,
      baseSessionSha256: null,
    },
    {
      mode: "pending-tool-continuation" as const,
      jsonl: SETTLED_SESSION_JSONL,
      baseSessionSha256: H0_HASH,
    },
    {
      mode: "settled-session-continuation" as const,
      jsonl: HANDOFF_SESSION_JSONL,
      baseSessionSha256: H0_HASH,
    },
  ])("rejects session state that contradicts $mode", async (fixture) => {
    const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      return String(input).endsWith("manifest.json")
        ? Response.json(
            manifestV3(
              fixture.jsonl,
              fixture.mode,
              4,
              fixture.baseSessionSha256,
            ),
          )
        : new Response(fixture.jsonl);
    });

    await expect(
      resolvePiApiFirstTurnHandoff({
        config: config(5_000, 1, fixture.baseSessionSha256),
        sessionDir: "/unused",
        sessionId: SESSION_ID,
        runtime: fixedRuntime(fetchMock as typeof fetch),
      }),
    ).rejects.toMatchObject({ code: "PI_HANDOFF_H1_INVALID" });
  });

  it("rejects a settled transfer that merely relabels H0", async () => {
    const settledHash = createHash("sha256")
      .update(SETTLED_SESSION_JSONL)
      .digest("hex");
    const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      return String(input).endsWith("manifest.json")
        ? Response.json(
            manifestV3(
              SETTLED_SESSION_JSONL,
              "settled-session-continuation",
              4,
              settledHash,
            ),
          )
        : new Response(SETTLED_SESSION_JSONL);
    });

    await expect(
      resolvePiApiFirstTurnHandoff({
        config: config(5_000, 1, settledHash),
        sessionDir: "/unused",
        sessionId: SESSION_ID,
        runtime: fixedRuntime(fetchMock as typeof fetch),
      }),
    ).rejects.toMatchObject({ code: "PI_HANDOFF_H1_INVALID" });
  });

  it.each([
    {
      name: "missing boundary",
      pointer: {
        ...manifest(HANDOFF_SESSION_JSONL),
        sandboxEventSequenceStart: undefined,
      },
    },
    {
      name: "zero boundary",
      pointer: {
        ...manifest(HANDOFF_SESSION_JSONL),
        sandboxEventSequenceStart: 0,
      },
    },
    {
      name: "overflowing boundary",
      pointer: {
        ...manifest(HANDOFF_SESSION_JSONL),
        sandboxEventSequenceStart: MAX_EVENT_SEQUENCE_NUMBER + 1,
      },
    },
  ])("rejects a $name as an invalid manifest", async ({ pointer }) => {
    const fetchMock = vi.fn(async () => {
      return Response.json(pointer);
    });

    await expect(
      resolvePiApiFirstTurnHandoff({
        config: config(5_000),
        sessionDir: "/unused",
        sessionId: SESSION_ID,
        runtime: fixedRuntime(fetchMock as typeof fetch),
      }),
    ).rejects.toMatchObject({ code: "PI_HANDOFF_MANIFEST_INVALID" });
  });

  it("fails with the one deadline when the manifest never appears", async () => {
    let now = 100;
    const fetchMock = vi.fn(async () => {
      return new Response(null, { status: 404 });
    });
    const runtime: HandoffRuntime = {
      fetch: fetchMock as typeof fetch,
      now: () => {
        return now;
      },
      async sleep(milliseconds) {
        now += milliseconds;
      },
    };

    await expect(
      resolvePiApiFirstTurnHandoff({
        config: config(350),
        sessionDir: "/unused",
        sessionId: SESSION_ID,
        runtime,
      }),
    ).rejects.toMatchObject({ code: "PI_HANDOFF_MANIFEST_TIMEOUT" });
    expect(now).toBe(350);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
  });

  it.each([
    {
      name: "malformed manifest",
      expectedCode: "PI_HANDOFF_MANIFEST_INVALID",
      pointer: "not-json",
      session: HANDOFF_SESSION_JSONL,
    },
    {
      name: "corrupt H1 hash",
      expectedCode: "PI_HANDOFF_H1_HASH_MISMATCH",
      pointer: manifest(HANDOFF_SESSION_JSONL),
      session: `${HANDOFF_SESSION_JSONL} `,
    },
    {
      name: "mismatched H0 base hash",
      expectedCode: "PI_HANDOFF_BASE_SESSION_MISMATCH",
      pointer: manifest(HANDOFF_SESSION_JSONL, {
        baseSession: { sessionId: SESSION_ID, sha256: "c".repeat(64) },
      }),
      session: HANDOFF_SESSION_JSONL,
    },
    {
      name: "mismatched H1 session id",
      expectedCode: "PI_HANDOFF_SESSION_MISMATCH",
      pointer: manifest(HANDOFF_SESSION_JSONL, {
        session: {
          ...manifest(HANDOFF_SESSION_JSONL).session,
          sessionId: "22222222-2222-4222-8222-222222222222",
        },
      }),
      session: HANDOFF_SESSION_JSONL,
    },
    {
      name: "mismatched Langfuse parent session id",
      expectedCode: "PI_HANDOFF_SESSION_MISMATCH",
      pointer: manifest(HANDOFF_SESSION_JSONL, {
        langfuseParent: {
          ...LANGFUSE_PARENT,
          sessionId: "22222222-2222-4222-8222-222222222222",
        },
      }),
      session: HANDOFF_SESSION_JSONL,
    },
    {
      name: "valid-header H1 with a malformed later line",
      expectedCode: "PI_HANDOFF_H1_INVALID",
      pointer: manifest(`${HANDOFF_SESSION_JSONL}{malformed\n`),
      session: `${HANDOFF_SESSION_JSONL}{malformed\n`,
    },
    {
      name: "legacy complete manifest",
      expectedCode: "PI_HANDOFF_MANIFEST_INVALID",
      pointer: { ...manifest(HANDOFF_SESSION_JSONL), outcome: "complete" },
      session: HANDOFF_SESSION_JSONL,
    },
    {
      name: "handoff without pending tools",
      expectedCode: "PI_HANDOFF_H1_INVALID",
      pointer: manifest(SETTLED_SESSION_JSONL),
      session: SETTLED_SESSION_JSONL,
    },
  ])("fails fast for $name instead of replaying H0", async (fixture) => {
    const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      if (String(input).endsWith("manifest.json")) {
        return typeof fixture.pointer === "string"
          ? new Response(fixture.pointer)
          : Response.json(fixture.pointer);
      }
      return new Response(fixture.session);
    });
    await expect(
      resolvePiApiFirstTurnHandoff({
        config: config(5_000),
        sessionDir: "/unused",
        sessionId: SESSION_ID,
        runtime: fixedRuntime(fetchMock as typeof fetch),
      }),
    ).rejects.toMatchObject({ code: fixture.expectedCode });
  });

  it("fails when H1 finishes at the shared deadline", async () => {
    const jsonl = HANDOFF_SESSION_JSONL;
    let now = 1_000;
    const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      if (String(input).endsWith("manifest.json")) {
        return Response.json(manifest(jsonl));
      }
      now = 2_000;
      return new Response(jsonl);
    });
    await expect(
      resolvePiApiFirstTurnHandoff({
        config: config(2_000),
        sessionDir: "/unused",
        sessionId: SESSION_ID,
        runtime: {
          fetch: fetchMock as typeof fetch,
          now: () => {
            return now;
          },
          async sleep() {},
        },
      }),
    ).rejects.toMatchObject({ code: "PI_HANDOFF_H1_LATE" });
  });

  it("fails when the manifest body finishes at the shared deadline", async () => {
    const jsonl = HANDOFF_SESSION_JSONL;
    let now = 1_000;
    const encoded = new TextEncoder().encode(JSON.stringify(manifest(jsonl)));
    const pointer = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          now = 2_000;
          controller.enqueue(encoded);
          controller.close();
        },
      }),
    );
    const fetchMock = vi.fn(async () => {
      return pointer;
    });

    await expect(
      resolvePiApiFirstTurnHandoff({
        config: config(2_000),
        sessionDir: "/unused",
        sessionId: SESSION_ID,
        runtime: {
          fetch: fetchMock as typeof fetch,
          now: () => {
            return now;
          },
          async sleep() {},
        },
      }),
    ).rejects.toMatchObject({ code: "PI_HANDOFF_MANIFEST_TIMEOUT" });
  });

  it.each([
    {
      name: "manifest",
      expectedCode: "PI_HANDOFF_MANIFEST_INVALID",
      failManifest: true,
    },
    {
      name: "H1",
      expectedCode: "PI_HANDOFF_H1_DOWNLOAD_FAILED",
      failManifest: false,
    },
  ])("types a $name body read failure", async (fixture) => {
    const jsonl = HANDOFF_SESSION_JSONL;
    const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const isManifest = String(input).endsWith("manifest.json");
      const response = isManifest
        ? Response.json(manifest(jsonl))
        : new Response(jsonl);
      if (isManifest === fixture.failManifest) {
        return new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.error(new Error("body stream failed"));
            },
          }),
        );
      }
      return response;
    });

    await expect(
      resolvePiApiFirstTurnHandoff({
        config: config(5_000),
        sessionDir: "/unused",
        sessionId: SESSION_ID,
        runtime: fixedRuntime(fetchMock as typeof fetch),
      }),
    ).rejects.toMatchObject({ code: fixture.expectedCode });
  });

  it("stops an oversized manifest stream without Content-Length", async () => {
    const cancel = vi.fn();
    let chunk = 0;
    const fetchMock = vi.fn(async () => {
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.enqueue(new Uint8Array(chunk++ === 0 ? 16 * 1024 : 1));
          },
          cancel,
        }),
      );
    });

    await expect(
      resolvePiApiFirstTurnHandoff({
        config: config(5_000),
        sessionDir: "/unused",
        sessionId: SESSION_ID,
        runtime: fixedRuntime(fetchMock as typeof fetch),
      }),
    ).rejects.toMatchObject({ code: "PI_HANDOFF_MANIFEST_INVALID" });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("stops an oversized H1 stream with under-declared Content-Length", async () => {
    const cancel = vi.fn();
    let h1Chunk = 0;
    const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      if (String(input).endsWith("manifest.json")) {
        return Response.json(manifest(HANDOFF_SESSION_JSONL));
      }
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.enqueue(
              new Uint8Array(
                h1Chunk++ === 0 ? PI_API_FIRST_TURN_SESSION_MAX_BYTES : 1,
              ),
            );
          },
          cancel,
        }),
        { headers: { "content-length": "1" } },
      );
    });

    await expect(
      resolvePiApiFirstTurnHandoff({
        config: config(5_000),
        sessionDir: "/unused",
        sessionId: SESSION_ID,
        runtime: fixedRuntime(fetchMock as typeof fetch),
      }),
    ).rejects.toMatchObject({ code: "PI_HANDOFF_H1_TOO_LARGE" });
    expect(cancel).toHaveBeenCalledOnce();
  });
});

it("rejects cyclic and duplicate downloaded histories without replacing installed bytes", async () => {
  if (await runInIsolatedProcess(import.meta.url)) {
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), "pi-handoff-invalid-"));
  temporaryDirectories.push(directory);
  const sessionFile = join(directory, `api-first-turn-${SESSION_ID}.jsonl`);
  await writeFile(sessionFile, HANDOFF_SESSION_JSONL);
  for (const mode of [
    "sandbox-first",
    "pending-tool-continuation",
    "settled-session-continuation",
  ] as const) {
    for (const duplicate of [false, true]) {
      const record = JSON.stringify({
        type: "model_change",
        id: "graph-entry",
        parentId: duplicate ? null : "graph-entry",
        timestamp: "2026-09-05T00:00:00.000Z",
        provider: "openai",
        modelId: "gpt-5.6-terra",
      });
      const history = `${HANDOFF_SESSION_JSONL}${record}\n${duplicate ? `${record}\n` : ""}`;
      server.use(
        http.get("https://handoff.example/manifest.json", () => {
          return HttpResponse.json(manifestV3(history, mode, 4));
        }),
        http.get("https://handoff.example/session.jsonl", () => {
          return new HttpResponse(history);
        }),
      );
      await expect(
        resolvePiApiFirstTurnHandoff({
          config: config(5_000),
          sessionDir: directory,
          sessionId: SESSION_ID,
          runtime: fixedRuntime(fetch),
        }),
      ).rejects.toMatchObject({ code: "PI_HANDOFF_H1_INVALID" });
      expect(await readFile(sessionFile, "utf8")).toBe(HANDOFF_SESSION_JSONL);
    }
  }
  server.use(
    http.get("https://handoff.example/manifest.json", () => {
      return HttpResponse.json(manifest(HANDOFF_SESSION_JSONL));
    }),
    http.get("https://handoff.example/session.jsonl", () => {
      return new HttpResponse(HANDOFF_SESSION_JSONL);
    }),
  );
  await expect(
    resolvePiApiFirstTurnHandoff({
      config: config(5_000),
      sessionDir: directory,
      sessionId: SESSION_ID,
      runtime: fixedRuntime(fetch),
    }),
  ).resolves.toMatchObject({ sessionFile });
  expect(await readFile(sessionFile, "utf8")).toBe(HANDOFF_SESSION_JSONL);
}, 150_000);
