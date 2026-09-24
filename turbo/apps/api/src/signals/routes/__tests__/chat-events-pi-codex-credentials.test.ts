// Narrow infrastructure exception to the external-behavior test rule:
// exact post-commit/pre-KMS interleaves (including joining a failed sibling
// and cancellation) and legacy provider-only metadata drift cannot be
// deterministically staged through public endpoints. Other cases use the API.
import { randomUUID } from "node:crypto";
// eslint-disable-next-line no-restricted-imports -- Legacy provider-only metadata fixture.
import { modelProviders } from "@okouai/db/schema/model-provider";
import { and, eq } from "drizzle-orm";
import { http } from "msw";
import { describe, expect, it, onTestFinished } from "vitest";
import { testContext } from "../../../__tests__/test-context";
// eslint-disable-next-line no-restricted-imports -- Isolated snapshot transaction and legacy metadata fixture.
import { db } from "../../../lib/db";
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { reencryptSubscriptionStoresFixture } from "../../../test-fixtures/historical-subscription-writer";
import { flushWaitUntilForTest } from "../../context/wait-until";
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
import {
  nativeCodexSseResponse,
  piResponsesTextSse,
} from "./helpers/pi-responses";

const context = testContext({ connectorCatalog: true });
const {
  api,
  chat,
  entitledChatActor,
  configureSubscriptionPiModel,
  authDeviceSupport,
  sendChatRun,
  waitForRunStatus,
  mockPiResourceArchiveDownloads,
  mockPiCheckpointObjectStore,
} = createChatEventsFixture(context);
const TEST_DATA_KEY = Buffer.from("0123456789abcdef0123456789abcdef");

async function fixture(expiresAt = Math.floor(now() / 1000) + 7200) {
  const { actor, agentId } = await entitledChatActor();
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
  return { actor, agentId, connected, identity, args, resolve };
}

async function runThroughChatApi(f: Awaited<ReturnType<typeof fixture>>) {
  mockPiResourceArchiveDownloads();
  mockPiCheckpointObjectStore();
  const requests: { authorization: string | null; accountId: string | null }[] =
    [];
  server.use(
    http.post(
      "https://chatgpt.com/backend-api/codex/responses",
      ({ request }) => {
        requests.push({
          authorization: request.headers.get("authorization"),
          accountId: request.headers.get("chatgpt-account-id"),
        });
        return nativeCodexSseResponse(
          piResponsesTextSse("credential answer", 1),
        );
      },
    ),
  );
  const run = await sendChatRun(f.actor, {
    agentId: f.agentId,
    model: "gpt-5.6-terra",
    prompt: "resolve selected codex subscription credentials",
  });
  await waitForRunStatus(f.actor, run.runId, "completed", 30_000);
  await flushWaitUntilForTest();
  return { run, requests };
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
    const { run, requests } = await runThroughChatApi(f);
    expect(requests).toStrictEqual([
      {
        authorization: `Bearer ${f.connected.oauth.oauthTokenResponses[1]?.access_token}`,
        accountId: f.identity,
      },
    ]);
    expect(f.connected.oauth.oauthToken).toHaveLength(2);
    await expect(api.readRun(f.actor, run.runId)).resolves.toMatchObject({
      status: "completed",
    });
  }, 30_000);

  it("falls back on independent KMS rotation without treating ciphertext drift as disconnect", async () => {
    const f = await fixture();
    await reencryptSubscriptionStoresFixture(f.actor, "codex-oauth-token");
    const { requests } = await runThroughChatApi(f);
    expect(requests).toStrictEqual([
      {
        authorization: `Bearer ${f.connected.oauth.oauthTokenResponses[0]?.access_token}`,
        accountId: f.identity,
      },
    ]);
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

  it("joins a failed decrypt with its held sibling before returning no credentials", async () => {
    const f = await fixture();
    const secondEntered = createDeferredPromise<void>(context.signal);
    const release = createDeferredPromise<Uint8Array>(context.signal);
    const probe = useSecretKmsProbe(undefined, (_request, call) => {
      if (call === 1) {
        return Promise.reject(new Error("KMS unavailable"));
      }
      if (call === 2) {
        secondEntered.resolve(undefined);
        return release.promise;
      }
      return undefined;
    });
    const pending = f.resolve();
    const settled = Promise.allSettled([pending]);
    onTestFinished(async () => {
      if (!release.settled()) {
        release.resolve(TEST_DATA_KEY);
      }
      await settled;
    });
    await secondEntered.promise;
    let returned = false;
    const observed = settled.then(() => {
      returned = true;
    });
    // A separate account API request yields the event loop while the KMS
    // sibling remains held. An early rejection would be observable here.
    await authDeviceSupport.deletePersonalModelProviderAccount(
      f.actor,
      f.connected.accountSourceId,
    );
    expect(returned).toBeFalsy();
    release.resolve(TEST_DATA_KEY);
    await expect(pending).rejects.toThrow("KMS unavailable");
    await observed;
    expect(probe.decryptCalls).toBe(2);
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
    let returned = false;
    const observed = settled.then(() => {
      returned = true;
    });
    await authDeviceSupport.deletePersonalModelProviderAccount(
      f.actor,
      f.connected.accountSourceId,
    );
    expect(returned).toBeFalsy();
    release.resolve(TEST_DATA_KEY);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await observed;
    expect(probe.decryptCalls).toBe(2);
  }, 30_000);

  it("does not admit a new personal run after its only account is deleted", async () => {
    const f = await fixture();
    await authDeviceSupport.deletePersonalModelProviderAccount(
      f.actor,
      f.connected.accountSourceId,
    );
    const response = await chat.requestSendEvent(
      f.actor,
      {
        agentId: f.agentId,
        model: "gpt-5.6-terra",
        prompt: "do not reuse the deleted codex account",
        clientEventId: randomUUID(),
      },
      [409],
    );
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ error: { code: "CONFLICT" } });
    expect(JSON.stringify(response.body)).not.toContain(f.identity);
  }, 30_000);
});
