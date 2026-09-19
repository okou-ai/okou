import { randomUUID } from "node:crypto";

import type { Capability } from "@okouai/api-contracts/contracts/capabilities";
import {
  COMPUTER_USE_FILESYSTEM_PLUGIN,
  COMPUTER_USE_PLUGIN_CALL_KIND,
  computerUsePluginCapability,
  computerUsePluginToolCapability,
} from "@okouai/api-contracts/contracts/computer-use-plugins";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import type { ErasureSubject } from "@okouai/db/operations/account-erasure";
import { aroundEach, describe, expect, it, onTestFinished } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { withMockNowForTest } from "../../../lib/time";
import {
  closeErasureSubjectFixture,
  removeErasureSubjectsFixture,
  withErasureSubjectClosureCommitBarrierFixture,
} from "../../../test-fixtures/account-erasure-subject";
import {
  createLegacyInlineScreenshotFixture,
  withComputerUseContentReadBarrierFixture,
} from "../../../test-fixtures/computer-use-content-get-erasure";
import { settleIncludingAbort } from "../../utils";
import {
  createBddApi,
  expectApiError,
  type ApiTestUser,
} from "./helpers/api-bdd";
import { createAuthOrgAgentsBddApi } from "./helpers/api-bdd-auth-org";
import { mockClerkMembership } from "./helpers/api-bdd-clerk";
import {
  computerUseToken,
  createComputerUseBddApi,
  type ComputerUseS3Fake,
} from "./helpers/api-bdd-computer-use";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";

const context = testContext();
const bdd = createBddApi(context);
const authOrg = createAuthOrgAgentsBddApi(context);
const computerUse = createComputerUseBddApi(context);

const STARTED_AT_MS = Date.parse("2026-09-19T02:00:00.000Z");
const BLOCKED = { interval: 10, timeout: 10_000 } as const;
const CASE_TIMEOUT_MS = 30_000;

type ContentKind = "screenshot" | "plugin";
type ProviderPhase = "getObject" | "body";
type Settled<T> = Awaited<ReturnType<typeof settleIncludingAbort<T>>>;

interface StoredContentFixture {
  readonly kind: ContentKind;
  readonly commandId: string;
  readonly host: { readonly hostId: string; readonly hostToken: string };
  readonly bytes: Buffer;
  readonly contentType: string;
  readonly fileName: string | null;
}

interface DownloadedContent {
  readonly bytes: Buffer;
  readonly contentType: string | null;
  readonly contentLength: string | null;
  readonly cacheControl: string | null;
  readonly contentDisposition: string | null;
  readonly fileName: string | null;
}

interface OwnedOperation<T> {
  readonly settled: Promise<Settled<T>>;
  readonly acceptFailureAfter: (
    inspect: (error: unknown) => void | Promise<void>,
  ) => Promise<void>;
}

interface OperationOwner {
  readonly start: <T>(operation: Promise<T>) => OwnedOperation<T>;
  readonly abortOnExit: (controller: AbortController) => void;
}

interface OperationRecord {
  readonly settled: Promise<Settled<unknown>>;
  failureAccepted: boolean;
}

aroundEach(async (runTest) => {
  await withMockNowForTest(STARTED_AT_MS, runTest);
});

function orgScoped(
  actor: ApiTestUser,
): ApiTestUser & { readonly orgId: string } {
  if (actor.orgId === null) {
    throw new Error("Computer Use content reads require an organization");
  }
  return { ...actor, orgId: actor.orgId };
}

function valueOf<T>(settled: Settled<T>): T {
  if (!settled.ok) {
    throw settled.error;
  }
  return settled.value;
}

/**
 * Owns every concurrently started reader, closure and cancellation branch.
 * Cleanup releases selected PostgreSQL/provider barriers, aborts only registered
 * controllers and joins all operations before surfacing any unaccepted error.
 */
async function withOperationOwnership<T>(
  release: () => void | Promise<void>,
  work: (owner: OperationOwner) => Promise<T>,
): Promise<T> {
  const operations: OperationRecord[] = [];
  const controllers = new Set<AbortController>();
  const owner: OperationOwner = {
    start: <TValue>(operation: Promise<TValue>) => {
      const settled = settleIncludingAbort(operation);
      const record: OperationRecord = { settled, failureAccepted: false };
      operations.push(record);
      return {
        settled,
        acceptFailureAfter: async (inspect) => {
          const result = await settled;
          if (result.ok) {
            throw new Error("Expected the owned content operation to fail");
          }
          await inspect(result.error);
          record.failureAccepted = true;
        },
      };
    },
    abortOnExit: (controller) => {
      controllers.add(controller);
    },
  };

  const workResult = await settleIncludingAbort(work(owner));
  const cleanupResult = await settleIncludingAbort(async () => {
    const released = Promise.resolve(release());
    for (const controller of controllers) {
      if (!controller.signal.aborted) {
        controller.abort(new DOMException("Test cleanup", "AbortError"));
      }
    }
    await released;
  });
  const joined = await Promise.all(
    operations.map(async (record) => {
      return { record, result: await record.settled };
    }),
  );

  const errors: unknown[] = [];
  if (!workResult.ok) {
    errors.push(workResult.error);
  }
  if (!cleanupResult.ok) {
    errors.push(cleanupResult.error);
  }
  for (const { record, result } of joined) {
    if (
      !result.ok &&
      !record.failureAccepted &&
      (workResult.ok || !Object.is(result.error, workResult.error))
    ) {
      errors.push(result.error);
    }
  }
  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw new AggregateError(
      errors,
      "Concurrent Computer Use content work and cleanup failed",
    );
  }
  if (!workResult.ok) {
    throw workResult.error;
  }
  return workResult.value;
}

