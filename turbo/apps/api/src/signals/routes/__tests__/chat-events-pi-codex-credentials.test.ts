import { createRunsApi } from "./helpers/api-bdd-runs";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { now } from "../../../lib/time";
import { useSecretKmsProbe } from "./helpers/secret-kms-probe";
import {
  assistantMessages,
  createChatEventsFixture,
  userMessages,
} from "./helpers/chat-events-fixture";

const context = testContext();
const api = createRunsApi(context);
const {
  chat,
  entitledChatActor,
  configureSubscriptionPiModel,
  authDeviceSupport,
  misc,
  sendChatRun,
  waitForThreadMessages,
} = createChatEventsFixture(context);

function unsignedJwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown) => {
    return Buffer.from(JSON.stringify(value)).toString("base64url");
  };
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.`;
}

/** A ChatGPT auth.json; `accountId: null` omits every account id claim. */
function codexAuthJson(accountId: string | null): string {
  const exp = Math.floor(now() / 1000) + 7200;
  return JSON.stringify({
    OPENAI_API_KEY: null,
    tokens: {
      access_token: unsignedJwt({ exp }),
      refresh_token: `rt_${randomUUID()}`,
      ...(accountId === null ? {} : { account_id: accountId }),
      id_token: unsignedJwt({
        "https://api.openai.com/auth":
          accountId === null
            ? { chatgpt_plan_type: "plus" }
            : { chatgpt_account_id: accountId, chatgpt_plan_type: "plus" },
        exp,
      }),
    },
  });
}

async function fixture(expiresAt = Math.floor(now() / 1000) + 7200) {
  const { actor, agentId } = await entitledChatActor();
  const identity = `pi-codex-fast-${randomUUID()}`;
  const connected = await configureSubscriptionPiModel(actor, {
    accountId: identity,
    accessTokenExpiresAt: expiresAt,
    refreshedAccessTokenExpiresAt: Math.floor(now() / 1000) + 7200,
  });
  return { actor, agentId, connected, identity };
}

/** A member ChatGPT auth.json source. */
async function memberAuthJsonFixture(accountId: string | null) {
  const { actor, agentId } = await entitledChatActor();

  await misc.upsertPersonalModelProvider(
    actor,
    {
      type: "codex-oauth-token",
      authMethod: "auth_json",
      secrets: { CODEX_AUTH_JSON: codexAuthJson(accountId) },
    },
    [200, 201],
  );
  return { actor, agentId };
}

describe("Pi Codex subscription admission", () => {
  it("does not admit a new personal run after its only account is deleted", async () => {
    const f = await fixture();
    await authDeviceSupport.deletePersonalModelProviderAccount(
      f.actor,
      f.connected.accountSourceId,
    );
    const clientEventId = randomUUID();
    const response = await chat.requestSendEvent(
      f.actor,
      {
        agentId: f.agentId,
        model: "gpt-6-luna",
        prompt: "do not reuse the deleted codex account",
        clientEventId,
      },
      [201],
    );
    if (response.status !== 201) {
      throw new Error("Expected the send to be accepted");
    }
    expect(response.body.runId).toBeNull();
    // The pick refuses the input in the thread instead of launching a run.
    const messages = await waitForThreadMessages(
      f.actor,
      response.body.threadId,
      (items) => {
        return assistantMessages(items).some((message) => {
          return message.eventType === "output.error";
        });
      },
    );
    expect(
      userMessages(messages.events).filter((message) => {
        return message.revokesEventId === clientEventId;
      }),
    ).toStrictEqual([
      expect.objectContaining({
        eventType: "input.rejected",
        error: "conflict",
      }),
    ]);
    expect(
      assistantMessages(messages.events).filter((message) => {
        return message.eventType === "output.error";
      }),
    ).toStrictEqual([
      expect.objectContaining({
        error: "conflict",
        content:
          "The selected subscription account is unavailable. Reconnect it before starting another run.",
      }),
    ]);
    expect(JSON.stringify(messages.events)).not.toContain(f.identity);
  }, 30_000);
});

describe("ChatGPT subscription credentials at launch", () => {
  it.each([
    ["gpt-6-luna", 0],
    ["gpt-6-astra", 1],
  ] as const)(
    "launches %s with %i stored-secret decrypts",
    async (selectedModel, decrypts) => {
      const f = await fixture();
      await api.updateUserModelPreference(f.actor, selectedModel);
      // The tokens stay behind firewall auth; only native Codex workspace
      // routing reads the plain account id.
      const kms = useSecretKmsProbe();
      const run = await sendChatRun(f.actor, {
        agentId: f.agentId,
        model: selectedModel,
        prompt: "launch with the connected ChatGPT account",
      });
      expect(run.runId).toStrictEqual(expect.any(String));
      expect(kms.decryptCalls).toBe(decrypts);
    },
    30_000,
  );
});

describe("ChatGPT auth.json credentials at launch", () => {
  it.each([
    ["gpt-6-luna", 0],
    ["gpt-6-astra", 1],
  ] as const)(
    "launches %s with %i stored-secret decrypts beside an org Anthropic key",
    async (selectedModel, decrypts) => {
      const f = await memberAuthJsonFixture(`ws_acct_${randomUUID()}`);
      await api.updateUserModelPreference(f.actor, selectedModel);
      // Only native Codex workspace routing reads the plain account id; the
      // org's Anthropic key is never decrypted for this source.
      const kms = useSecretKmsProbe();
      const run = await sendChatRun(f.actor, {
        agentId: f.agentId,
        model: selectedModel,
        prompt: "launch with the ChatGPT auth.json account",
      });
      expect(run.runId).toStrictEqual(expect.any(String));
      expect(kms.decryptCalls).toBe(decrypts);
    },
    30_000,
  );

  it("fails closed when a ChatGPT auth.json has no account id", async () => {
    // Native Codex routes by workspace account; a source without one is
    // refused when stored, so no launch can proceed without it.
    const { actor, agentId } = await entitledChatActor();
    const rejected = await misc.upsertPersonalModelProvider(
      actor,
      {
        type: "codex-oauth-token",
        authMethod: "auth_json",
        secrets: { CODEX_AUTH_JSON: codexAuthJson(null) },
      },
      [400],
    );
    expect(rejected.body).toMatchObject({
      error: { code: "CODEX_AUTH_JSON_SHAPE_INVALID" },
    });
    const kms = useSecretKmsProbe();
    const response = await chat.requestSendEvent(
      actor,
      {
        agentId,
        model: "gpt-6-astra",
        prompt: "do not launch without a workspace account",
        clientEventId: randomUUID(),
      },
      [201],
    );
    if (response.status !== 201) {
      throw new Error("Expected the send to be accepted");
    }
    expect(response.body.runId).toBeNull();
    expect(kms.decryptCalls).toBe(0);
  }, 30_000);
});
