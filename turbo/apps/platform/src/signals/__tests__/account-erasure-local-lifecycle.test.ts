import { accountErasureStatusContract } from "@okouai/api-contracts/contracts/account-erasure-status";
import { waitFor } from "@testing-library/react";
import { openDB } from "idb";
import { expect, test } from "vitest";

import { setupPage } from "../../__tests__/page-helper.ts";
import { emitMockedClerkEvent, mockUser } from "../../__tests__/mock-auth.ts";
import { testContext } from "./test-helpers.ts";

const context = testContext();

test("Clerk sign-out preserves other accounts, while an owner-bound pending deletion purges only its local data", async () => {
  const owner = `user_${crypto.randomUUID().replaceAll("-", "")}`;
  const peer = `user_${crypto.randomUUID().replaceAll("-", "")}`;
  const ownerDbName = `vm0-chat-${owner}-org_first`;
  const peerDbName = `vm0-chat-${peer}-org_first`;
  for (const name of [ownerDbName, peerDbName]) {
    const database = await openDB(name, 1, {
      upgrade(db) {
        db.createObjectStore("private");
      },
    });
    await database.put("private", "private bytes", "key");
    database.close();
  }

  let status: "active" | "pending" | "complete" = "active";
  context.mocks.api(accountErasureStatusContract.capability, ({ respond }) => {
    return respond(200, {
      token: `capability-${owner}`,
    });
  });
  context.mocks.api(accountErasureStatusContract.status, ({ respond }) => {
    return respond(200, { userId: owner, status });
  });

  await setupPage({
    context,
    path: "/_/error",
    auth: { user: { id: owner, fullName: "Owner" } },
  });
  mockUser(null, null);
  emitMockedClerkEvent();
  await waitFor(async () => {
    const names = (await indexedDB.databases()).map((entry) => {
      return entry.name;
    });
    expect(names).toContain(ownerDbName);
  });

  status = "pending";
  emitMockedClerkEvent();
  await waitFor(async () => {
    const names = (await indexedDB.databases()).map((entry) => {
      return entry.name;
    });
    expect(names).not.toContain(ownerDbName);
    expect(names).toContain(peerDbName);
  });

  status = "complete";
  const staleDatabase = await openDB(ownerDbName, 1, {
    upgrade(db) {
      db.createObjectStore("private");
    },
  });
  await staleDatabase.put("private", "late bytes", "key");
  staleDatabase.close();
  emitMockedClerkEvent();
  await waitFor(async () => {
    const names = (await indexedDB.databases()).map((entry) => {
      return entry.name;
    });
    expect(names).not.toContain(ownerDbName);
    expect(names).toContain(peerDbName);
  });

  const laterDatabase = await openDB(ownerDbName, 1, {
    upgrade(db) {
      db.createObjectStore("private");
    },
  });
  await laterDatabase.put("private", "later bytes", "key");
  laterDatabase.close();
  emitMockedClerkEvent();
  await waitFor(async () => {
    const names = (await indexedDB.databases()).map((entry) => {
      return entry.name;
    });
    expect(names).not.toContain(ownerDbName);
    expect(names).toContain(peerDbName);
  });
});