/** The race is observation-only; the operation remains registered and joined. */
async function waitForBarrierEntry<TEntry, TValue>(
  entered: Promise<TEntry>,
  operation: OwnedOperation<TValue>,
): Promise<TEntry> {
  const first = await Promise.race([
    entered.then(
      (value) => {
        return { kind: "entered" as const, value };
      },
      (error: unknown) => {
        return { kind: "entryFailure" as const, error };
      },
    ),
    operation.settled.then((result) => {
      return { kind: "operation" as const, result };
    }),
  ]);
  if (first.kind === "entered") {
    return first.value;
  }
  if (first.kind === "entryFailure") {
    throw first.error;
  }
  if (!first.result.ok) {
    throw first.result.error;
  }
  throw new Error("Content operation completed before barrier entry");
}

function startClosure(
  owner: OperationOwner,
  subject: ErasureSubject,
): OwnedOperation<{ readonly jobId: string }> {
  const closing = owner.start(closeErasureSubjectFixture(subject));
  onTestFinished(async () => {
    const result = await closing.settled;
    if (result.ok) {
      await removeErasureSubjectsFixture([result.value.jobId]);
    }
  });
  return closing;
}

function closeSubject(
  subject: ErasureSubject,
): Promise<{ readonly jobId: string }> {
  const closing = closeErasureSubjectFixture(subject);
  onTestFinished(async () => {
    const { jobId } = await closing;
    await removeErasureSubjectsFixture([jobId]);
  });
  return closing;
}

function filesystemCapabilities(): readonly string[] {
  return [
    COMPUTER_USE_PLUGIN_CALL_KIND,
    computerUsePluginCapability(COMPUTER_USE_FILESYSTEM_PLUGIN),
    computerUsePluginToolCapability(
      COMPUTER_USE_FILESYSTEM_PLUGIN,
      "read_text_file",
    ),
  ];
}

async function enableComputerUsePlugins(
  actor: ApiTestUser & { readonly orgId: string },
): Promise<void> {
  await updateFeatureSwitchesForUser(
    context,
    {
      userId: actor.userId,
      orgId: actor.orgId,
      orgRole: actor.orgRole,
    },
    { [FeatureSwitchKey.ComputerUseDesktopPlugins]: true },
  );
}

function agentTokenFor(
  actor: ApiTestUser & { readonly orgId: string },
  hostId: string | undefined,
  capabilities: readonly Capability[] = ["computer-use:write"],
): string {
  mockClerkMembership(context, actor, "org:admin");
  return computerUseToken({
    userId: actor.userId,
    orgId: actor.orgId,
    capabilities,
    ...(hostId ? { computerUseHostId: hostId } : {}),
    // Command content auth deliberately retains the run-less Agent-token shape.
    runId: `run_${randomUUID()}`,
  }).token;
}

