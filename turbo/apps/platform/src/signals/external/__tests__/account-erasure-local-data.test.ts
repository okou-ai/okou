import { openDB } from "idb";
import { expect, test } from "vitest";

import { testContext } from "../../__tests__/test-helpers.ts";
import { deleteAccountLocalData$ } from "../account-erasure-local-data.ts";
import { sourcesFirstDraftStorage } from "../../onboarding/onboarding-sources-first-state.ts";
import {
  listLocalStorageEntries,
  localStorageSignals,
} from "../local-storage.ts";
import {
  appendVoiceDraftSamples,
  createVoiceDraftRecording,
  readVoiceDraftRecording,
} from "../voice-draft-store.ts";

const context = testContext();
const onboardingStepStorage = localStorageSignals(
  "onboarding:sources-first-step",
);

test("verified account deletion removes only that user's chat caches and voice drafts", async () => {
  const onboardingStorage = sourcesFirstDraftStorage;
  const owner = `user_${crypto.randomUUID().replaceAll("-", "")}`;
  const peer = `user_${crypto.randomUUID().replaceAll("-", "")}`;
  const ownerNames = [
    `vm0-chat-${owner}-org_first`,
    `vm0-chat-${owner}-org_second`,
  ];
  const peerName = `vm0-chat-${peer}-org_first`;
  for (const name of [...ownerNames, peerName]) {
    const database = await openDB(name, 1, {
      upgrade(db) {
        db.createObjectStore("private");
      },
    });
    await database.put("private", "private bytes", "key");
    database.close();
  }

  const ownerKey = JSON.stringify([owner, "org_first", "chat"]);
  const peerKey = JSON.stringify([peer, "org_first", "chat"]);
  await createVoiceDraftRecording(ownerKey, "owner-recording");
  await appendVoiceDraftSamples(
    ownerKey,
    "owner-recording",
    0,
    new Float32Array([0.25]),
  );
  await createVoiceDraftRecording(peerKey, "peer-recording");
  await appendVoiceDraftSamples(
    peerKey,
    "peer-recording",
    0,
    new Float32Array([0.5]),
  );

  context.store.set(
    onboardingStorage.set$,
    JSON.stringify({ userId: peer, orgId: "org_first", secret: "peer" }),
  );
  context.store.set(
    onboardingStepStorage.set$,
    JSON.stringify({ userId: owner, orgId: "org_first", step: "ready" }),
  );
  await context.store.set(deleteAccountLocalData$, owner, context.signal);

  const names = (await indexedDB.databases()).map((entry) => {
    return entry.name;
  });
  for (const name of ownerNames) {
    expect(names).not.toContain(name);
  }
  expect(names).toContain(peerName);
  const peerDatabase = await openDB(peerName);
  await expect(peerDatabase.get("private", "key")).resolves.toBe(
    "private bytes",
  );
  peerDatabase.close();
  await expect(readVoiceDraftRecording(ownerKey)).resolves.toBeNull();
  await expect(readVoiceDraftRecording(peerKey)).resolves.toMatchObject({
    id: "peer-recording",
    chunkCount: 1,
  });
  const voiceDatabase = await openDB("okou-voice-drafts");
  const chunkKeys = await voiceDatabase.getAllKeys("chunks");
  voiceDatabase.close();
  expect(
    chunkKeys.some((key) => {
      return Array.isArray(key) && key[0] === ownerKey;
    }),
  ).toBeFalsy();
  expect(
    chunkKeys.some((key) => {
      return Array.isArray(key) && key[0] === peerKey;
    }),
  ).toBeTruthy();
  expect(context.store.get(onboardingStorage.get$)).toContain(peer);
  expect(
    listLocalStorageEntries("onboarding:sources-first-step"),
  ).toStrictEqual([]);
  context.store.set(
    onboardingStorage.set$,
    JSON.stringify({ userId: owner, orgId: "org_first", secret: "owner" }),
  );
  await context.store.set(deleteAccountLocalData$, owner, context.signal);
  expect(context.store.get(onboardingStorage.get$)).toBeNull();
});

test("an ambiguous legacy cache name cannot cause cross-account deletion", async () => {
  const owner = `user_${crypto.randomUUID().replaceAll("-", "")}`;
  const ambiguous = `vm0-chat-${owner}-orgpeer-orgother`;
  const database = await openDB(ambiguous, 1, {
    upgrade(db) {
      db.createObjectStore("private");
    },
  });
  await database.put("private", "other account bytes", "key");
  database.close();

  await expect(
    context.store.set(deleteAccountLocalData$, owner, context.signal),
  ).rejects.toThrow("Ambiguous account-scoped chat cache name");
  const names = (await indexedDB.databases()).map((entry) => {
    return entry.name;
  });
  expect(names).toContain(ambiguous);
});
