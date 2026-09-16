import { randomUUID } from "node:crypto";

import { beforeEach, describe, expect, it, onTestFinished } from "vitest";
import { z } from "zod";

import { testContext } from "../../../__tests__/test-context";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { clearMockNow, mockNow, now, nowDate } from "../../../lib/time";
import {
  holdEmailOutboxClaim,
  holdEmailOutboxRemoval,
  rejectEmailOutboxCompletion,
  waitForEmailOutboxBlocked,
} from "../../../test-fixtures/email-outbox";
import { createDeferredPromise } from "../../utils";
import { createEmailOutboxStateApi } from "./helpers/email-outbox-state";

const context = testContext();
const outbox = createEmailOutboxStateApi(context);

// The exact key Resend sees. Two outbox rows can never derive the same one.
function providerKey(itemId: string): string {
  return `okou-email-outbox/v1/${itemId}`;
}

// Resend replays an accepted request for 24 hours; the retry bound below stays
// inside that window.
const SEND_LEASE_MS = 60_000;
const FIRST_BACKOFF_MS = 1000;
// A row is deliverable for 15 minutes after it was enqueued, whichever attempt
// reaches it.
const OUTBOX_TTL_MS = 15 * 60 * 1000;
const EXPIRED_BEFORE_PROVIDER_ERROR =
  "Email outbox item expired before contacting the provider";
const DRAIN_ROUTE = "POST /api/test/email-outbox-state/drain";

const providerOptionsSchema = z.object({ idempotencyKey: z.string() });

interface AcceptedEmail {
  readonly id: string;
  readonly key: string;
  readonly payload: string;
}

// Key order differs between a freshly rendered request and the same request
// decoded from its committed snapshot, so compare the values rather than the
// serialization the provider happened to receive.
function payloadIdentity(payload: unknown): string {
  return JSON.stringify(payload, (_key, value: unknown) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return value;
    }
    return Object.fromEntries(
      Object.entries(value).sort(([left], [right]) => {
        return left.localeCompare(right);
      }),
    );
  });
}

/**
 * A provider that owns one email per idempotency key: replaying a key returns
 * the email it already accepted, and a different payload under a live key is
 * rejected. Delivery count is therefore measured at the provider, not inferred
 * from two mock responses carrying the same literal id.
 */
function useIdempotentProvider(): {
  readonly accepted: () => readonly AcceptedEmail[];
} {
  const accepted = new Map<string, AcceptedEmail>();
  context.mocks.resend.send.mockImplementation(
    (payload: unknown, options: unknown) => {
      const { idempotencyKey } = providerOptionsSchema.parse(options);
      const identity = payloadIdentity(payload);
      const existing = accepted.get(idempotencyKey);
      if (existing) {
        return Promise.resolve(
          existing.payload === identity
            ? { data: { id: existing.id }, error: null }
            : {
                data: null,
                error: {
                  name: "invalid_idempotent_request",
                  message: "key already used with a different payload",
                  statusCode: 409,
                },
              },
        );
      }
      const email: AcceptedEmail = {
        id: `resend-accepted-${randomUUID()}`,
        key: idempotencyKey,
        payload: identity,
      };
      accepted.set(idempotencyKey, email);
      return Promise.resolve({ data: { id: email.id }, error: null });
    },
  );
  return {
    accepted: () => {
      return [...accepted.values()];
    },
  };
}

function providerCall(index: number): {
  readonly payload: unknown;
  readonly options: unknown;
} {
  const call = context.mocks.resend.send.mock.calls[index];
  if (!call) {
    throw new Error(`Expected a provider request at index ${index}`);
  }
  const [payload, options] = call;
  return { payload, options };
}

function pinTime(): number {
  const baseTime = now();
  mockNow(baseTime);
  onTestFinished(() => {
    clearMockNow();
  });
  return baseTime;
}

function fixtureAddress(): string {
  return `email-outbox-${randomUUID()}@example.test`;
}

function fixtureSubject(): string {
  return `Email outbox fixture ${randomUUID()}`;
}