async function createStoredContent(
  kind: ContentKind,
  actor: ApiTestUser & { readonly orgId: string },
): Promise<StoredContentFixture> {
  if (kind === "screenshot") {
    const host = await computerUse.startComputerUseHost(actor, {
      hostName: "Screenshot Desktop",
    });
    const created = await computerUse.createComputerUseReadCommand(actor, {
      kind: "app.state",
      app: "Safari",
    });
    const claimed = await computerUse.claimNextComputerUseCommand(
      host.hostToken,
    );
    expect(claimed).toMatchObject({
      status: "command",
      command: { id: created.commandId },
    });
    const bytes = Buffer.from("private screenshot bytes 中文🙂");
    await computerUse.completeComputerUseCommandWith(
      host.hostToken,
      created.commandId,
      {
        status: "succeeded",
        result: {
          snapshotId: "content_fence_screenshot",
          screenshot: `data:image/png;base64,${bytes.toString("base64")}`,
          screenshotWidth: 1440,
          screenshotHeight: 900,
        },
      },
    );
    return {
      kind,
      commandId: created.commandId,
      host,
      bytes,
      contentType: "image/png",
      fileName: null,
    };
  }

  await enableComputerUsePlugins(actor);
  const host = await computerUse.startComputerUseHost(actor, {
    hostName: "Plugin Desktop",
    supportedCapabilities: filesystemCapabilities(),
  });
  const created = await computerUse.createComputerUsePluginCommand(actor, {
    plugin: "filesystem",
    tool: "read_text_file",
    arguments: { path: "/tmp/private-notes.txt" },
  });
  const claimed = await computerUse.claimNextComputerUseCommand(
    host.hostToken,
    filesystemCapabilities(),
  );
  expect(claimed).toMatchObject({
    status: "command",
    command: { id: created.commandId },
  });
  const bytes = Buffer.from("private plugin bytes 中文🙂");
  await computerUse.completeComputerUseCommandWith(
    host.hostToken,
    created.commandId,
    {
      status: "succeeded",
      result: {
        plugin: "filesystem",
        tool: "read_text_file",
        sizeBytes: bytes.length,
        pluginContent: {
          dataBase64: bytes.toString("base64"),
          mimeType: "text/plain",
          fileName: 'private"notes".txt',
        },
      },
    },
  );
  return {
    kind,
    commandId: created.commandId,
    host,
    bytes,
    contentType: "text/plain",
    fileName: "privatenotes.txt",
  };
}

async function requestContent(
  kind: ContentKind,
  auth: ApiTestUser | { readonly bearer: string } | null,
  commandId: string,
  statuses: readonly (200 | 401 | 403 | 404)[],
  signal?: AbortSignal,
) {
  return kind === "screenshot"
    ? await computerUse.requestComputerUseScreenshot(
        auth,
        commandId,
        statuses,
        signal,
      )
    : await computerUse.requestComputerUsePluginContent(
        auth,
        commandId,
        statuses,
        signal,
      );
}

async function downloadContent(
  fixture: Pick<StoredContentFixture, "kind" | "commandId">,
  auth: ApiTestUser | { readonly bearer: string },
  signal?: AbortSignal,
): Promise<DownloadedContent> {
  if (fixture.kind === "screenshot") {
    const downloaded = await computerUse.downloadComputerUseScreenshot(
      auth,
      fixture.commandId,
      signal,
    );
    return {
      ...downloaded,
      contentDisposition: null,
      fileName: null,
    };
  }
  return await computerUse.downloadComputerUsePluginContent(
    auth,
    fixture.commandId,
    signal,
  );
}

function expectOpaqueNotFound(kind: ContentKind, body: unknown): void {
  expect(body).toStrictEqual({
    error: {
      message:
        kind === "screenshot"
          ? "Computer-use command screenshot not found"
          : "Computer-use plugin content not found",
      code: "NOT_FOUND",
    },
  });
}

function expectDownload(
  downloaded: DownloadedContent,
  fixture: StoredContentFixture,
): void {
  expect(downloaded.bytes.equals(fixture.bytes)).toBeTruthy();
  expect(downloaded.contentType).toBe(fixture.contentType);
  expect(downloaded.contentLength).toBe(String(fixture.bytes.length));
  expect(downloaded.cacheControl).toBe("private, no-store");
  expect(downloaded.fileName).toBe(fixture.fileName);
  if (fixture.kind === "plugin") {
    expect(downloaded.contentDisposition).toBe(
      'attachment; filename="privatenotes.txt"',
    );
  } else {
    expect(downloaded.contentDisposition).toBeNull();
  }
}

function selectedProviderBarrier(
  fake: ComputerUseS3Fake,
  phase: ProviderPhase,
) {
  return phase === "getObject" ? fake.holdNextGetObject() : fake.holdNextBody();
}

