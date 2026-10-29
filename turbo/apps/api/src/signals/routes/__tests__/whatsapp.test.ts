import { integrationsWhatsappContract as contract } from "@okouai/api-contracts/contracts/integrations-whatsapp";
import { integrationsAgentPhoneContract } from "@okouai/api-contracts/contracts/integrations-agentphone";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { createHmac, randomInt, randomUUID } from "node:crypto";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { server } from "../../../mocks/server";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { mockNow, now } from "../../../lib/time";
import { mockOptionalEnv, mockEnv } from "../../../lib/env";
import { integrationsWhatsappRoutes } from "../integrations-whatsapp";
import { integrationsAgentPhoneRoutes } from "../integrations-agentphone";
import { featureSwitchesRoutes } from "../feature-switches";
import { createBddIntegrationApi } from "./helpers/api-bdd-integrations";
import {
  createAgentPhoneBddApi,
  AGENTPHONE_BDD_AGENT_ID,
  AGENTPHONE_BDD_PHONE_NUMBER,
} from "./helpers/api-bdd-agentphone";
import type { ApiTestUser } from "./helpers/api-bdd";
import { createRouteMocks } from "./helpers/route-test";
import { mockClerkUsers } from "./helpers/clerk-users";

const context = testContext();
const providerUrl = "https://api.agentphone.test";
function headers(actor: ApiTestUser) {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  const emailId = `email_${actor.userId}`;
  mockClerkUsers(context, [
    {
      id: actor.userId,
      emailAddresses: [{ id: emailId, emailAddress: actor.email }],
      primaryEmailAddressId: emailId,
      firstName: "WhatsApp",
      lastName: "Test",
    },
  ]);
  return { authorization: "Bearer clerk-session" };
}
function client() {
  return setupApp({ context, routes: integrationsWhatsappRoutes })(contract);
}
async function configure(enabled = true) {
  const integrations = createBddIntegrationApi(context);
  integrations.configureAgentPhoneProvider();
  integrations.configureAgentPhoneWebhook();
  const actor = integrations.user();
  const sends: Record<string, unknown>[] = [];
  server.use(
    http.get(`${providerUrl}/v1/numbers`, () => {
      return HttpResponse.json({
        data: [
          { phoneNumber: AGENTPHONE_BDD_PHONE_NUMBER, whatsappEnabled: true },
        ],
        hasMore: false,
      });
    }),
    http.post(`${providerUrl}/v1/messages`, async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      sends.push(body);
      return HttpResponse.json({
        id: `message_${randomUUID()}`,
        channel: body.channel ?? "sms",
        from_number: AGENTPHONE_BDD_PHONE_NUMBER,
        to_number: body.to_number,
      });
    }),
  );
  if (enabled) {
    await accept(
      setupApp({ context, routes: featureSwitchesRoutes })(
        featureSwitchesContract,
      ).update({
        headers: headers(actor),
        body: {
          switches: {
            [FeatureSwitchKey.WhatsappIntegration]: true,
            [FeatureSwitchKey.WhatsappFileUpload]: true,
          },
        },
      }),
      [200],
    );
  }
  return { actor, integrations, ap: createAgentPhoneBddApi(context), sends };
}
function sender(): string {
  return `+49${randomInt(10_000_000_000, 100_000_000_000)}`;
}
async function connect(
  setup: Awaited<ReturnType<typeof configure>>,
  phone = sender(),
) {
  const code = await accept(
    client().createLinkCode({ headers: headers(setup.actor) }),
    [200],
  );
  await setup.ap.postAgentPhoneInboundMessage({
    channel: "whatsapp",
    from: phone,
    body: code.body.code,
  });
  const status = await accept(
    client().getLinkStatus({ headers: headers(setup.actor) }),
    [200],
  );
  expect(status.body).toMatchObject({ linked: true, phoneHandle: phone });
  return phone;
}

