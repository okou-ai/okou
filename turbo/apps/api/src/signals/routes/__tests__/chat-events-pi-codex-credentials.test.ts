// Narrow infrastructure exception to the external-behavior test rule:
// a precise post-commit/pre-KMS lock interleave and legacy provider-only
// metadata drift cannot be deterministically staged through public endpoints.
// Existing chat-route tests cover the normal user-visible credential behavior.
import { randomUUID } from "node:crypto";
// eslint-disable-next-line no-restricted-imports -- Legacy provider-only metadata fixture.
import { modelProviders } from "@okouai/db/schema/model-provider";
import { and, eq } from "drizzle-orm";
import { describe, expect, it, onTestFinished } from "vitest";
import { testContext } from "../../../__tests__/test-context";
// eslint-disable-next-line no-restricted-imports -- Isolated snapshot transaction and legacy metadata fixture.
import { db } from "../../../lib/db";
import { now } from "../../../lib/time";
import { reencryptSubscriptionStoresFixture } from "../../../test-fixtures/historical-subscription-writer";
import { createDeferredPromise } from "../../utils";
// eslint-disable-next-line no-restricted-imports -- Check the transaction/KMS boundary, not an HTTP response.
import { resolvePiCodexFirstTurnSubscriptionBundleForApi } from "../../services/agent-webhook-firewall-auth.service";
// eslint-disable-next-line no-restricted-imports -- Inspect eligibility only for infrastructure-only states.
import { capturePiCodexCredentialCiphertexts } from "../../services/model-provider-account.service";
import {
  createChatEventsFixture,
  requireOrgId,
} from "./helpers/chat-events-fixture";
import { useSecretKmsProbe } from "./helpers/secret-kms-probe";

const context = testContext({ connectorCatalog: true });
const { entitledChatActor, configureSubscriptionPiModel, authDeviceSupport } =
  createChatEventsFixture(context);
const TEST_DATA_KEY = Buffer.from("0123456789abcdef0123456789abcdef");

async function fixture(expiresAt = Math.floor(now() / 1000) + 7200) {
  const { actor } = await entitledChatActor();
  const identity = `pi-codex-fast-${randomUUID()}`;
  const connected = await configureSubscriptionPiModel(actor, {
    accountId: identity,
    accessTokenExpiresAt: expiresAt,
    refreshedAccessTokenExpiresAt: Math.floor(now() / 1000) + 7200,
  });
  const args = {
    db: db(),
    orgId: requireOrgId(actor),
    userId: actor.userId,
    type: "codex-oauth-token" as const,
    sourceId: connected.accountSourceId,
    featureSwitchContext: { orgId: requireOrgId(actor), userId: actor.userId },
  };
  const resolve = (signal: AbortSignal = context.signal) => {
    return resolvePiCodexFirstTurnSubscriptionBundleForApi(
      {
        ...args,
        key: "CHATGPT_ACCESS_TOKEN",
        providerKey: "codex-oauth-token",
        metadata: {
          sourceType: "model-provider",
          sourceUserId: actor.userId,
          sourceId: connected.accountSourceId,
          metadataKey: "codex-oauth-token",
        },
      },
      signal,
    );
  };
  return { actor, connected, identity, args, resolve };
}

function expectCredentials(
  result: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>["resolve"]>>,
  token: string | undefined,
  identity: string,
) {
  expect(result.status).toBe("available");
  if (result.status === "available") {
    expect(result.values.get("CHATGPT_ACCESS_TOKEN")).toBe(token);
    expect(result.values.get("CHATGPT_ACCOUNT_ID")).toBe(identity);
  }
}

