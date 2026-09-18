import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";

import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { agentInstructionsContract } from "@okouai/api-contracts/contracts/agents";
import { morningBriefCompositionPreviewContract } from "@okouai/api-contracts/contracts/morning-brief-composition-preview";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { createStore } from "ccstate";
import { afterEach, describe, expect, it, onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { clearMockNow, mockNow, now, nowDate } from "../../../lib/time";
import {
  seedFinishedChatRunFixture$,
  seedMorningBriefChatMemberFixture,
  seedOrdinaryChatThreadFixture$,
} from "../../../test-fixtures/morning-brief-chat-collection";
import { tarArchive, tarEntry } from "../../../test-fixtures/tar-archive";
import { createDeferredPromise } from "../../utils";
import { agentInstructionsRoutes } from "../agent-instructions";
import { morningBriefCompositionPreviewRoutes } from "../morning-brief-composition-preview";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { createRouteMocks } from "./helpers/route-test";

/**
 * The Agent language context the real composition freezes, through its route.
 *
 * Every case here is a statement about one composition response: which
 * instruction version travelled into the request, which proven absence took the
 * locale path instead, which storage state is a failure that must never select
 * a language, and what happens when either changes while the attempt is still
 * holding its final authority boundary.
 *
 * Storage is doubled at its own boundary. Valid states are published through
 * the product's canonical instructions endpoint, so the archive, manifest and
 * version rows under test are the ones production writes; only states no
 * endpoint can publish — a corrupt archive, a symlink or directory shadowing
 * the canonical path, a manifest that is not UTF-8 — are written as bytes.
 */

const context = testContext();
const store = createStore();

/** The canonical instruction path for the application-owned framework. */
const CANONICAL_TARGET = "CLAUDE.md";
const INSTRUCTIONS_MAX_BYTES = 64 * 1024;
const STORAGE_PHASE_MS = 5000;

afterEach(() => {
  clearMockNow();
});

interface Member {
  readonly orgId: string;
  readonly userId: string;
  readonly agentId: string;
}

function commandInput(command: unknown): Record<string, unknown> {
  if (
    typeof command === "object" &&
    command !== null &&
    "input" in command &&
    typeof command.input === "object" &&
    command.input !== null
  ) {
    return command.input as Record<string, unknown>;
  }
  return {};
}

function notFoundError(): Error {
  return Object.assign(new Error("Object not found"), {
    name: "NotFound",
    $metadata: { httpStatusCode: 404 },
  });
}

interface StorageBoundary {
  /** Every key a download asked for, in order. */
  readonly reads: readonly string[];
  /** Serve these bytes instead of what the canonical publisher wrote. */
  readonly replace: (suffix: string, body: Buffer) => void;
  /** Run before a download answers, once per matching key. */
  readonly beforeRead: (
    suffix: string,
    hook: () => void | Promise<void>,
  ) => void;
}

/**
 * The object store, doubled where the application actually talks to it.
 *
 * The canonical publisher's own PUTs land here, so a published version is read
 * back exactly as it was written; replacements are keyed by object suffix
 * because a version's prefix is chosen by the publisher, not by the test.
 */
function installStorageBoundary(): StorageBoundary {
  const objects = new Map<string, Buffer>();
  const replacements = new Map<string, Buffer>();
  const hooks = new Map<string, () => void | Promise<void>>();
  const reads: string[] = [];

  function replacementFor(key: string): Buffer | undefined {
    for (const [suffix, body] of replacements) {
      if (key.endsWith(suffix)) {
        return body;
      }
    }
    return undefined;
  }

  async function runHook(key: string): Promise<void> {
    for (const [suffix, hook] of hooks) {
      if (key.endsWith(suffix)) {
        hooks.delete(suffix);
        await hook();
      }
    }
  }

  function storedObject(key: string): Buffer {
    const body = replacementFor(key) ?? objects.get(key);
    if (!body) {
      throw notFoundError();
    }
    return body;
  }

  function storeObject(input: Record<string, unknown>, key: string): void {
    const body = input.Body;
    if (!(typeof body === "string" || body instanceof Uint8Array)) {
      throw new Error("Expected a volume object body");
    }
    objects.set(key, Buffer.from(body));
  }

  function listObjects(prefix: string) {
    return {
      Contents: [...objects]
        .filter(([storedKey]) => {
          return storedKey.startsWith(prefix);
        })
        .map(([Key, body]) => {
          return { Key, Size: body.length, LastModified: nowDate() };
        }),
    };
  }

  function deleteObjects(input: Record<string, unknown>): void {
    const target = input.Delete;
    if (typeof target !== "object" || target === null) {
      return;
    }
    const listed = (target as { readonly Objects?: readonly unknown[] })
      .Objects;
    for (const object of listed ?? []) {
      const key =
        typeof object === "object" && object !== null && "Key" in object
          ? object.Key
          : undefined;
      if (typeof key === "string") {
        objects.delete(key);
      }
    }
  }

  context.mocks.s3.send.mockImplementation(async (command: unknown) => {
    const input = commandInput(command);
    const key = typeof input.Key === "string" ? input.Key : "";
    if (command instanceof PutObjectCommand) {
      storeObject(input, key);
      return {};
    }
    if (command instanceof HeadObjectCommand) {
      return { ContentLength: storedObject(key).length, ETag: `"${key}"` };
    }
    if (command instanceof GetObjectCommand) {
      reads.push(key);
      await runHook(key);
      const body = storedObject(key);
      return { ContentLength: body.length, Body: Readable.from([body]) };
    }
    if (command instanceof ListObjectsV2Command) {
      return listObjects(typeof input.Prefix === "string" ? input.Prefix : "");
    }
    if (command instanceof DeleteObjectsCommand) {
      deleteObjects(input);
    }
    return {};
  });

  return {
    reads,
    replace(suffix, body) {
      replacements.set(suffix, body);
    },
    beforeRead(suffix, hook) {
      hooks.set(suffix, hook);
    },
  };
}

function compositionClient() {
  return setupApp({
    context,
    routes: morningBriefCompositionPreviewRoutes,
  })(morningBriefCompositionPreviewContract);
}

function instructionsClient() {
  return setupApp({ context, routes: agentInstructionsRoutes })(
    agentInstructionsContract,
  );
}

function sessionHeaders(member: Pick<Member, "orgId" | "userId">) {
  createRouteMocks(context).clerk.session(
    member.userId,
    member.orgId,
    "org:admin",
  );
  return { authorization: "Bearer clerk-session" };
}

/** A member whose Morning Brief has exactly one unread Chat thread to report. */
async function briefMember(): Promise<Member> {
  const seeded = await seedMorningBriefChatMemberFixture();
  await store.set(
    seedOrgMembership$,
    { orgId: seeded.orgId, userId: seeded.userId, role: "admin" },
    context.signal,
  );
  await updateFeatureSwitchesForUser(
    context,
    { orgId: seeded.orgId, userId: seeded.userId },
    { [FeatureSwitchKey.SimpleMorningBrief]: true },
  );
  const member = {
    orgId: seeded.orgId,
    userId: seeded.userId,
    agentId: seeded.agentId,
  };
  const threadId = await store.set(
    seedOrdinaryChatThreadFixture$,
    { member, title: "Release readiness" },
    context.signal,
  );
  await store.set(
    seedFinishedChatRunFixture$,
    {
      chatThreadId: threadId,
      prompt: "What is left before the release?",
      reply: "The migration is queued and the rollout note is drafted.",
    },
    context.signal,
  );
  return member;
}

/** Publish instruction text the way the product's own Settings surface does. */
async function publishInstructions(
  member: Member,
  content: string,
): Promise<void> {
  await accept(
    instructionsClient().update({
      params: { id: member.agentId },
      headers: sessionHeaders(member),
      body: { content },
    }),
    [200],
  );
}

async function compose(member: Member, anchor = new Date(now()).toISOString()) {
  const response = await accept(
    compositionClient().compose({
      headers: sessionHeaders(member),
      body: { anchor },
    }),
    [200],
  );
  return response.body;
}

function composeRequest(
  member: Member,
  anchor = new Date(now()).toISOString(),
) {
  return accept(
    compositionClient().compose({
      headers: sessionHeaders(member),
      body: { anchor },
    }),
    [200],
  );
}

function digestOf(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function isOwnerLookup(args: readonly unknown[], member: Member): boolean {
  const [query] = args;
  if (typeof query !== "object" || query === null) {
    return false;
  }
  const organizationId =
    "organizationId" in query ? query.organizationId : undefined;
  const userId = "userId" in query ? query.userId : undefined;
  return (
    organizationId === member.orgId &&
    Array.isArray(userId) &&
    userId.includes(member.userId)
  );
}

interface MembershipBarrier {
  /** Exact-member membership lookups observed since the last reset. */
  readonly matched: () => number;
  readonly reset: () => void;
  /** Suspend the n-th following exact-member lookup after it has answered. */
  readonly hold: (index: number) => {
    readonly arrived: Promise<void>;
    readonly release: () => void;
  };
}

/**
 * Suspend the composition at the authority boundary it rechecks before it
 * freezes anything.
 *
 * The membership generation is resolved through Clerk once when the attempt is
 * admitted and again after every network read, so suspending that second
 * lookup stops the attempt exactly where its language context is already in
 * hand and nothing has been released. The index is calibrated by an unheld
 * composition first, so the barrier names the real final lookup instead of
 * assuming how many the path makes.
 */
function membershipBarrier(member: Member): MembershipBarrier {
  const lookup =
    context.mocks.clerk.organizations.getOrganizationMembershipList;
  const answer = lookup.getMockImplementation();
  if (!answer) {
    throw new Error("Expected seeded Clerk organization memberships");
  }
  let matched = 0;
  let holdAt: number | null = null;
  let arrived: ReturnType<typeof createDeferredPromise<void>> | null = null;
  let released: ReturnType<typeof createDeferredPromise<void>> | null = null;
  lookup.mockImplementation(async (...args: unknown[]) => {
    const memberships = await answer(...args);
    if (!isOwnerLookup(args, member)) {
      return memberships;
    }
    matched += 1;
    if (holdAt !== null && matched === holdAt && arrived && released) {
      arrived.resolve();
      await released.promise;
    }
    return memberships;
  });
  onTestFinished(() => {
    if (released && !released.settled()) {
      released.resolve();
    }
  });
  return {
    matched: () => {
      return matched;
    },
    reset: () => {
      matched = 0;
    },
    hold: (index: number) => {
      holdAt = index;
      arrived = createDeferredPromise<void>(context.signal);
      released = createDeferredPromise<void>(context.signal);
      const pendingArrived = arrived.promise;
      const pendingReleased = released;
      return {
        arrived: pendingArrived,
        release: () => {
          if (!pendingReleased.settled()) {
            pendingReleased.resolve();
          }
        },
      };
    },
  };
}

/**
 * Run one composition, publish through the canonical endpoint while it holds
 * its final authority boundary, and let it finish.
 *
 * The publication is a real product call, so what changes underneath the held
 * attempt is exactly what an owner editing their Agent changes.
 */
async function composeWhileRepublishing(
  member: Member,
  edit: (() => Promise<void>) | null,
) {
  const barrier = membershipBarrier(member);
  // Calibrate: the unheld attempt shows how many exact-member lookups the
  // whole path makes, and the last of them is the final authority recheck.
  await compose(member);
  const finalLookup = barrier.matched();
  expect(finalLookup).toBeGreaterThanOrEqual(2);
  barrier.reset();
  const held = barrier.hold(finalLookup);
  const pending = composeRequest(member);
  await held.arrived;
  if (edit) {
    await edit();
  }
  held.release();
  return (await pending).body;
}

/** A valid gzipped TAR carrying exactly these entries. */
function archiveOf(entries: readonly Buffer[]): Buffer {
  return gzipSync(tarArchive([...entries]));
}

function regularEntry(path: string, content: Buffer): Buffer {
  return tarEntry({ path, type: "0", content });
}

function manifestOf(
  files: readonly { readonly path: string; readonly size: number }[],
): Buffer {
  return Buffer.from(
    JSON.stringify({
      version: "replacement",
      createdAt: "2026-09-17T00:00:00.000Z",
      totalSize: files.reduce((sum, file) => {
        return sum + file.size;
      }, 0),
      fileCount: files.length,
      files: files.map((file) => {
        return { path: file.path, hash: "0".repeat(64), size: file.size };
      }),
    }),
    "utf8",
  );
}

describe("POST /api/morning-brief/collection-preview/compose — Agent language", () => {
  describe("what one storage read is allowed to conclude", () => {
    it("carries the complete published instruction text and its version", async () => {
      installStorageBoundary();
      const member = await briefMember();
      const text = "Always write this brief in Simplified Chinese.\n";
      await publishInstructions(member, text);

      const body = await compose(member);

      expect(body.result).toBe("composed");
      if (body.result !== "composed") {
        return;
      }
      expect(body.composition.language).toMatchObject({
        authority: "agent-instructions",
        instructions: { state: "available", digest: digestOf(text) },
      });
      expect(body.composition.language?.instructions.versionId).toStrictEqual(
        expect.any(String),
      );
    });

    it("reports an Agent with no instructions volume as proven absence", async () => {
      installStorageBoundary();
      const member = await briefMember();

      const body = await compose(member);

      expect(body.result).toBe("composed");
      if (body.result !== "composed") {
        return;
      }
      expect(body.composition.language).toStrictEqual({
        authority: "default",
        fallbackLanguage: "en-US",
        instructions: { state: "no-storage", versionId: null },
      });
    });

    it("reports a published empty file as absence under that exact version", async () => {
      installStorageBoundary();
      const member = await briefMember();
      await publishInstructions(member, "");

      const body = await compose(member);

      expect(body.result).toBe("composed");
      if (body.result !== "composed") {
        return;
      }
      expect(body.composition.language).toMatchObject({
        authority: "default",
        instructions: { state: "empty-file" },
      });
      expect(body.composition.language?.instructions.versionId).toStrictEqual(
        expect.any(String),
      );
    });

    it("reports a volume without the canonical target as absence", async () => {
      const storage = installStorageBoundary();
      const member = await briefMember();
      await publishInstructions(member, "Write in French.");
      storage.replace(
        "/manifest.json",
        manifestOf([{ path: "NOTES.md", size: 4 }]),
      );

      const body = await compose(member);

      expect(body.result).toBe("composed");
      if (body.result !== "composed") {
        return;
      }
      expect(body.composition.language).toMatchObject({
        authority: "default",
        instructions: { state: "no-target" },
      });
      expect(body.composition.language?.instructions.versionId).toStrictEqual(
        expect.any(String),
      );
    });

    it("keeps every byte of an instruction file at the exact ceiling", async () => {
      installStorageBoundary();
      const member = await briefMember();
      const text = "x".repeat(INSTRUCTIONS_MAX_BYTES);
      await publishInstructions(member, text);

      const body = await compose(member);

      expect(body.result).toBe("composed");
      if (body.result !== "composed") {
        return;
      }
      expect(body.composition.language?.instructions).toMatchObject({
        state: "available",
        digest: digestOf(text),
      });
    });

    it("refuses one byte over the ceiling instead of truncating it", async () => {
      installStorageBoundary();
      const member = await briefMember();
      await publishInstructions(member, "x".repeat(INSTRUCTIONS_MAX_BYTES + 1));

      const body = await compose(member);

      expect(body).toStrictEqual({
        result: "incomplete",
        reason: "language-context-unavailable",
        detail: "too-large",
      });
    });

    it("keeps the legacy profile-block behaviour of the canonical reader", async () => {
      installStorageBoundary();
      const member = await briefMember();
      // The canonical reader strips the legacy block and trims what is left.
      const steering = "Write in Japanese.";
      await publishInstructions(
        member,
        `[AGENT_PROFILE]\nname: brief\n[/AGENT_PROFILE]\n${steering}\n`,
      );

      const body = await compose(member);

      expect(body.result).toBe("composed");
      if (body.result !== "composed") {
        return;
      }
      expect(body.composition.language?.instructions).toMatchObject({
        state: "available",
        digest: digestOf(steering),
      });
    });
  });

  describe("storage states that may never select a language", () => {
    async function refusedBy(
      prepare: (storage: StorageBoundary, member: Member) => void,
    ) {
      const storage = installStorageBoundary();
      const member = await briefMember();
      await publishInstructions(member, "Write in Korean.");
      prepare(storage, member);
      return await compose(member);
    }

    it("refuses a canonical target the archive carries twice", async () => {
      const body = await refusedBy((storage) => {
        storage.replace(
          "/archive.tar.gz",
          archiveOf([
            regularEntry(CANONICAL_TARGET, Buffer.from("first", "utf8")),
            regularEntry(CANONICAL_TARGET, Buffer.from("second", "utf8")),
          ]),
        );
      });

      expect(body).toStrictEqual({
        result: "incomplete",
        reason: "language-context-unavailable",
        detail: "target-ambiguous",
      });
    });

    it("refuses a canonical file shadowed by a symlink that follows it", async () => {
      const body = await refusedBy((storage) => {
        storage.replace(
          "/archive.tar.gz",
          archiveOf([
            regularEntry(CANONICAL_TARGET, Buffer.from("real", "utf8")),
            tarEntry({
              path: CANONICAL_TARGET,
              type: "2",
              linkname: "elsewhere.md",
            }),
          ]),
        );
      });

      expect(body).toStrictEqual({
        result: "incomplete",
        reason: "language-context-unavailable",
        detail: "target-ambiguous",
      });
    });

    it("refuses a canonical file shadowed by a symlink that precedes it", async () => {
      const body = await refusedBy((storage) => {
        storage.replace(
          "/archive.tar.gz",
          archiveOf([
            tarEntry({
              path: CANONICAL_TARGET,
              type: "2",
              linkname: "elsewhere.md",
            }),
            regularEntry(CANONICAL_TARGET, Buffer.from("real", "utf8")),
          ]),
        );
      });

      expect(body).toStrictEqual({
        result: "incomplete",
        reason: "language-context-unavailable",
        detail: "target-ambiguous",
      });
    });

    it("refuses a canonical file shadowed by a directory", async () => {
      const body = await refusedBy((storage) => {
        storage.replace(
          "/archive.tar.gz",
          archiveOf([
            tarEntry({ path: CANONICAL_TARGET, type: "5" }),
            regularEntry(CANONICAL_TARGET, Buffer.from("real", "utf8")),
          ]),
        );
      });

      expect(body).toStrictEqual({
        result: "incomplete",
        reason: "language-context-unavailable",
        detail: "target-ambiguous",
      });
    });

    it("refuses an archive that omits the promised canonical target", async () => {
      const body = await refusedBy((storage) => {
        storage.replace(
          "/archive.tar.gz",
          archiveOf([regularEntry("NOTES.md", Buffer.from("note", "utf8"))]),
        );
      });

      expect(body).toStrictEqual({
        result: "incomplete",
        reason: "language-context-unavailable",
        detail: "target-missing",
      });
    });

    it("refuses an instruction file that is not valid UTF-8", async () => {
      const body = await refusedBy((storage) => {
        storage.replace(
          "/archive.tar.gz",
          archiveOf([
            regularEntry(CANONICAL_TARGET, Buffer.from([0xff, 0xfe, 0x00])),
          ]),
        );
      });

      expect(body).toStrictEqual({
        result: "incomplete",
        reason: "language-context-unavailable",
        detail: "not-utf8",
      });
    });

    it("refuses an archive that does not decompress", async () => {
      const body = await refusedBy((storage) => {
        storage.replace("/archive.tar.gz", Buffer.from("not a gzip", "utf8"));
      });

      expect(body).toStrictEqual({
        result: "incomplete",
        reason: "language-context-unavailable",
        detail: "archive-corrupt",
      });
    });

    it("refuses an archive that decompresses past the ceiling as oversized", async () => {
      const body = await refusedBy((storage) => {
        storage.replace(
          "/archive.tar.gz",
          archiveOf([
            regularEntry("BULK.md", Buffer.alloc(3 * 1024 * 1024, 0x61)),
          ]),
        );
      });

      expect(body).toStrictEqual({
        result: "incomplete",
        reason: "language-context-unavailable",
        detail: "too-large",
      });
    });

    it("refuses a manifest that is not valid UTF-8 instead of reading absence", async () => {
      const body = await refusedBy((storage) => {
        const manifest = manifestOf([{ path: CANONICAL_TARGET, size: 16 }]);
        // One byte of the promised path is replaced by an invalid sequence, so
        // a replacement-decoding reader sees a path that matches nothing.
        const corrupted = Buffer.from(manifest);
        corrupted[corrupted.indexOf(CANONICAL_TARGET)] = 0xff;
        storage.replace("/manifest.json", corrupted);
      });

      expect(body).toStrictEqual({
        result: "incomplete",
        reason: "language-context-unavailable",
        detail: "storage-unavailable",
      });
    });
  });

  describe("what a change during the final authority boundary invalidates", () => {
    it("rejects a frozen instruction version that was republished", async () => {
      installStorageBoundary();
      const member = await briefMember();
      await publishInstructions(member, "Write in Italian.");

      const body = await composeWhileRepublishing(member, async () => {
        await publishInstructions(member, "Write in Portuguese.");
      });

      expect(body).toStrictEqual({ result: "authority-changed" });
    });

    it("rejects a proven no-storage absence that gained a first version", async () => {
      installStorageBoundary();
      const member = await briefMember();

      const body = await composeWhileRepublishing(member, async () => {
        await publishInstructions(member, "Write in Spanish.");
      });

      expect(body).toStrictEqual({ result: "authority-changed" });
    });

    it("rejects a proven empty file that was replaced by real text", async () => {
      installStorageBoundary();
      const member = await briefMember();
      await publishInstructions(member, "");

      const body = await composeWhileRepublishing(member, async () => {
        await publishInstructions(member, "Write in German.");
      });

      expect(body).toStrictEqual({ result: "authority-changed" });
    });

    it("rejects a proven missing target whose volume gained a new version", async () => {
      const storage = installStorageBoundary();
      const member = await briefMember();
      await publishInstructions(member, "Write in Dutch.");
      storage.replace(
        "/manifest.json",
        manifestOf([{ path: "NOTES.md", size: 4 }]),
      );

      const body = await composeWhileRepublishing(member, async () => {
        await publishInstructions(member, "Write in Swedish.");
      });

      expect(body).toStrictEqual({ result: "authority-changed" });
    });

    it("keeps an unchanged available context across the held boundary", async () => {
      installStorageBoundary();
      const member = await briefMember();
      const text = "Write in Norwegian.";
      await publishInstructions(member, text);

      const body = await composeWhileRepublishing(member, null);

      expect(body.result).toBe("composed");
      if (body.result !== "composed") {
        return;
      }
      expect(body.composition.language?.instructions).toMatchObject({
        state: "available",
        digest: digestOf(text),
      });
    });

    it("keeps an unchanged absence across the held boundary", async () => {
      installStorageBoundary();
      const member = await briefMember();

      const body = await composeWhileRepublishing(member, null);

      expect(body.result).toBe("composed");
      if (body.result !== "composed") {
        return;
      }
      expect(body.composition.language?.instructions).toStrictEqual({
        state: "no-storage",
        versionId: null,
      });
    });
  });

  describe("the absolute storage deadline", () => {
    const timedOut = {
      result: "incomplete",
      reason: "language-context-unavailable",
      detail: "timed-out",
    } as const;

    function archiveReads(storage: StorageBoundary): readonly string[] {
      return storage.reads.filter((key) => {
        return key.endsWith("/archive.tar.gz");
      });
    }

    async function composeNoTargetAfterParseAt(elapsedMs: number) {
      const storage = installStorageBoundary();
      const member = await briefMember();
      await publishInstructions(member, "Write in Finnish.");
      storage.replace(
        "/manifest.json",
        manifestOf([{ path: "NOTES.md", size: 4 }]),
      );
      const base = now();
      mockNow(base);
      storage.beforeRead("/manifest.json", () => {
        // This is the nearest real external boundary to synchronous decode,
        // JSON parse and target filtering. The pure production admission
        // helper covers the exact post-parse clock edge.
        mockNow(base + elapsedMs);
      });
      const body = await compose(member, new Date(base).toISOString());
      return { body, storage };
    }

    it.each([
      ["before", STORAGE_PHASE_MS - 1, true],
      ["at", STORAGE_PHASE_MS, false],
      ["after", STORAGE_PHASE_MS + 10, false],
    ] as const)(
      "releases no-target absence only when manifest parsing finishes %s the deadline",
      async (_boundary, elapsedMs, accepted) => {
        const { body, storage } = await composeNoTargetAfterParseAt(elapsedMs);

        if (accepted) {
          expect(body.result).toBe("composed");
          if (body.result !== "composed") {
            return;
          }
          expect(body.composition.language?.instructions).toMatchObject({
            state: "no-target",
          });
        } else {
          expect(body).toStrictEqual(timedOut);
        }
        expect(archiveReads(storage)).toStrictEqual([]);
      },
    );

    async function composeAfterExtractionAt(elapsedMs: number) {
      const storage = installStorageBoundary();
      const member = await briefMember();
      await publishInstructions(member, "Write in Finnish.");
      const base = now();
      mockNow(base);
      storage.beforeRead("/archive.tar.gz", () => {
        // The route cannot yield inside synchronous extraction; this storage
        // response is its nearest real boundary, while the production helper
        // pins equality for the check immediately after extraction.
        mockNow(base + elapsedMs);
      });
      return await compose(member, new Date(base).toISOString());
    }

    it("accepts extraction just before the deadline", async () => {
      const body = await composeAfterExtractionAt(STORAGE_PHASE_MS - 1);

      expect(body.result).toBe("composed");
      if (body.result !== "composed") {
        return;
      }
      expect(body.composition.language?.instructions).toMatchObject({
        state: "available",
      });
    });

    it("expires extraction exactly at the deadline", async () => {
      await expect(
        composeAfterExtractionAt(STORAGE_PHASE_MS),
      ).resolves.toStrictEqual(timedOut);
    });

    it("expires extraction after the deadline", async () => {
      await expect(
        composeAfterExtractionAt(STORAGE_PHASE_MS + 10),
      ).resolves.toStrictEqual(timedOut);
    });

    it("joins held storage work when the caller cancels", async () => {
      const storage = installStorageBoundary();
      const member = await briefMember();
      await publishInstructions(member, "Write in Danish.");
      const controller = new AbortController();
      const cancellation = new Error("language storage caller cancelled");
      const arrived = createDeferredPromise<void>(context.signal);
      const release = createDeferredPromise<void>(context.signal);
      const finished = createDeferredPromise<void>(context.signal);
      onTestFinished(() => {
        if (!release.settled()) {
          release.resolve();
        }
      });
      storage.beforeRead("/manifest.json", async () => {
        arrived.resolve();
        await release.promise;
        finished.resolve();
      });

      const pending = setupApp({
        context,
        routes: morningBriefCompositionPreviewRoutes,
        signal: controller.signal,
        rethrowErrors: true,
      })(morningBriefCompositionPreviewContract).compose({
        headers: sessionHeaders(member),
        body: { anchor: new Date(now()).toISOString() },
      });

      await arrived.promise;
      controller.abort(cancellation);
      release.resolve();
      await finished.promise;
      await expect(pending).rejects.toThrow(cancellation.message);
      expect(archiveReads(storage)).toStrictEqual([]);
    }, 60_000);
  });
});