async function uploadedWhatsappFile(
  setup: Awaited<ReturnType<typeof configure>>,
  contentType = "application/pdf",
) {
  const chat = createChatFilesBddApi(context);
  chat.mockObjectStorageObjectsExist();
  const file = await chat.prepareUpload(setup.actor, {
    filename: contentType.startsWith("audio/") ? "voice.mp3" : "report.pdf",
    contentType,
    size: 1024,
    purpose: "artifact",
  });
  const uploaded = await chat.completeUpload(setup.actor, { id: file.id });
  return { chat, file: uploaded };
}

async function requestWhatsappProof(
  setup: Awaited<ReturnType<typeof configure>>,
  phone = sender(),
  body = "/connect",
) {
  setup.sends.length = 0;
  await setup.ap.postAgentPhoneInboundMessage({
    channel: "whatsapp",
    from: phone,
    body,
  });
  const reply = setup.sends.at(-1)?.body;
  if (typeof reply !== "string") {
    throw new Error("Expected a WhatsApp connection reply");
  }
  const match = reply.match(/https?:\/\/\S*\/settings\/whatsapp\?\S+/u);
  if (!match) {
    throw new Error("Expected a signed WhatsApp connection URL");
  }
  const url = new URL(match[0]);
  return contract.connectWhatsapp.body.parse({
    phoneHandle: url.searchParams.get("handle"),
    agentphoneAgentId: url.searchParams.get("agent"),
    timestamp: Number(url.searchParams.get("ts")),
    signature: url.searchParams.get("sig"),
    channel: url.searchParams.get("channel"),
  });
}