async function seedItem(options: {
  readonly status: "pending" | "failed";
  readonly createdAt: Date;
}) {
  const toAddress = fixtureAddress();
  const subject = fixtureSubject();
  const item = await outbox.seedItem({
    toAddress,
    subject,
    ...options,
  });
  onTestFinished(async () => {
    await outbox.deleteItems([item.id]);
  });
  return { ...item, toAddress, subject };
}

beforeEach(() => {
  context.mocks.resend.send.mockReset();
  context.mocks.resend.send.mockResolvedValue({
    data: { id: `resend-${randomUUID()}` },
    error: null,
  });
  mockEnv("RESEND_FROM_DOMAIN", "okou.io");
  mockOptionalEnv("EMAIL_OUTBOX_DRAIN_DELAY_MS", "0");
});

describe("scoped email outbox drain", () => {
  it("drains and expires only explicitly selected items", async () => {
    const createdAt = nowDate();
    const expiredAt = new Date(0);
    const [dueItem, unrelatedDueSentinel, expiredPending, expiredFailed] =
      await Promise.all([
        seedItem({ status: "pending", createdAt }),
        seedItem({ status: "pending", createdAt }),
        seedItem({ status: "pending", createdAt: expiredAt }),
        seedItem({ status: "failed", createdAt: expiredAt }),
      ]);
    const unrelatedExpiredSentinel = await seedItem({
      status: "failed",
      createdAt: expiredAt,
    });

    const drained = await outbox.drainItems([dueItem.id]);

    expect(drained).toBe(1);
    expect(context.mocks.resend.send).toHaveBeenCalledTimes(1);
    expect(context.mocks.resend.send).toHaveBeenCalledWith(
      expect.objectContaining({
        from: "Okou <okou@okou.io>",
        to: dueItem.toAddress,
        subject: dueItem.subject,
      }),
      { idempotencyKey: providerKey(dueItem.id) },
    );
    expect((await outbox.readItem(dueItem.id))?.status).toBe("sent");
    expect((await outbox.readItem(unrelatedDueSentinel.id))?.status).toBe(
      "pending",
    );
    expect((await outbox.readItem(unrelatedExpiredSentinel.id))?.status).toBe(
      "failed",
    );

    const cleaned = await outbox.cleanupExpiredItems([
      expiredPending.id,
      expiredFailed.id,
    ]);

    expect(cleaned).toBe(2);
    await expect(outbox.readItem(expiredPending.id)).resolves.toBeNull();
    await expect(outbox.readItem(expiredFailed.id)).resolves.toBeNull();
    expect((await outbox.readItem(unrelatedDueSentinel.id))?.status).toBe(
      "pending",
    );
    expect((await outbox.readItem(unrelatedExpiredSentinel.id))?.status).toBe(
      "failed",
    );
  });

  it("skips a selected item already claimed by another drain", async () => {
    const toAddress = fixtureAddress();
    const subject = fixtureSubject();
    const seeded = await outbox.seedItem({
      toAddress,
      subject,
      status: "pending",
      createdAt: nowDate(),
    });
    const item = await outbox.findItem({ toAddress, subject });
    expect(item.id).toBe(seeded.id);

    const sendStarted = createDeferredPromise<void>(context.signal);
    const releaseSend = createDeferredPromise<void>(context.signal);
    onTestFinished(async () => {
      if (!releaseSend.settled()) {
        releaseSend.resolve(undefined);
      }
      await outbox.deleteItems([item.id]);
    });
    context.mocks.resend.send.mockImplementation(async () => {
      sendStarted.resolve(undefined);
      await releaseSend.promise;
      return { data: { id: "resend-scoped-lock" }, error: null };
    });

    const firstDrain = outbox.drainItems([item.id]);
    await sendStarted.promise;

    await expect(outbox.drainItems([item.id])).resolves.toBe(0);
    expect(context.mocks.resend.send).toHaveBeenCalledTimes(1);

    releaseSend.resolve(undefined);
    await expect(firstDrain).resolves.toBe(1);
    expect((await outbox.readItem(item.id))?.status).toBe("sent");
    expect(context.mocks.resend.send).toHaveBeenCalledTimes(1);
  });
});