describe("Computer Use binary content account-erasure fence", () => {
  it.each(["screenshot", "plugin"] as const)(
    "preserves %s auth, exact ownership, bytes and response headers",
    { timeout: CASE_TIMEOUT_MS },
    async (kind) => {
      const fake = computerUse.installComputerUseS3Fake();
      const actor = orgScoped(bdd.user());
      const sameOrgPeer = orgScoped(bdd.user({ orgId: actor.orgId }));
      const foreignOrg = orgScoped(bdd.user({ orgId: `org_${randomUUID()}` }));
      const fixture = await createStoredContent(kind, actor);

      const unauthenticated = await requestContent(
        kind,
        null,
        fixture.commandId,
        [401],
      );
      expectApiError(unauthenticated.body);
      const missingOrganization = await requestContent(
        kind,
        bdd.user({ orgId: null }),
        fixture.commandId,
        [401],
      );
      expectApiError(missingOrganization.body);

      expectDownload(await downloadContent(fixture, actor), fixture);
      const { token: pat } = await authOrg.createCliToken(actor);
      mockClerkMembership(context, actor, "org:admin");
      expectDownload(await downloadContent(fixture, { bearer: pat }), fixture);
      const agentToken = agentTokenFor(actor, fixture.host.hostId);
      expectDownload(
        await downloadContent(fixture, { bearer: agentToken }),
        fixture,
      );

      const wrongHost = await computerUse.startComputerUseHost(actor, {
        hostName: "Wrong Host",
      });
      const wrongHostRead = await requestContent(
        kind,
        { bearer: agentTokenFor(actor, wrongHost.hostId) },
        fixture.commandId,
        [404],
      );
      expectOpaqueNotFound(kind, wrongHostRead.body);
      const missingCapability = await requestContent(
        kind,
        {
          bearer: agentTokenFor(actor, fixture.host.hostId, []),
        },
        fixture.commandId,
        [403],
      );
      expectApiError(missingCapability.body);
      const unbound = await requestContent(
        kind,
        { bearer: agentTokenFor(actor, undefined) },
        fixture.commandId,
        [403],
      );
      expect(unbound.body).toStrictEqual({
        error: {
          message: "Computer-use host is not authorized for this run",
          code: "FORBIDDEN",
        },
      });

      for (const foreignActor of [sameOrgPeer, foreignOrg]) {
        const denied = await requestContent(
          kind,
          foreignActor,
          fixture.commandId,
          [404],
        );
        expectOpaqueNotFound(kind, denied.body);
      }
      expect(fake.gets).toHaveLength(3);
      expect(
        fake.gets.every((get) => {
          return get.signal instanceof AbortSignal;
        }),
      ).toBeTruthy();
    },
  );

  it.each(["screenshot", "plugin"] as const)(
    "retains %s missing, non-success and null-pointer opacity without S3",
    { timeout: CASE_TIMEOUT_MS },
    async (kind) => {
      const fake = computerUse.installComputerUseS3Fake();
      const actor = orgScoped(bdd.user());
      if (kind === "plugin") {
        await enableComputerUsePlugins(actor);
      }
      const host = await computerUse.startComputerUseHost(actor, {
        hostName: "Pointer Desktop",
        ...(kind === "plugin"
          ? { supportedCapabilities: filesystemCapabilities() }
          : {}),
      });
      const unknown = await requestContent(kind, actor, randomUUID(), [404]);
      expectOpaqueNotFound(kind, unknown.body);

      const created =
        kind === "screenshot"
          ? await computerUse.createComputerUseReadCommand(actor, {
              kind: "app.state",
              app: "Safari",
            })
          : await computerUse.createComputerUsePluginCommand(actor, {
              plugin: "filesystem",
              tool: "read_text_file",
              arguments: { path: "/tmp/missing.txt" },
            });
      const queued = await requestContent(
        kind,
        actor,
        created.commandId,
        [404],
      );
      expectOpaqueNotFound(kind, queued.body);
      await computerUse.claimNextComputerUseCommand(
        host.hostToken,
        kind === "plugin" ? filesystemCapabilities() : undefined,
      );
      await computerUse.completeComputerUseCommandWith(
        host.hostToken,
        created.commandId,
        {
          status: "succeeded",
          result:
            kind === "screenshot"
              ? { screenshot: null }
              : { pluginContent: null },
        },
      );
      const pointerNull = await requestContent(
        kind,
        actor,
        created.commandId,
        [404],
      );
      expectOpaqueNotFound(kind, pointerNull.body);
      expect(fake.gets).toStrictEqual([]);
    },
  );

  it(
    "retains the legacy inline screenshot decoder without an S3 read",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const fake = computerUse.installComputerUseS3Fake();
      const actor = orgScoped(bdd.user());
      const host = await computerUse.startComputerUseHost(actor, {
        hostName: "Legacy Desktop",
      });
      const bytes = Buffer.from("retained legacy inline bytes 中文🙂");
      const legacy = await createLegacyInlineScreenshotFixture({
        orgId: actor.orgId,
        userId: actor.userId,
        hostId: host.hostId,
        screenshot: `data:image/webp;base64,${bytes.toString("base64")}`,
        createdAt: new Date(STARTED_AT_MS),
      });
      const downloaded = await computerUse.downloadComputerUseScreenshot(
        actor,
        legacy.commandId,
      );
      expect(downloaded.bytes.equals(bytes)).toBeTruthy();
      expect(downloaded.contentType).toBe("image/webp");
      expect(downloaded.contentLength).toBe(String(bytes.length));
      expect(downloaded.cacheControl).toBe("private, no-store");
      expect(fake.gets).toStrictEqual([]);
    },
  );

  it.each([
    ["screenshot", "user"],
    ["screenshot", "organization"],
    ["plugin", "user"],
    ["plugin", "organization"],
  ] as const)(
    "denies closed %s content for the %s subject before S3 and restores exact bytes",
    { timeout: CASE_TIMEOUT_MS },
    async (kind, subjectKind) => {
      const fake = computerUse.installComputerUseS3Fake();
      const actor = orgScoped(bdd.user());
      const fixture = await createStoredContent(kind, actor);
      const before = await computerUse.readComputerUseCommand(
        actor,
        fixture.commandId,
      );
      expectDownload(await downloadContent(fixture, actor), fixture);
      const getsBeforeDenial = fake.gets.length;
      context.mocks.ably.publish.mockClear();

      const closed = await closeSubject({
        subjectKind,
        subjectId: subjectKind === "user" ? actor.userId : actor.orgId,
      });
      const denied = await requestContent(
        kind,
        actor,
        fixture.commandId,
        [404],
      );
      expectOpaqueNotFound(kind, denied.body);
      expect(JSON.stringify(denied.body)).not.toContain(
        fixture.bytes.toString("base64"),
      );
      expect(fake.gets).toHaveLength(getsBeforeDenial);
      expect(context.mocks.ably.publish).not.toHaveBeenCalled();

      await removeErasureSubjectsFixture([closed.jobId]);
      expectDownload(await downloadContent(fixture, actor), fixture);
      const after = await computerUse.readComputerUseCommand(
        actor,
        fixture.commandId,
      );
      expect(after).toStrictEqual(before);
      expect(context.mocks.ably.publish).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["screenshot", "getObject"],
    ["screenshot", "body"],
    ["plugin", "getObject"],
    ["plugin", "body"],
  ] as const)(
    "holds %s admission through the complete S3 %s phase before closure",
    { timeout: CASE_TIMEOUT_MS },
    async (kind, phase) => {
      const fake = computerUse.installComputerUseS3Fake();
      const actor = orgScoped(bdd.user());
      const unrelated = orgScoped(bdd.user());
      const fixture = await createStoredContent(kind, actor);
      const unrelatedFixture = await createStoredContent(kind, unrelated);
      const providerBarrier = selectedProviderBarrier(fake, phase);
      const controller = new AbortController();

      await withComputerUseContentReadBarrierFixture(
        {
          orgId: actor.orgId,
          userId: actor.userId,
          commandId: fixture.commandId,
          stopAt: "projection",
          work: async (databaseBarrier) => {
            await withOperationOwnership(
              () => {
                providerBarrier.release();
                databaseBarrier.release();
              },
              async (owner) => {
                owner.abortOnExit(controller);
                const reading = owner.start(
                  downloadContent(fixture, actor, controller.signal),
                );
                const enteredDatabase = await waitForBarrierEntry(
                  databaseBarrier.entered,
                  reading,
                );
                expect(enteredDatabase).toMatchObject({
                  lockTimeout: "1s",
                  statementTimeout: "5s",
                  transactionTimeout: "0",
                  rowCount: null,
                });
                databaseBarrier.release();
                const enteredProvider = await waitForBarrierEntry(
                  providerBarrier.entered,
                  reading,
                );
                expect(enteredProvider.signal).toBeDefined();

                const closing = startClosure(owner, {
                  subjectKind: "user",
                  subjectId: actor.userId,
                });
                await expect
                  .poll(databaseBarrier.blockedWaiterCount, BLOCKED)
                  .toBeGreaterThanOrEqual(1);
                expectDownload(
                  await downloadContent(unrelatedFixture, unrelated),
                  unrelatedFixture,
                );

                providerBarrier.release();
                expectDownload(valueOf(await reading.settled), fixture);
                const closed = valueOf(await closing.settled);
                const getsBeforeDenied = fake.gets.length;
                const denied = await requestContent(
                  kind,
                  actor,
                  fixture.commandId,
                  [404],
                );
                expectOpaqueNotFound(kind, denied.body);
                expect(fake.gets).toHaveLength(getsBeforeDenied);
                await removeErasureSubjectsFixture([closed.jobId]);
              },
            );
          },
        },
        context.signal,
      );

      expectDownload(await downloadContent(fixture, actor), fixture);
    },
  );

  it.each(["screenshot", "plugin"] as const)(
    "makes closure-first win before the %s pointer projection or S3 read",
    { timeout: CASE_TIMEOUT_MS },
    async (kind) => {
      const fake = computerUse.installComputerUseS3Fake();
      const actor = orgScoped(bdd.user());
      const fixture = await createStoredContent(kind, actor);
      const getsBefore = fake.gets.length;

      await withErasureSubjectClosureCommitBarrierFixture(async (barrier) => {
        await withOperationOwnership(barrier.release, async (owner) => {
          const closing = startClosure(owner, {
            subjectKind: "organization",
            subjectId: actor.orgId,
          });
          await waitForBarrierEntry(barrier.entered, closing);
          const reading = owner.start(
            requestContent(kind, actor, fixture.commandId, [404]),
          );
          await expect
            .poll(barrier.blockedWaiterCount, BLOCKED)
            .toBeGreaterThanOrEqual(1);
          expect(fake.gets).toHaveLength(getsBefore);
          barrier.release();
          const closed = valueOf(await closing.settled);
          const denied = valueOf(await reading.settled);
          expectOpaqueNotFound(kind, denied.body);
          expect(fake.gets).toHaveLength(getsBefore);
          await removeErasureSubjectsFixture([closed.jobId]);
        });
      }, context.signal);
      expectDownload(await downloadContent(fixture, actor), fixture);
    },
  );

  it.each(["screenshot", "plugin"] as const)(
    "keeps same-owner %s reads compatible while one body is held",
    { timeout: CASE_TIMEOUT_MS },
    async (kind) => {
      const fake = computerUse.installComputerUseS3Fake();
      const actor = orgScoped(bdd.user());
      const fixture = await createStoredContent(kind, actor);
      const providerBarrier = fake.holdNextBody();

      await withComputerUseContentReadBarrierFixture(
        {
          orgId: actor.orgId,
          userId: actor.userId,
          commandId: fixture.commandId,
          stopAt: "projection",
          work: async (databaseBarrier) => {
            await withOperationOwnership(
              () => {
                providerBarrier.release();
                databaseBarrier.release();
              },
              async (owner) => {
                const first = owner.start(downloadContent(fixture, actor));
                await waitForBarrierEntry(databaseBarrier.entered, first);
                databaseBarrier.release();
                await waitForBarrierEntry(providerBarrier.entered, first);
                expectDownload(await downloadContent(fixture, actor), fixture);
                await expect
                  .poll(databaseBarrier.blockedWaiterCount, BLOCKED)
                  .toBe(0);
                providerBarrier.release();
                expectDownload(valueOf(await first.settled), fixture);
              },
            );
          },
        },
        context.signal,
      );
    },
  );

  it.each([
    ["screenshot", "getObject"],
    ["screenshot", "body"],
    ["plugin", "getObject"],
    ["plugin", "body"],
  ] as const)(
    "cancels and joins an in-flight %s %s read, then recovers",
    { timeout: CASE_TIMEOUT_MS },
    async (kind, phase) => {
      const fake = computerUse.installComputerUseS3Fake();
      const actor = orgScoped(bdd.user());
      const fixture = await createStoredContent(kind, actor);
      const providerBarrier = selectedProviderBarrier(fake, phase);
      const controller = new AbortController();

      await withOperationOwnership(providerBarrier.release, async (owner) => {
        owner.abortOnExit(controller);
        const reading = owner.start(
          downloadContent(fixture, actor, controller.signal),
        );
        const entered = await waitForBarrierEntry(
          providerBarrier.entered,
          reading,
        );
        expect(entered.signal).toBeDefined();
        controller.abort(new DOMException("Content read ended", "AbortError"));
        await reading.acceptFailureAfter((error) => {
          expect(String(error)).toMatch(
            /AbortError|Unknown response status 500/,
          );
          expect(entered.signal?.aborted).toBeTruthy();
        });
      });

      expectDownload(await downloadContent(fixture, actor), fixture);
    },
  );

  it.each([
    ["screenshot", "getObject"],
    ["screenshot", "body"],
    ["plugin", "getObject"],
    ["plugin", "body"],
  ] as const)(
    "propagates a real %s %s failure without converting it to 404",
    { timeout: CASE_TIMEOUT_MS },
    async (kind, phase) => {
      const fake = computerUse.installComputerUseS3Fake();
      const actor = orgScoped(bdd.user());
      const fixture = await createStoredContent(kind, actor);
      const providerError = new Error(`${kind} ${phase} provider failure`);
      if (phase === "getObject") {
        fake.failNextGetObject(providerError);
      } else {
        fake.failNextBody(providerError);
      }

      await expect(
        requestContent(kind, actor, fixture.commandId, [200, 404]),
      ).rejects.toThrow(/Unknown response status 500/);
      expectDownload(await downloadContent(fixture, actor), fixture);
    },
  );

  it.each(["screenshot", "plugin"] as const)(
    "observes a %s GetObject failure before the reserved body barrier enters, joins closure, and recovers",
    { timeout: CASE_TIMEOUT_MS },
    async (kind) => {
      const fake = computerUse.installComputerUseS3Fake();
      const actor = orgScoped(bdd.user());
      const fixture = await createStoredContent(kind, actor);
      const bodyBarrier = fake.holdNextBody();
      fake.failNextGetObject(
        new Error(`${kind} pre-entry GetObject provider failure`),
      );

      await withComputerUseContentReadBarrierFixture(
        {
          orgId: actor.orgId,
          userId: actor.userId,
          commandId: fixture.commandId,
          stopAt: "projection",
          work: async (databaseBarrier) => {
            await withOperationOwnership(
              () => {
                bodyBarrier.release();
                databaseBarrier.release();
              },
              async (owner) => {
                const reading = owner.start(
                  requestContent(kind, actor, fixture.commandId, [200, 404]),
                );
                await waitForBarrierEntry(databaseBarrier.entered, reading);

                const closing = startClosure(owner, {
                  subjectKind: "user",
                  subjectId: actor.userId,
                });
                await expect
                  .poll(databaseBarrier.blockedWaiterCount, BLOCKED)
                  .toBeGreaterThanOrEqual(1);
                databaseBarrier.release();

                await expect(
                  waitForBarrierEntry(bodyBarrier.entered, reading),
                ).rejects.toThrow(/Unknown response status 500/);
                await reading.acceptFailureAfter((error) => {
                  expect(String(error)).toMatch(/Unknown response status 500/);
                });

                const closed = valueOf(await closing.settled);
                await removeErasureSubjectsFixture([closed.jobId]);
                bodyBarrier.release();

                const recovered = owner.start(downloadContent(fixture, actor));
                const enteredBody = await waitForBarrierEntry(
                  bodyBarrier.entered,
                  recovered,
                );
                expect(enteredBody.signal).toBeDefined();
                expectDownload(valueOf(await recovered.settled), fixture);
              },
            );
          },
        },
        context.signal,
      );
    },
  );

  it.each(["screenshot", "plugin"] as const)(
    "rejects a pre-aborted %s read before S3 and retains healthy recovery",
    { timeout: CASE_TIMEOUT_MS },
    async (kind) => {
      const fake = computerUse.installComputerUseS3Fake();
      const actor = orgScoped(bdd.user());
      const fixture = await createStoredContent(kind, actor);
      const getsBefore = fake.gets.length;
      const controller = new AbortController();
      controller.abort(new DOMException("Pre-aborted", "AbortError"));

      const failed = await settleIncludingAbort(
        downloadContent(fixture, actor, controller.signal),
      );
      expect(failed.ok).toBeFalsy();
      if (!failed.ok) {
        expect(String(failed.error)).toMatch(
          /AbortError|Unknown response status 500/,
        );
      }
      expect(fake.gets).toHaveLength(getsBefore);
      expectDownload(await downloadContent(fixture, actor), fixture);
    },
  );

  it.each(["screenshot", "plugin"] as const)(
    "propagates the %s B1 lock timeout and never starts S3",
    { timeout: CASE_TIMEOUT_MS },
    async (kind) => {
      const fake = computerUse.installComputerUseS3Fake();
      const actor = orgScoped(bdd.user());
      const fixture = await createStoredContent(kind, actor);
      const getsBefore = fake.gets.length;

      await withErasureSubjectClosureCommitBarrierFixture(async (barrier) => {
        await withOperationOwnership(barrier.release, async (owner) => {
          const closing = startClosure(owner, {
            subjectKind: "user",
            subjectId: actor.userId,
          });
          await waitForBarrierEntry(barrier.entered, closing);
          const reading = owner.start(
            requestContent(kind, actor, fixture.commandId, [200, 404]),
          );
          await expect
            .poll(barrier.blockedWaiterCount, BLOCKED)
            .toBeGreaterThanOrEqual(1);
          await reading.acceptFailureAfter((error) => {
            expect(String(error)).toMatch(/Unknown response status 500/);
          });
          expect(fake.gets).toHaveLength(getsBefore);
          barrier.release();
          const closed = valueOf(await closing.settled);
          await removeErasureSubjectsFixture([closed.jobId]);
        });
      }, context.signal);
      expectDownload(await downloadContent(fixture, actor), fixture);
    },
  );

  it.each(["screenshot", "plugin"] as const)(
    "pins the %s open and closed SQL/control sequences separately from S3 duration",
    { timeout: CASE_TIMEOUT_MS },
    async (kind) => {
      const fake = computerUse.installComputerUseS3Fake();
      const actor = orgScoped(bdd.user());
      const fixture = await createStoredContent(kind, actor);

      await withComputerUseContentReadBarrierFixture(
        {
          orgId: actor.orgId,
          userId: actor.userId,
          commandId: fixture.commandId,
          stopAt: "commit",
          work: async (barrier) => {
            await withOperationOwnership(barrier.release, async (owner) => {
              const reading = owner.start(downloadContent(fixture, actor));
              const entered = await waitForBarrierEntry(
                barrier.entered,
                reading,
              );
              expect(entered).toMatchObject({
                lockTimeout: "1s",
                statementTimeout: "5s",
                transactionTimeout: "0",
                rowCount: null,
              });
              const statements = barrier.statements();
              expect(statements).toHaveLength(8);
              expect(statements[0]).toContain("begin");
              expect(statements[1]).toContain("set_config('lock_timeout'");
              expect(statements[2]).toContain("set_config('statement_timeout'");
              expect(statements[3]).toContain("erasure_isolation_probe");
              expect(statements[3]).toContain("pg_advisory_xact_lock_shared");
              expect(statements[4]).toContain("pg_advisory_xact_lock_shared");
              expect(statements[5]).toContain('from "account_erasure_jobs"');
              expect(statements[6]).toContain('from "computer_use_commands"');
              expect(statements[6]).toContain(" limit ");
              expect(statements[6]).not.toContain(" join ");
              expect(statements[6]).not.toContain(" for ");
              expect(statements[7]).toBe("commit");
              barrier.release();
              expectDownload(valueOf(await reading.settled), fixture);
            });
          },
        },
        context.signal,
      );

      const closed = await closeSubject({
        subjectKind: "organization",
        subjectId: actor.orgId,
      });
      const getsBeforeClosed = fake.gets.length;
      await withComputerUseContentReadBarrierFixture(
        {
          orgId: actor.orgId,
          userId: actor.userId,
          commandId: fixture.commandId,
          stopAt: "commit",
          work: async (barrier) => {
            await withOperationOwnership(barrier.release, async (owner) => {
              const reading = owner.start(
                requestContent(kind, actor, fixture.commandId, [404]),
              );
              await waitForBarrierEntry(barrier.entered, reading);
              const statements = barrier.statements();
              expect(statements).toHaveLength(7);
              expect(statements[5]).toContain('from "account_erasure_jobs"');
              expect(statements[6]).toBe("commit");
              expect(
                statements.some((statement) => {
                  return statement.includes('from "computer_use_commands"');
                }),
              ).toBeFalsy();
              barrier.release();
              const denied = valueOf(await reading.settled);
              expectOpaqueNotFound(kind, denied.body);
            });
          },
        },
        context.signal,
      );
      expect(fake.gets).toHaveLength(getsBeforeClosed);
      await removeErasureSubjectsFixture([closed.jobId]);
    },
  );

  it(
    "releases provider and database barriers and joins reader plus exact closure on early callback exit",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const fake = computerUse.installComputerUseS3Fake();
      const actor = orgScoped(bdd.user());
      const fixture = await createStoredContent("screenshot", actor);
      const providerBarrier = fake.holdNextBody();
      let earlyRead: OwnedOperation<DownloadedContent> | undefined;
      let earlyClosure: OwnedOperation<{ readonly jobId: string }> | undefined;

      await expect(
        withComputerUseContentReadBarrierFixture(
          {
            orgId: actor.orgId,
            userId: actor.userId,
            commandId: fixture.commandId,
            stopAt: "projection",
            work: async (databaseBarrier) => {
              await withOperationOwnership(
                () => {
                  providerBarrier.release();
                  databaseBarrier.release();
                },
                async (owner) => {
                  earlyRead = owner.start(downloadContent(fixture, actor));
                  await waitForBarrierEntry(databaseBarrier.entered, earlyRead);
                  databaseBarrier.release();
                  await waitForBarrierEntry(providerBarrier.entered, earlyRead);
                  earlyClosure = startClosure(owner, {
                    subjectKind: "user",
                    subjectId: actor.userId,
                  });
                  await expect
                    .poll(databaseBarrier.blockedWaiterCount, BLOCKED)
                    .toBeGreaterThanOrEqual(1);
                  throw new Error("deliberate content callback exit");
                },
              );
            },
          },
          context.signal,
        ),
      ).rejects.toThrow("deliberate content callback exit");
      if (!earlyRead || !earlyClosure) {
        throw new Error("Expected the early-exit content operations to start");
      }
      expectDownload(valueOf(await earlyRead.settled), fixture);
      const closed = valueOf(await earlyClosure.settled);
      await removeErasureSubjectsFixture([closed.jobId]);
      expectDownload(await downloadContent(fixture, actor), fixture);
    },
  );

  it(
    "states the final abort/COMMIT boundary by joining acquired bytes before suppressing the response",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const fake = computerUse.installComputerUseS3Fake();
      const actor = orgScoped(bdd.user());
      const fixture = await createStoredContent("plugin", actor);
      const controller = new AbortController();

      await withComputerUseContentReadBarrierFixture(
        {
          orgId: actor.orgId,
          userId: actor.userId,
          commandId: fixture.commandId,
          stopAt: "commit",
          work: async (barrier) => {
            await withOperationOwnership(barrier.release, async (owner) => {
              owner.abortOnExit(controller);
              const reading = owner.start(
                requestContent(
                  fixture.kind,
                  actor,
                  fixture.commandId,
                  [200, 404],
                  controller.signal,
                ),
              );
              await waitForBarrierEntry(barrier.entered, reading);
              expect(fake.gets).toHaveLength(1);
              controller.abort(
                new DOMException("After final check", "AbortError"),
              );
              barrier.release();
              await reading.acceptFailureAfter((error) => {
                expect(String(error)).toMatch(
                  /AbortError|Unknown response status 500/,
                );
              });
            });
          },
        },
        context.signal,
      );

      // The stored object and command remain readable. The prior response was
      // suppressed; neither already acquired bytes nor COMMIT can be recalled.
      expectDownload(await downloadContent(fixture, actor), fixture);
    },
  );
});