describe("WhatsApp through the shared AgentPhone number", () => {
  it.each(["Hello Okou", "/connect", "/switch"])(
    "guides an unconnected DM into a signed WhatsApp connection for %s",
    async (body) => {
      const setup = await configure();
      const phone = sender();
      const proof = await requestWhatsappProof(setup, phone, body);
      expect(proof).toMatchObject({ phoneHandle: phone, channel: "whatsapp" });
      expect(
        (
          await accept(
            client().getConnectStatus({
              headers: headers(setup.actor),
              query: proof,
            }),
            [200],
          )
        ).body,
      ).toStrictEqual({ kind: "connect" });
      expect(
        (
          await accept(
            client().getLinkStatus({ headers: headers(setup.actor) }),
            [200],
          )
        ).body.linked,
      ).toBeFalsy();
      await accept(
        client().connectWhatsapp({
          headers: headers(setup.actor),
          body: proof,
        }),
        [200],
      );
      expect(
        (
          await accept(
            client().getConnectStatus({
              headers: headers(setup.actor),
              query: proof,
            }),
            [200],
          )
        ).body,
      ).toStrictEqual({ kind: "connected", phoneHandle: phone });
      expect(
        (await setup.integrations.getAgentPhoneLinkStatus(setup.actor)).linked,
      ).toBeFalsy();
      expect(
        setup.sends.slice(-3).every((message) => {
          return message.channel === "whatsapp" && message.to_number === phone;
        }),
      ).toBeTruthy();
      expect(setup.sends.at(-1)?.body).toContain(
        "What would you like to start with?",
      );
    },
  );

  it("identifies the connected workspace and offers recovery without an agent run", async () => {
    const setup = await configure();
    const phone = await connect(setup);
    context.mocks.clerk.organizations.getOrganization.mockResolvedValue({
      id: setup.actor.orgId,
      name: "WhatsApp workspace",
    });
    await setup.ap.postAgentPhoneInboundMessage({
      channel: "whatsapp",
      from: phone,
      body: "/connect",
    });
    expect(setup.sends.at(-1)?.body).toContain(
      'workspace "WhatsApp workspace"',
    );
    expect(setup.sends.at(-1)?.body).toContain("/switch");
    expect(setup.sends.at(-1)?.body).toContain("/disconnect");
  });

  it("answers help and disconnect before connection without starting an agent", async () => {
    const setup = await configure();
    const phone = sender();
    await setup.ap.postAgentPhoneInboundMessage({
      channel: "whatsapp",
      from: phone,
      body: "/help",
    });
    expect(setup.sends.at(-1)?.body).toContain("WhatsApp commands");
    await setup.ap.postAgentPhoneInboundMessage({
      channel: "whatsapp",
      from: phone,
      body: "/disconnect",
    });
    expect(setup.sends.at(-1)?.body).toContain("not connected. Send /connect");
  });

  it("rejects cross-channel and expired signed proofs without connecting", async () => {
    const setup = await configure();
    const proof = await requestWhatsappProof(setup);
    await accept(
      client().connectWhatsapp({
        headers: headers(setup.actor),
        body: { ...proof, channel: "imessage" },
      }),
      [400],
    );
    mockNow(now() + 11 * 60 * 1000);
    await accept(
      client().getConnectStatus({
        headers: headers(setup.actor),
        query: proof,
      }),
      [400],
    );
    await accept(
      client().connectWhatsapp({ headers: headers(setup.actor), body: proof }),
      [400],
    );
    expect(
      (
        await accept(
          client().getLinkStatus({ headers: headers(setup.actor) }),
          [200],
        )
      ).body.linked,
    ).toBeFalsy();
  });

  it("requires explicit number replacement and preserves the old link on a competing claim", async () => {
    const setup = await configure();
    const previous = await connect(setup);
    const proof = await requestWhatsappProof(setup);
    expect(
      (
        await accept(
          client().getConnectStatus({
            headers: headers(setup.actor),
            query: proof,
          }),
          [200],
        )
      ).body,
    ).toStrictEqual({ kind: "phone_mismatch", currentPhoneHandle: previous });
    await accept(
      client().connectWhatsapp({ headers: headers(setup.actor), body: proof }),
      [409],
    );
    const other = await configure();
    await accept(
      client().connectWhatsapp({ headers: headers(other.actor), body: proof }),
      [200],
    );
    await accept(
      client().connectWhatsapp({
        headers: headers(setup.actor),
        body: { ...proof, replacePhoneHandle: previous },
      }),
      [409],
    );
    expect(
      (
        await accept(
          client().getLinkStatus({ headers: headers(setup.actor) }),
          [200],
        )
      ).body,
    ).toMatchObject({ linked: true, phoneHandle: previous });
    await accept(client().unlink({ headers: headers(other.actor) }), [204]);
    await accept(
      client().connectWhatsapp({
        headers: headers(setup.actor),
        body: { ...proof, replacePhoneHandle: previous },
      }),
      [200],
    );
    expect(
      (
        await accept(
          client().getLinkStatus({ headers: headers(setup.actor) }),
          [200],
        )
      ).body,
    ).toMatchObject({ linked: true, phoneHandle: proof.phoneHandle });
    await setup.ap.postAgentPhoneInboundMessage({
      channel: "whatsapp",
      from: proof.phoneHandle,
      body: "/disconnect",
    });
    await setup.ap.postAgentPhoneInboundMessage({
      channel: "whatsapp",
      from: proof.phoneHandle,
      body: "/connect",
    });
    expect(setup.sends.at(-1)?.body).toContain("/settings/whatsapp?");
  });

  it("keeps file delivery disabled until its independent rollout switch is enabled", async () => {
    const setup = await configure();
    await connect(setup);
    const { file } = await uploadedWhatsappFile(setup);
    await accept(
      setupApp({ context, routes: featureSwitchesRoutes })(
        featureSwitchesContract,
      ).update({
        headers: headers(setup.actor),
        body: { switches: { [FeatureSwitchKey.WhatsappFileUpload]: false } },
      }),
      [200],
    );
    setup.sends.length = 0;
    await accept(
      client().sendUploadedFile({
        headers: headers(setup.actor),
        body: { fileId: file.id },
      }),
      [404],
    );
    expect(setup.sends).toHaveLength(0);
  });

  it("sends an owned private artifact as one WhatsApp attachment without publishing its fetch URL", async () => {
    const setup = await configure();
    const phone = await connect(setup);
    const { chat, file } = await uploadedWhatsappFile(setup);
    setup.sends.length = 0;
    const sent = await accept(
      client().sendUploadedFile({
        headers: headers(setup.actor),
        body: { fileId: file.id, caption: "Here is the report" },
      }),
      [200],
    );
    expect(sent.body).toMatchObject({
      channel: "whatsapp",
      toNumber: phone,
      file: { id: file.id, url: file.url, size: 1024 },
    });
    expect(sent.body.messages).toHaveLength(1);
    expect(setup.sends).toHaveLength(1);
    expect(setup.sends[0]).toMatchObject({
      channel: "whatsapp",
      from_number: AGENTPHONE_BDD_PHONE_NUMBER,
      to_number: phone,
      body: "Here is the report",
      media_urls: [expect.any(String)],
    });
    expect(
      (await chat.resolveWebFileUrl(setup.actor, file.id)).publicUrl,
    ).toBeNull();
    const media = setup.sends[0]?.media_urls;
    if (!Array.isArray(media) || typeof media[0] !== "string") {
      throw new Error("Expected one provider fetch URL");
    }
    expect(new URL(media[0]).protocol).toBe("https:");
    expect(new URL(media[0]).search).not.toBe("");
    const other = await configure();
    await connect(other);
    other.sends.length = 0;
    await accept(
      client().sendUploadedFile({
        headers: headers(other.actor),
        body: { fileId: file.id },
      }),
      [404],
    );
    expect(other.sends).toHaveLength(0);
  });

  it.each(["rejected", "unknown", "server-error"])(
    "preserves the uploaded artifact when file delivery is %s without retrying",
    async (outcome) => {
      const setup = await configure();
      await connect(setup);
      const { chat, file } = await uploadedWhatsappFile(setup);
      let attempts = 0;
      server.use(
        http.post(`${providerUrl}/v1/messages`, () => {
          attempts += 1;
          return outcome === "unknown"
            ? HttpResponse.error()
            : HttpResponse.json(
                { error: { code: "SEND_FAILED" } },
                { status: outcome === "rejected" ? 422 : 500 },
              );
        }),
      );
      const rejected = outcome === "rejected";
      const response = await accept(
        client().sendUploadedFile({
          headers: headers(setup.actor),
          body: { fileId: file.id },
        }),
        [400, 502],
      );
      expect(response.status).toBe(rejected ? 400 : 502);
      expect(response.body).toMatchObject({
        delivery: rejected ? "failed" : "unknown",
        file: { id: file.id, url: file.url },
      });
      expect(attempts).toBe(1);
      expect(
        (await chat.resolveWebFileUrl(setup.actor, file.id)).publicUrl,
      ).toBeNull();
    },
  );

  it("rejects an audio caption before sending and accepts the same audio without a caption", async () => {
    const setup = await configure();
    await connect(setup);
    const { file } = await uploadedWhatsappFile(setup, "audio/mpeg");
    setup.sends.length = 0;
    const rejected = await accept(
      client().sendUploadedFile({
        headers: headers(setup.actor),
        body: { fileId: file.id, caption: "Listen" },
      }),
      [400],
    );
    expect(rejected.body).toMatchObject({
      delivery: "failed",
      error: { code: "WHATSAPP_AUDIO_CAPTION_UNSUPPORTED" },
    });
    expect(setup.sends).toHaveLength(0);
    await accept(
      client().sendUploadedFile({
        headers: headers(setup.actor),
        body: { fileId: file.id },
      }),
      [200],
    );
    expect(setup.sends[0]).toMatchObject({
      channel: "whatsapp",
      body: "",
      media_urls: [expect.any(String)],
    });
  });

  it("verifies WhatsApp independently and disconnects it without changing the phone link", async () => {
    const setup = await configure();
    const phone = sender();
    const code = await accept(
      client().createLinkCode({ headers: headers(setup.actor) }),
      [200],
    );
    await setup.ap.postAgentPhoneInboundMessage({
      channel: "sms",
      from: phone,
      body: code.body.code,
    });
    expect(
      (
        await accept(
          client().getLinkStatus({ headers: headers(setup.actor) }),
          [200],
        )
      ).body.linked,
    ).toBeFalsy();
    await setup.ap.postAgentPhoneInboundMessage({
      channel: "whatsapp",
      from: phone,
      body: code.body.code,
    });
    expect(
      (
        await accept(
          client().getLinkStatus({ headers: headers(setup.actor) }),
          [200],
        )
      ).body,
    ).toMatchObject({
      linked: true,
      phoneHandle: phone,
      agentPhoneNumber: AGENTPHONE_BDD_PHONE_NUMBER,
    });
    expect(
      (await setup.integrations.getAgentPhoneLinkStatus(setup.actor)).linked,
    ).toBeFalsy();
    const phoneCode = await setup.integrations.requestCreateAgentPhoneLinkCode(
      setup.actor,
      [200],
    );
    await setup.ap.postAgentPhoneInboundMessage({
      channel: "sms",
      from: phone,
      body: phoneCode.body.code,
    });
    await accept(client().unlink({ headers: headers(setup.actor) }), [204]);
    expect(
      (await setup.integrations.getAgentPhoneLinkStatus(setup.actor)).linked,
    ).toBeTruthy();
    expect(
      (
        await accept(
          client().getLinkStatus({ headers: headers(setup.actor) }),
          [200],
        )
      ).body.linked,
    ).toBeFalsy();
  });

  it("rejects WhatsApp transport proofs on phone connection routes", async () => {
    const setup = await configure();
    const phone = sender();
    const key = "a".repeat(64);
    mockEnv("SECRETS_ENCRYPTION_KEY", key);
    const timestamp = Math.floor(now() / 1000);
    const proof = {
      phoneHandle: phone,
      agentphoneAgentId: AGENTPHONE_BDD_AGENT_ID,
      timestamp,
      channel: "whatsapp",
      signature: createHmac("sha256", key)
        .update(`${phone}:${AGENTPHONE_BDD_AGENT_ID}:${timestamp}:whatsapp`)
        .digest("hex"),
    };
    const phoneClient = setupApp({
      context,
      routes: integrationsAgentPhoneRoutes,
    })(integrationsAgentPhoneContract);
    await accept(
      phoneClient.getConnectStatus({
        headers: headers(setup.actor),
        query: proof,
      }),
      [400],
    );
    await setup.integrations.requestConnectAgentPhone(
      setup.actor,
      proof,
      [400],
    );
    expect(
      (await setup.integrations.getAgentPhoneLinkStatus(setup.actor)).linked,
    ).toBeFalsy();
    expect(
      (
        await accept(
          client().getLinkStatus({ headers: headers(setup.actor) }),
          [200],
        )
      ).body.linked,
    ).toBeFalsy();
  });

  it.each(["disconnect", "switch"] as const)(
    "%s only revokes the WhatsApp link when the same number also has a phone link",
    async (command) => {
      const setup = await configure();
      const phone = await connect(setup);
      const phoneCode =
        await setup.integrations.requestCreateAgentPhoneLinkCode(
          setup.actor,
          [200],
        );
      await setup.ap.postAgentPhoneInboundMessage({
        channel: "sms",
        from: phone,
        body: phoneCode.body.code,
      });
      setup.sends.length = 0;
      await setup.ap.postAgentPhoneInboundMessage({
        channel: "whatsapp",
        from: phone,
        body: `/${command}`,
      });
      expect(
        (
          await accept(
            client().getLinkStatus({ headers: headers(setup.actor) }),
            [200],
          )
        ).body.linked,
      ).toBeFalsy();
      expect(
        (await setup.integrations.getAgentPhoneLinkStatus(setup.actor)).linked,
      ).toBeTruthy();
      expect(setup.sends.at(-1)).toMatchObject({
        channel: "whatsapp",
        from_number: AGENTPHONE_BDD_PHONE_NUMBER,
        to_number: phone,
      });
      if (command === "switch") {
        expect(setup.sends.at(-1)?.body).toContain("/settings/whatsapp?");
        expect(setup.sends.at(-1)?.body).toContain("channel=whatsapp");
        await connect(setup, phone);
      }
    },
  );

  it.each(["connected", "unlink", "switch"] as const)(
    "routes WhatsApp run replies and respects connection changes (state before completion: %s)",
    async (connectionState) => {
      const setup = await configure();
      const fileEnabled = connectionState !== "switch";
      if (!fileEnabled) {
        await accept(
          setupApp({ context, routes: featureSwitchesRoutes })(
            featureSwitchesContract,
          ).update({
            headers: headers(setup.actor),
            body: {
              switches: { [FeatureSwitchKey.WhatsappFileUpload]: false },
            },
          }),
          [200],
        );
      }
      const runs = createRunsApi(context);
      setup.ap.acceptAgentPhoneObjectStorage();
      runs.acceptStorageDownloads();
      runs.acceptTelemetryIngest();
      context.mocks.ably.publish.mockResolvedValue(undefined);
      const runnerGroup = runs.configureRunnerGroup();
      await runs.grantProEntitlement(setup.actor);
      await runs.ensurePersonalSubscriptionModel(setup.actor);
      await runs.updateUserModelPreference(setup.actor, "claude-fable-5-1");
      const phone = await connect(setup);
      await setup.ap.postAgentPhoneInboundMessage({
        channel: "whatsapp",
        from: phone,
        body: "/help",
      });
      setup.sends.length = 0;
      const inputMessageId = await setup.ap.postAgentPhoneInboundMessage({
        channel: "whatsapp",
        from: phone,
        body: "Help me plan a meeting",
        conversationId: "whatsapp-conversation",
        recentHistory: [
          {
            content: "Private SMS history",
            channel: "sms",
            direction: "inbound",
          },
          {
            content: "Earlier WhatsApp request",
            channel: "whatsapp",
            direction: "inbound",
          },
        ],
      });
      await flushWaitUntilForTest();
      await runs.heartbeatRunner(runnerGroup);
      const polled = await runs.pollRunner(runnerGroup);
      const runId = polled.body.job?.runId;
      expect(runId).toBeTruthy();
      if (!runId) {
        throw new Error("Expected a queued WhatsApp run");
      }
      const run = await runs.claimRunnerJob(runId);
      expect(run.appendSystemPrompt).toContain("WhatsApp commands");
      expect(run.appendSystemPrompt).toContain("# WhatsApp Message Context");
      expect(run.appendSystemPrompt).toContain(
        "currently running inside: WhatsApp",
      );
      if (fileEnabled) {
        expect(run.appendSystemPrompt).toContain("okou whatsapp upload-file");
      } else {
        expect(run.appendSystemPrompt).not.toContain(
          "okou whatsapp upload-file",
        );
        expect(run.appendSystemPrompt).toContain(
          "Outbound file upload is not available on WhatsApp in this Run",
        );
      }
      expect(run.platformEnvironment.OKOU_CURRENT_INTEGRATION).toBe("whatsapp");
      expect(run.appendSystemPrompt).toContain(
        "okou whatsapp message send --help",
      );
      expect(run.appendSystemPrompt).toContain("private `/artifacts/...");
      expect(run.appendSystemPrompt).toContain("/help");
      expect(run.appendSystemPrompt).not.toContain("Private SMS history");
      if (connectionState === "unlink") {
        await accept(client().unlink({ headers: headers(setup.actor) }), [204]);
      } else if (connectionState === "switch") {
        await setup.ap.postAgentPhoneInboundMessage({
          channel: "whatsapp",
          from: phone,
          body: "/switch",
        });
        setup.sends.length = 0;
      }
      const webhooks = createWebhookCallbackApi(context);
      const sandboxHeaders = { authorization: `Bearer ${run.sandboxToken}` };
      await webhooks.requestAgentEvents(
        {
          runId,
          events: [
            {
              type: "result",
              sequenceNumber: 0,
              result: "Your meeting plan is ready.",
            },
          ],
        },
        sandboxHeaders,
        [200],
      );
      await webhooks.requestAgentComplete(
        {
          runId,
          exitCode: 0,
          lastEventSequence: 0,
          completion: {
            cliAgentType: "claude-code",
            cliAgentSessionId: `whatsapp-session-${runId}`,
            cliAgentSessionHistoryDisposition: "native_only",
          },
        },
        sandboxHeaders,
        [200],
      );
      await flushWaitUntilForTest();
      if (connectionState !== "connected") {
        expect(setup.sends).toHaveLength(0);
      } else {
        expect(setup.sends.at(-1)).toMatchObject({
          channel: "whatsapp",
          from_number: AGENTPHONE_BDD_PHONE_NUMBER,
          to_number: phone,
          body: "Your meeting plan is ready.",
          reply_to_message_id: inputMessageId,
        });
        await accept(
          client().sendMessage({
            headers: {
              authorization: `Bearer ${run.platformEnvironment.OKOU_TOKEN}`,
            },
            body: { text: "An explicitly requested extra message" },
          }),
          [200],
        );
      }
    },
  );

  it("sends long Unicode messages only through WhatsApp using the existing shared number", async () => {
    const setup = await configure();
    const phone = await connect(setup);
    setup.sends.length = 0;
    const text = "😀".repeat(4100);
    const sent = await accept(
      client().sendMessage({ headers: headers(setup.actor), body: { text } }),
      [200],
    );
    expect(sent.body).toMatchObject({ channel: "whatsapp", toNumber: phone });
    expect(sent.body.messages).toHaveLength(2);
    expect(setup.sends).toHaveLength(2);
    expect(
      setup.sends
        .map((message) => {
          return message.body;
        })
        .join(""),
    ).toBe(text);
    for (const message of setup.sends) {
      expect(message).toMatchObject({
        channel: "whatsapp",
        from_number: AGENTPHONE_BDD_PHONE_NUMBER,
        to_number: phone,
      });
      expect(Array.from(String(message.body)).length).toBeLessThanOrEqual(4096);
    }
    const other = setup.integrations.user();
    await accept(
      client().sendMessage({
        headers: headers(other),
        body: { text: "Cannot use someone else's connection" },
      }),
      [404],
    );
    expect(setup.sends).toHaveLength(2);
  });

  it("rejects expired and replaced codes while leaving the new code usable", async () => {
    const setup = await configure();
    const first = await accept(
      client().createLinkCode({ headers: headers(setup.actor) }),
      [200],
    );
    const second = await accept(
      client().createLinkCode({ headers: headers(setup.actor) }),
      [200],
    );
    const phone = sender();
    await setup.ap.postAgentPhoneInboundMessage({
      channel: "whatsapp",
      from: phone,
      body: first.body.code,
    });
    expect(
      (
        await accept(
          client().getLinkStatus({ headers: headers(setup.actor) }),
          [200],
        )
      ).body.linked,
    ).toBeFalsy();
    mockNow(now() + 10 * 60 * 1000 + 1);
    await setup.ap.postAgentPhoneInboundMessage({
      channel: "whatsapp",
      from: phone,
      body: second.body.code,
    });
    expect(
      (
        await accept(
          client().getLinkStatus({ headers: headers(setup.actor) }),
          [200],
        )
      ).body.linked,
    ).toBeFalsy();
    await connect(setup, phone);
  });

  it("keeps the integration disabled until enabled and the shared number is provisioned for WhatsApp", async () => {
    const setup = await configure(false);
    await accept(
      client().getLinkStatus({ headers: headers(setup.actor) }),
      [404],
    );
    await accept(
      setupApp({ context, routes: featureSwitchesRoutes })(
        featureSwitchesContract,
      ).update({
        headers: headers(setup.actor),
        body: {
          switches: {
            [FeatureSwitchKey.WhatsappIntegration]: true,
            [FeatureSwitchKey.WhatsappFileUpload]: true,
          },
        },
      }),
      [200],
    );
    mockOptionalEnv("AGENTPHONE_WEBHOOK_SECRET", undefined);
    expect(
      (
        await accept(
          client().getLinkStatus({ headers: headers(setup.actor) }),
          [200],
        )
      ).body.configured,
    ).toBeFalsy();
    await accept(
      client().createLinkCode({ headers: headers(setup.actor) }),
      [503],
    );
    setup.integrations.configureAgentPhoneWebhook();
    server.use(
      http.get(`${providerUrl}/v1/numbers`, () => {
        return HttpResponse.json({
          data: [
            {
              phoneNumber: AGENTPHONE_BDD_PHONE_NUMBER,
              whatsappEnabled: false,
            },
          ],
          hasMore: false,
        });
      }),
    );
    expect(
      (
        await accept(
          client().getLinkStatus({ headers: headers(setup.actor) }),
          [200],
        )
      ).body.configured,
    ).toBeFalsy();
    await accept(
      client().createLinkCode({ headers: headers(setup.actor) }),
      [503],
    );
  });

  it("does not bind unsupported markets or group messages", async () => {
    const setup = await configure();
    const code = await accept(
      client().createLinkCode({ headers: headers(setup.actor) }),
      [200],
    );
    await setup.ap.postAgentPhoneInboundMessage({
      channel: "whatsapp",
      from: "+12025550123",
      body: code.body.code,
    });
    await setup.ap.postAgentPhoneInboundMessage({
      channel: "whatsapp",
      from: sender(),
      body: code.body.code,
      isGroup: true,
    });
    expect(
      (
        await accept(
          client().getLinkStatus({ headers: headers(setup.actor) }),
          [200],
        )
      ).body.linked,
    ).toBeFalsy();
    expect(setup.sends).toHaveLength(0);
    await setup.ap.postAgentPhoneInboundMessage({
      channel: "whatsapp",
      from: sender(),
      body: code.body.code,
    });
    expect(
      (
        await accept(
          client().getLinkStatus({ headers: headers(setup.actor) }),
          [200],
        )
      ).body.linked,
    ).toBeTruthy();
  });

  it.each(["lost", "server-error"])(
    "preserves accepted part receipts when the next send has an uncertain outcome (%s)",
    async (outcome) => {
      const setup = await configure();
      await connect(setup);
      let sends = 0;
      server.use(
        http.post(`${providerUrl}/v1/messages`, () => {
          sends += 1;
          return sends === 1
            ? HttpResponse.json({
                id: "accepted-part",
                channel: "whatsapp",
                from_number: AGENTPHONE_BDD_PHONE_NUMBER,
              })
            : outcome === "lost"
              ? HttpResponse.error()
              : HttpResponse.json(
                  { error: { code: "INTERNAL_ERROR" } },
                  { status: 500 },
                );
        }),
      );
      const response = await accept(
        client().sendMessage({
          headers: headers(setup.actor),
          body: { text: "x".repeat(4100) },
        }),
        [502],
      );
      expect(response.body).toMatchObject({
        acceptedMessages: [{ id: "accepted-part" }],
        delivery: "unknown",
      });
      expect(response.body.error.message).toContain("accepted-part");
      expect(sends).toBe(2);
    },
  );

  it("returns the provider's service-window failure without retrying or changing transports", async () => {
    const setup = await configure();
    await connect(setup);
    const rejected: unknown[] = [];
    server.use(
      http.post(`${providerUrl}/v1/messages`, async ({ request }) => {
        rejected.push(await request.json());
        return HttpResponse.json(
          { error: { code: "CUSTOMER_SERVICE_WINDOW_CLOSED" } },
          { status: 422 },
        );
      }),
    );
    const result = await accept(
      client().sendMessage({
        headers: headers(setup.actor),
        body: { text: "Follow-up" },
      }),
      [400],
    );
    expect(result.body.error.message).toContain("24-hour service window");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ channel: "whatsapp" });
  });
});
