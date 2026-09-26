// Narrow infrastructure exception to the external-behavior test rule:
// exact pre-KMS interleaves (joining a failed sibling and cancellation) cannot
// be deterministically staged through public endpoints. Other cases use the API.
import { randomUUID } from "node:crypto";
import { http } from "msw";
import { describe, expect, it, onTestFinished } from "vitest";
import { testContext } from "../../../__tests__/test-context";
// eslint-disable-next-line no-restricted-imports -- Direct first-turn resolver arguments.
import { db } from "../../../lib/db";
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createDeferredPromise } from "../../utils";
// eslint-disable-next-line no-restricted-imports -- Check the transaction/KMS boundary, not an HTTP response.
import { resolvePiCodexFirstTurnSubscriptionBundleForApi } from "../../services/agent-webhook-firewall-auth.service";
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
  const orgId = requireOrgId(actor);
  const resolve = (signal: AbortSignal = context.signal) => {
    return resolvePiCodexFirstTurnSubscriptionBundleForApi(
      {
        db: db(),
        orgId,
        userId: actor.userId,
        featureSwitchContext: { orgId, userId: actor.userId },
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
  return { actor, agentId, connected, identity, resolve };
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
  it("returns the selected account's fresh credentials without refreshing", async () => {
    const f = await fixture();
    expectCredentials(
      await f.resolve(),
      f.connected.oauth.oauthTokenResponses[0]?.access_token,
      f.identity,
    );
    expect(f.connected.oauth.oauthToken).toHaveLength(1);
  }, 30_000);

  it("refreshes an expiring token once before the first turn", async () => {
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