describe("Pi Codex credential ciphertext snapshot", () => {
  it("releases the user lock before KMS and preserves the selected account across disconnect", async () => {
    const f = await fixture();
    const captured = await capturePiCodexCredentialCiphertexts(f.args);
    expect(captured?.accessTokenCiphertext).toBeTruthy();
    expect(captured?.accountIdCiphertext).toBeTruthy();
    const entered = createDeferredPromise<void>(context.signal);
    const release = createDeferredPromise<Uint8Array>(context.signal);
    const probe = useSecretKmsProbe(undefined, (_request, call) => {
      if (call === 1) {
        entered.resolve(undefined);
        return release.promise;
      }
      return undefined;
    });
    const pending = f.resolve();
    const pendingSettled = Promise.allSettled([pending]);
    onTestFinished(async () => {
      if (!release.settled()) {
        release.resolve(TEST_DATA_KEY);
      }
      await pendingSettled;
    });
    await entered.promise;
    // This writer needs the same advisory lock. If either decrypt is still
    // inside the transaction, disconnect cannot complete before release.
    await authDeviceSupport.deletePersonalModelProviderAccount(
      f.actor,
      f.connected.accountSourceId,
    );
    release.resolve(TEST_DATA_KEY);
    expectCredentials(
      await pending,
      f.connected.oauth.oauthTokenResponses[0]?.access_token,
      f.identity,
    );
    expect(probe.decryptCalls).toBe(2);
    await expect(
      capturePiCodexCredentialCiphertexts(f.args),
    ).resolves.toBeNull();
  }, 30_000);

  it("uses the coordinating reader for expiring tokens and refreshes once", async () => {
    const f = await fixture(Math.floor(now() / 1000) - 60);
    // The snapshot may be coherent but is not eligible for lock-free decrypt.
    await expect(
      capturePiCodexCredentialCiphertexts(f.args),
    ).resolves.not.toBeNull();
    expectCredentials(
      await f.resolve(),
      f.connected.oauth.oauthTokenResponses[1]?.access_token,
      f.identity,
    );
    expect(f.connected.oauth.oauthToken).toHaveLength(2);
  }, 30_000);

  it("falls back on independent KMS rotation without treating ciphertext drift as disconnect", async () => {
    const f = await fixture();
    await reencryptSubscriptionStoresFixture(f.actor, "codex-oauth-token");
    await expect(
      capturePiCodexCredentialCiphertexts(f.args),
    ).resolves.toBeNull();
    expectCredentials(
      await f.resolve(),
      f.connected.oauth.oauthTokenResponses[0]?.access_token,
      f.identity,
    );
    expect(f.connected.oauth.oauthToken).toHaveLength(1);
  }, 30_000);

  it("reconciles legacy provider metadata drift before using the fast path", async () => {
    const f = await fixture();
    // Legacy Codex refresh writes can update provider metadata without the
    // account mirror. Such a state must be coordinated, never just decrypted.
    const refreshedExpiry = new Date(now() + 7_300_000);
    await db()
      .update(modelProviders)
      .set({ tokenExpiresAt: refreshedExpiry })
      .where(
        and(
          eq(modelProviders.orgId, f.args.orgId),
          eq(modelProviders.userId, f.args.userId),
          eq(modelProviders.type, "codex-oauth-token"),
        ),
      );
    await expect(
      capturePiCodexCredentialCiphertexts(f.args),
    ).resolves.toBeNull();
    expectCredentials(
      await f.resolve(),
      f.connected.oauth.oauthTokenResponses[0]?.access_token,
      f.identity,
    );
    const reconciled = await capturePiCodexCredentialCiphertexts(f.args);
    expect(reconciled?.tokenExpiresAt).toStrictEqual(refreshedExpiry);
    expect(f.connected.oauth.oauthToken).toHaveLength(1);
  }, 30_000);

  it("does not return partial credentials after KMS failure, and can retry", async () => {
    const f = await fixture();
    const probe = useSecretKmsProbe(undefined, (_request, call) => {
      return call === 1
        ? Promise.reject(new Error("KMS unavailable"))
        : undefined;
    });
    await expect(f.resolve()).rejects.toThrow("KMS unavailable");
    expect(probe.decryptCalls).toBe(2);
    useSecretKmsProbe();
    expectCredentials(
      await f.resolve(),
      f.connected.oauth.oauthTokenResponses[0]?.access_token,
      f.identity,
    );
  }, 30_000);

  it("honors cancellation after both started decryptions settle", async () => {
    const f = await fixture();
    const controller = new AbortController();
    const entered = createDeferredPromise<void>(context.signal);
    const release = createDeferredPromise<Uint8Array>(context.signal);
    const probe = useSecretKmsProbe(undefined, (_request, call) => {
      if (call === 1) {
        entered.resolve(undefined);
        return release.promise;
      }
      return undefined;
    });
    const pending = f.resolve(controller.signal);
    const settled = Promise.allSettled([pending]);
    onTestFinished(async () => {
      if (!release.settled()) {
        release.resolve(TEST_DATA_KEY);
      }
      await settled;
    });
    await entered.promise;
    controller.abort(new DOMException("cancelled", "AbortError"));
    release.resolve(TEST_DATA_KEY);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(probe.decryptCalls).toBe(2);
  }, 30_000);

  it("does not use the fast path after reconnect is required", async () => {
    const f = await fixture();
    await authDeviceSupport.deletePersonalModelProviderAccount(
      f.actor,
      f.connected.accountSourceId,
    );
    await expect(
      capturePiCodexCredentialCiphertexts(f.args),
    ).resolves.toBeNull();
    await expect(f.resolve()).resolves.toMatchObject({ status: "unavailable" });
  }, 30_000);
});
