import { expect, test } from "vitest";

import {
  emitMockedClerkEvent,
  mockClerkSessionTransitioning,
  mockUser,
} from "../../__tests__/mock-auth.ts";
import { clerkUser$, setupClerkUser$ } from "../auth.ts";
import { setRootSignal$ } from "../root-signal.ts";
import { resetSignal } from "../utils.ts";
import { testContext } from "./test-helpers.ts";

const context = testContext();

async function startClerkUser(signal = context.signal): Promise<void> {
  context.mocks.clerk().loaded(true);
  context.store.set(setRootSignal$, context.signal);
  await context.store.set(setupClerkUser$, signal);
}

function signOut(): void {
  mockUser(null, null);
  emitMockedClerkEvent();
}

function signIn(id: string): void {
  mockUser({ id, fullName: "Test User" }, { token: "test-token" });
  emitMockedClerkEvent();
}

test("A signed-in user settles immediately after setup", async () => {
  signIn("user-a");

  await startClerkUser();

  await expect(context.store.get(clerkUser$)).resolves.toMatchObject({
    id: "user-a",
  });
});

test("A signed-out user settles as null instead of staying pending", async () => {
  signOut();

  await startClerkUser();

  await expect(context.store.get(clerkUser$)).resolves.toBeNull();
});

test("The transitive state defers the value instead of reporting a sign-out", async () => {
  signOut();
  await startClerkUser();
  await expect(context.store.get(clerkUser$)).resolves.toBeNull();

  mockClerkSessionTransitioning(true);

  let settled = false;
  const pending = (async () => {
    const user = await context.store.get(clerkUser$);
    settled = true;
    return user;
  })();
  await Promise.resolve();
  expect(settled).toBeFalsy();

  signIn("user-a");
  mockClerkSessionTransitioning(false);

  await expect(pending).resolves.toMatchObject({ id: "user-a" });
});

test("Consecutive transitions never expose a null between two users", async () => {
  signIn("user-a");
  await startClerkUser();
  await expect(context.store.get(clerkUser$)).resolves.toMatchObject({
    id: "user-a",
  });

  mockClerkSessionTransitioning(true);
  const first = context.store.get(clerkUser$);
  signIn("user-b");
  mockClerkSessionTransitioning(false);
  await expect(first).resolves.toMatchObject({ id: "user-b" });

  mockClerkSessionTransitioning(true);
  const second = context.store.get(clerkUser$);
  expect(second).not.toBe(first);
  signIn("user-c");
  mockClerkSessionTransitioning(false);
  await expect(second).resolves.toMatchObject({ id: "user-c" });
});

test("A repeated emit for the same user keeps the settled promise identity", async () => {
  signIn("user-a");
  await startClerkUser();

  const first = context.store.get(clerkUser$);
  emitMockedClerkEvent();
  expect(context.store.get(clerkUser$)).toBe(first);
});

test("An owner claims the signal before it resolves the Clerk runtime", async () => {
  signIn("user-a");
  context.mocks.clerk().loaded(true);
  context.store.set(setRootSignal$, context.signal);

  // Readers in the same synchronous pass as the owner must see a promise the
  // owner can still resolve, not the sentinel that nothing settles.
  const owned = context.store.set(setupClerkUser$, context.signal);
  const claimed = context.store.get(clerkUser$);
  await owned;

  await expect(claimed).resolves.toMatchObject({ id: "user-a" });
});

test("Aborting the owner keeps the last published value and stops listening", async () => {
  signIn("user-a");

  const resetOwner$ = resetSignal();
  await startClerkUser(context.store.set(resetOwner$, context.signal));
  const settled = context.store.get(clerkUser$);
  // Requesting the next owner aborts the previous one.
  context.store.set(resetOwner$, context.signal);

  mockClerkSessionTransitioning(true);
  expect(context.store.get(clerkUser$)).toBe(settled);
  await expect(settled).resolves.toMatchObject({ id: "user-a" });
});

test("Aborting the owner mid-transition rejects the pending read", async () => {
  signIn("user-a");

  const resetOwner$ = resetSignal();
  await startClerkUser(context.store.set(resetOwner$, context.signal));
  mockClerkSessionTransitioning(true);
  const pending = context.store.get(clerkUser$);
  context.store.set(resetOwner$, context.signal);

  await expect(pending).rejects.toThrow("signal is aborted");
});