describe("email outbox provider replay", () => {
  it("replays the committed request under one key after an unrecorded acceptance", async () => {
    const baseTime = pinTime();
    const item = await seedItem({ status: "pending", createdAt: nowDate() });
    const key = providerKey(item.id);

    // Resend accepted this email, but the response never reached the worker.
    context.mocks.resend.send.mockResolvedValue({
      data: null,
      error: {
        name: "internal_server_error",
        message: "provider response lost",
        statusCode: 500,
      },
    });

    await expect(outbox.drainItems([item.id])).resolves.toBe(1);
    expect(context.mocks.resend.send).toHaveBeenCalledTimes(1);
    await expect(outbox.readItem(item.id)).resolves.toMatchObject({
      status: "pending",
      attempts: 1,
      resend_id: null,
      has_provider_request: true,
      provider_idempotency_key: key,
    });
    const first = providerCall(0);
    expect(first.options).toStrictEqual({ idempotencyKey: key });
    expect(first.payload).toMatchObject({
      from: "Okou <okou@okou.io>",
      to: item.toAddress,
      subject: item.subject,
    });

    // The sender brand changes between attempts. Re-rendering would send a
    // different payload under the same key.
    mockEnv("RESEND_FROM_DOMAIN", "rebranded.example");
    context.mocks.resend.send.mockResolvedValue({
      data: { id: "resend-accepted-once" },
      error: null,
    });
    mockNow(baseTime + FIRST_BACKOFF_MS);

    await expect(outbox.drainItems([item.id])).resolves.toBe(1);

    expect(context.mocks.resend.send).toHaveBeenCalledTimes(2);
    const second = providerCall(1);
    expect(second.payload).toStrictEqual(first.payload);
    expect(second.options).toStrictEqual({ idempotencyKey: key });
    await expect(outbox.readItem(item.id)).resolves.toMatchObject({
      status: "sent",
      attempts: 2,
      resend_id: "resend-accepted-once",
      provider_idempotency_key: key,
      // A delivered row keeps its delivery identity but no longer retains the
      // rendered message.
      has_provider_request: false,
    });

    await expect(outbox.drainItems([item.id])).resolves.toBe(0);
    expect(context.mocks.resend.send).toHaveBeenCalledTimes(2);
  });

  it("recovers an unresolved provider send under the same delivery identity", async () => {
    const baseTime = pinTime();
    const item = await seedItem({ status: "pending", createdAt: nowDate() });
    const key = providerKey(item.id);

    const sendStarted = createDeferredPromise<void>(context.signal);
    const releaseSend = createDeferredPromise<void>(context.signal);
    onTestFinished(() => {
      if (!releaseSend.settled()) {
        releaseSend.resolve(undefined);
      }
    });
    // Resend accepts the first request and replays that same email afterwards.
    context.mocks.resend.send.mockImplementationOnce(async () => {
      sendStarted.resolve(undefined);
      await releaseSend.promise;
      return { data: { id: "resend-accepted-once" }, error: null };
    });
    context.mocks.resend.send.mockResolvedValue({
      data: { id: "resend-accepted-once" },
      error: null,
    });

    const unresolvedDrain = outbox.drainItems([item.id]);
    await sendStarted.promise;

    await expect(outbox.drainItems([item.id])).resolves.toBe(0);
    expect(context.mocks.resend.send).toHaveBeenCalledTimes(1);
    await expect(outbox.readItem(item.id)).resolves.toMatchObject({
      status: "sending",
      attempts: 1,
      has_provider_request: true,
      provider_idempotency_key: key,
    });

    // The worker never recorded that acceptance. After its lease, recovery
    // replays the committed request instead of rendering a new one.
    mockNow(baseTime + SEND_LEASE_MS);
    await expect(outbox.drainItems([item.id])).resolves.toBe(1);

    expect(context.mocks.resend.send).toHaveBeenCalledTimes(2);
    expect(providerCall(1).payload).toStrictEqual(providerCall(0).payload);
    expect(providerCall(1).options).toStrictEqual({ idempotencyKey: key });
    await expect(outbox.readItem(item.id)).resolves.toMatchObject({
      status: "sent",
      attempts: 2,
      resend_id: "resend-accepted-once",
      provider_idempotency_key: key,
    });

    // The abandoned attempt must not overwrite the recovered delivery.
    releaseSend.resolve(undefined);
    await expect(unresolvedDrain).resolves.toBe(1);
    expect(context.mocks.resend.send).toHaveBeenCalledTimes(2);
    await expect(outbox.readItem(item.id)).resolves.toMatchObject({
      status: "sent",
      attempts: 2,
      resend_id: "resend-accepted-once",
      provider_idempotency_key: key,
    });
  });

  it("stops a changed-payload conflict instead of re-keying it", async () => {
    pinTime();
    const item = await seedItem({ status: "pending", createdAt: nowDate() });
    const key = providerKey(item.id);
    context.mocks.resend.send.mockResolvedValue({
      data: null,
      error: {
        name: "invalid_idempotent_request",
        message: "key already used with a different payload",
        statusCode: 409,
      },
    });

    await expect(outbox.drainItems([item.id])).resolves.toBe(1);

    expect(context.mocks.resend.send).toHaveBeenCalledTimes(1);
    await expect(outbox.readItem(item.id)).resolves.toMatchObject({
      status: "failed",
      attempts: 1,
      resend_id: null,
      provider_idempotency_key: key,
      last_error: expect.stringContaining("invalid_idempotent_request"),
    });

    await expect(outbox.drainItems([item.id])).resolves.toBe(0);
    expect(context.mocks.resend.send).toHaveBeenCalledTimes(1);
    expect((await outbox.readItem(item.id))?.provider_idempotency_key).toBe(
      key,
    );
  });

  it("stops replaying once the existing attempt bound is reached", async () => {
    const baseTime = pinTime();
    const item = await seedItem({ status: "pending", createdAt: nowDate() });
    const key = providerKey(item.id);
    context.mocks.resend.send.mockResolvedValue({
      data: null,
      error: {
        name: "internal_server_error",
        message: "provider unavailable",
        statusCode: 500,
      },
    });

    await expect(outbox.drainItems([item.id])).resolves.toBe(1);
    mockNow(baseTime + FIRST_BACKOFF_MS);
    await expect(outbox.drainItems([item.id])).resolves.toBe(1);
    const thirdAttemptAt = baseTime + FIRST_BACKOFF_MS + FIRST_BACKOFF_MS * 4;

    // The last permitted attempt reaches the provider and never records its
    // outcome.
    const sendStarted = createDeferredPromise<void>(context.signal);
    const releaseSend = createDeferredPromise<void>(context.signal);
    onTestFinished(() => {
      if (!releaseSend.settled()) {
        releaseSend.resolve(undefined);
      }
    });
    context.mocks.resend.send.mockImplementationOnce(async () => {
      sendStarted.resolve(undefined);
      await releaseSend.promise;
      return { data: { id: "resend-last-attempt" }, error: null };
    });
    mockNow(thirdAttemptAt);
    const unresolvedDrain = outbox.drainItems([item.id]);
    await sendStarted.promise;
    expect(context.mocks.resend.send).toHaveBeenCalledTimes(3);

    // Recovery after the lease must respect the retry bound instead of
    // replaying indefinitely.
    mockNow(thirdAttemptAt + SEND_LEASE_MS);
    await expect(outbox.drainItems([item.id])).resolves.toBe(1);

    expect(context.mocks.resend.send).toHaveBeenCalledTimes(3);
    await expect(outbox.readItem(item.id)).resolves.toMatchObject({
      status: "failed",
      attempts: 3,
      resend_id: null,
      provider_idempotency_key: key,
      last_error: expect.stringContaining("exhausted its delivery attempts"),
    });

    releaseSend.resolve(undefined);
    await expect(unresolvedDrain).resolves.toBe(1);
    expect(context.mocks.resend.send).toHaveBeenCalledTimes(3);
  });

  it("retries a concurrent same-key response within the existing bounds", async () => {
    const baseTime = pinTime();
    const item = await seedItem({ status: "pending", createdAt: nowDate() });
    const key = providerKey(item.id);
    context.mocks.resend.send.mockResolvedValue({
      data: null,
      error: {
        name: "concurrent_idempotent_requests",
        message: "another request with the same key is in progress",
        statusCode: 409,
      },
    });

    await expect(outbox.drainItems([item.id])).resolves.toBe(1);
    await expect(outbox.readItem(item.id)).resolves.toMatchObject({
      status: "pending",
      attempts: 1,
      has_provider_request: true,
      provider_idempotency_key: key,
    });

    context.mocks.resend.send.mockResolvedValue({
      data: { id: "resend-replayed" },
      error: null,
    });
    mockNow(baseTime + FIRST_BACKOFF_MS);
    await expect(outbox.drainItems([item.id])).resolves.toBe(1);

    expect(providerCall(1).payload).toStrictEqual(providerCall(0).payload);
    expect([providerCall(0).options, providerCall(1).options]).toStrictEqual([
      { idempotencyKey: key },
      { idempotencyKey: key },
    ]);
    await expect(outbox.readItem(item.id)).resolves.toMatchObject({
      status: "sent",
      attempts: 2,
      resend_id: "resend-replayed",
    });
  });

  it("expires a stale backlog item before contacting the provider", async () => {
    const expired = await seedItem({
      status: "pending",
      createdAt: new Date(0),
    });
    const due = await seedItem({ status: "pending", createdAt: nowDate() });
    context.mocks.resend.send.mockResolvedValue({
      data: { id: "resend-due-item" },
      error: null,
    });

    await expect(outbox.drainItems([expired.id, due.id])).resolves.toBe(2);

    expect(context.mocks.resend.send).toHaveBeenCalledTimes(1);
    expect(providerCall(0).payload).toMatchObject({ to: due.toAddress });
    await expect(outbox.readItem(expired.id)).resolves.toMatchObject({
      status: "failed",
      attempts: 0,
      resend_id: null,
      has_provider_request: false,
      provider_idempotency_key: null,
      last_error: "Email outbox item expired before delivery",
    });
    await expect(outbox.readItem(due.id)).resolves.toMatchObject({
      status: "sent",
      resend_id: "resend-due-item",
    });

    await expect(outbox.cleanupExpiredItems([expired.id])).resolves.toBe(1);
    await expect(outbox.readItem(expired.id)).resolves.toBeNull();
  });

  it("expires an item that reaches its deadline while its request is prepared", async () => {
    const baseTime = pinTime();
    const deadlineMs = baseTime + 1000;
    const crossing = await seedItem({
      status: "pending",
      createdAt: new Date(deadlineMs - OUTBOX_TTL_MS),
    });
    const sibling = await seedItem({ status: "pending", createdAt: nowDate() });
    context.mocks.resend.send.mockResolvedValue({
      data: { id: "resend-sibling" },
      error: null,
    });

    const claim = await holdEmailOutboxClaim(crossing.id, context.signal);
    const drained = outbox.drainItems([crossing.id, sibling.id]);
    await claim.waitForBlocked();
    // Preparation already admitted the row against the clock. Its deadline is
    // reached while the suppression lookup, claim update and commit run.
    mockNow(deadlineMs);
    await claim.release();

    await expect(drained).resolves.toBe(2);
    // Equality at the deadline expires the item, so only the still-valid
    // sibling reaches the provider.
    expect(context.mocks.resend.send).toHaveBeenCalledTimes(1);
    expect(providerCall(0).payload).toMatchObject({ to: sibling.toAddress });
    await expect(outbox.readItem(crossing.id)).resolves.toMatchObject({
      status: "failed",
      attempts: 1,
      resend_id: null,
      // The committed request and key stay on the row: they are the only record
      // of the delivery identity this claim prepared.
      has_provider_request: true,
      provider_idempotency_key: providerKey(crossing.id),
      last_error: EXPIRED_BEFORE_PROVIDER_ERROR,
    });
    await expect(outbox.readItem(sibling.id)).resolves.toMatchObject({
      status: "sent",
      resend_id: "resend-sibling",
    });
  });

  it("never revives a row removed while its expired attempt was resolving", async () => {
    const baseTime = pinTime();
    const deadlineMs = baseTime + 1000;
    const item = await seedItem({
      status: "pending",
      createdAt: new Date(deadlineMs - OUTBOX_TTL_MS),
    });

    const claim = await holdEmailOutboxClaim(item.id, context.signal);
    const drained = outbox.drainItems([item.id]);
    const claimingSession = await claim.waitForBlocked();
    mockNow(deadlineMs);

    // Queued behind the suspended claim, so the removal owns the row before the
    // expired resolution can write it.
    const pendingRemoval = holdEmailOutboxRemoval(item.id, context.signal);
    await waitForEmailOutboxBlocked(claimingSession);
    await claim.release();
    const removal = await pendingRemoval;
    await removal.waitForBlocked();
    await removal.release();

    await expect(drained).resolves.toBe(1);
    expect(context.mocks.resend.send).not.toHaveBeenCalled();
    await expect(outbox.readItem(item.id)).resolves.toBeNull();
  });

  it("replays one delivery after its completion write fails", async () => {
    const baseTime = pinTime();
    const item = await seedItem({ status: "pending", createdAt: nowDate() });
    const key = providerKey(item.id);
    const provider = useIdempotentProvider();

    const restoreCompletion = await rejectEmailOutboxCompletion(
      item.id,
      context.signal,
    );
    onTestFinished(restoreCompletion);

    // The provider accepts the request and the worker then fails to record it.
    await expect(outbox.drainItems([item.id])).rejects.toThrow(
      `Unknown response status 500 for ${DRAIN_ROUTE}`,
    );

    expect(context.mocks.resend.send).toHaveBeenCalledTimes(1);
    expect(provider.accepted()).toHaveLength(1);
    await expect(outbox.readItem(item.id)).resolves.toMatchObject({
      status: "sending",
      attempts: 1,
      resend_id: null,
      // The durable snapshot survived the failed completion, so the accepted
      // email is still recoverable.
      has_provider_request: true,
      provider_idempotency_key: key,
    });

    await restoreCompletion();
    mockNow(baseTime + SEND_LEASE_MS);
    await expect(outbox.drainItems([item.id])).resolves.toBe(1);

    expect(context.mocks.resend.send).toHaveBeenCalledTimes(2);
    expect(providerCall(1).payload).toStrictEqual(providerCall(0).payload);
    expect(providerCall(1).options).toStrictEqual({ idempotencyKey: key });
    // The provider still owns exactly one email for this key; the replay
    // resolved to it instead of accepting a second one.
    const delivered = provider.accepted();
    expect(delivered).toStrictEqual([
      expect.objectContaining({ key, id: expect.any(String) }),
    ]);
    await expect(outbox.readItem(item.id)).resolves.toMatchObject({
      status: "sent",
      attempts: 2,
      resend_id: delivered[0]?.id,
      provider_idempotency_key: key,
      has_provider_request: false,
    });
  });

  it("gives each outbox row its own provider key", async () => {
    const baseTime = pinTime();
    const older = await seedItem({
      status: "pending",
      createdAt: new Date(baseTime - 1000),
    });
    const newer = await seedItem({
      status: "pending",
      createdAt: new Date(baseTime),
    });
    context.mocks.resend.send
      .mockResolvedValueOnce({ data: { id: "resend-older" }, error: null })
      .mockResolvedValueOnce({ data: { id: "resend-newer" }, error: null });

    await expect(outbox.drainItems([older.id, newer.id])).resolves.toBe(2);

    await expect(outbox.readItem(older.id)).resolves.toMatchObject({
      status: "sent",
      resend_id: "resend-older",
      provider_idempotency_key: providerKey(older.id),
    });
    await expect(outbox.readItem(newer.id)).resolves.toMatchObject({
      status: "sent",
      resend_id: "resend-newer",
      provider_idempotency_key: providerKey(newer.id),
    });
    expect([providerCall(0).options, providerCall(1).options]).toStrictEqual([
      { idempotencyKey: providerKey(older.id) },
      { idempotencyKey: providerKey(newer.id) },
    ]);
  });
});
