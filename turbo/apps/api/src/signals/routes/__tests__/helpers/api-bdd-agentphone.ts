import { mockClerkUsers } from "./clerk-users";
import { createHmac, randomInt, randomUUID } from "node:crypto";

import {
  integrationsPhoneUploadCompleteContract,
  integrationsPhoneUploadInitContract,
  type PhoneUploadCompleteBody,
  type PhoneUploadInitBody,
} from "@okouai/api-contracts/contracts/integrations";
import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";
import { logsByIdContract } from "@okouai/api-contracts/contracts/logs";
import { HttpResponse, http } from "msw";

import { createApp } from "../../../../app-factory";
import { env } from "../../../../lib/env";
import { now } from "../../../../lib/time";
import { accept, type TestContext } from "../../../../__tests__/test-context";
import { setupApp } from "../../../../__tests__/test-helpers";
import { server } from "../../../../mocks/server";
import { flushWaitUntilForTest } from "../../../context/wait-until";
import type { ApiTestUser } from "./api-bdd";
import {
  agentPhoneBddWebhookSecret,
  createBddIntegrationApi,
} from "./api-bdd-integrations";
import { sessionHistoryBlobBodyForKey } from "./api-bdd-session-history";
import { createRouteMocks } from "./route-test";
import { integrationsPhoneUploadCompleteRoutes } from "../../integrations-phone-upload-complete";
import { integrationsPhoneUploadInitRoutes } from "../../integrations-phone-upload-init";
import { integrationsPhoneDownloadFileRoutes } from "../../integrations-phone-download-file";
import { logsRoutes } from "../../logs";

const TEST_APP_ROUTES = Object.freeze([
  ...integrationsPhoneDownloadFileRoutes,
  ...integrationsPhoneUploadCompleteRoutes,
  ...integrationsPhoneUploadInitRoutes,
  ...logsRoutes,
]);

export const AGENTPHONE_BDD_AGENT_ID = "agt-bdd-agentphone";
export const AGENTPHONE_BDD_PHONE_NUMBER = "+19039853128";
const AGENTPHONE_API_BASE_URL = "https://api.agentphone.test";

export interface AgentPhoneProviderSend {
  readonly agentId: string | undefined;
  readonly toNumber: string | undefined;
  readonly conversationId: string | undefined;
  readonly replyToMessageId: string | undefined;
  readonly body: string | undefined;
  readonly mediaUrl: string | undefined;
}

export interface AgentPhoneSendCapture {
  readonly messages: readonly AgentPhoneProviderSend[];
  readonly typing: readonly string[];
}

interface AgentPhoneInboundMessage {
  readonly channel: "imessage" | "sms" | "mms";
  readonly from: string;
  readonly body: string;
  readonly messageId?: string;
  readonly conversationId?: string;
  readonly isGroup?: boolean;
  readonly mediaUrl?: string;
  readonly mentions?: readonly Readonly<Record<string, unknown>>[];
  readonly recentHistory?: readonly Readonly<Record<string, unknown>>[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function commandInput(command: unknown): Record<string, unknown> {
  if (
    typeof command === "object" &&
    command !== null &&
    "input" in command &&
    typeof command.input === "object" &&
    command.input !== null
  ) {
    return command.input as Record<string, unknown>;
  }
  return {};
}

function stringField(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function agentPhoneWebhookHeaders(
  body: string,
  webhookId: string,
): {
  readonly "x-webhook-signature": string;
  readonly "x-webhook-timestamp": string;
  readonly "x-webhook-event": string;
  readonly "x-webhook-id": string;
} {
  const timestamp = String(Math.floor(now() / 1000));
  return {
    "x-webhook-signature": `sha256=${createHmac(
      "sha256",
      agentPhoneBddWebhookSecret(),
    )
      .update(`${timestamp}.${body}`)
      .digest("hex")}`,
    "x-webhook-timestamp": timestamp,
    "x-webhook-event": "agent.message",
    "x-webhook-id": webhookId,
  };
}

export function uniquePhoneHandle(): string {
  return `+1555${randomInt(1_000_000, 9_999_999)}`;
}

export function uniqueConversationId(): string {
  return `conv-bdd-${randomUUID().slice(0, 13)}`;
}

function authenticate(
  context: TestContext,
  actor: ApiTestUser,
): { readonly authorization: string } {
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
      firstName: "BDD",
      lastName: "AgentPhone",
    },
  ]);
  return { authorization: "Bearer clerk-session" };
}

export function createAgentPhoneBddApi(context: TestContext) {
  const integrations = createBddIntegrationApi(context);

  function harvestConnectBody(capture: AgentPhoneSendCapture): {
    readonly phoneHandle: string;
    readonly agentphoneAgentId: string;
    readonly timestamp: number;
    readonly signature: string;
    readonly channel: string | undefined;
    readonly publicBrand: PublicBrand | undefined;
    readonly publicBrandSignature: string | undefined;
  } {
    const prompt = [...capture.messages].reverse().find((message) => {
      return message.body?.includes("/agentphone/connect?") ?? false;
    });
    const url = prompt?.body?.match(/https?:\/\/\S+/u)?.[0];
    if (!url) {
      throw new Error(
        "Expected a captured AgentPhone connect prompt with a connect URL",
      );
    }
    const params = new URL(url).searchParams;
    const timestamp = Number(params.get("ts") ?? "");
    if (!Number.isFinite(timestamp)) {
      throw new Error("Expected the AgentPhone connect URL to carry ts");
    }
    return {
      phoneHandle: params.get("handle") ?? "",
      agentphoneAgentId: params.get("agent") ?? "",
      timestamp,
      signature: params.get("sig") ?? "",
      channel: params.get("channel") ?? undefined,
      publicBrand:
        params.get("publicBrand") === "okou"
          ? "okou"
          : params.get("publicBrand") === "vm0"
            ? "vm0"
            : undefined,
      publicBrandSignature: params.get("brandSig") ?? undefined,
    };
  }

  async function postAgentPhoneInboundMessage(
    message: AgentPhoneInboundMessage,
  ): Promise<string> {
    const messageId = message.messageId ?? `ap-msg-${randomUUID()}`;
    const rawBody = JSON.stringify({
      event: "agent.message",
      channel: message.channel,
      ...(message.recentHistory
        ? { recentHistory: message.recentHistory }
        : {}),
      data: {
        id: messageId,
        agentId: AGENTPHONE_BDD_AGENT_ID,
        from: message.from,
        to: AGENTPHONE_BDD_PHONE_NUMBER,
        body: message.body,
        ...(message.conversationId
          ? { conversationId: message.conversationId }
          : {}),
        ...(message.isGroup === undefined ? {} : { isGroup: message.isGroup }),
        ...(message.mediaUrl ? { mediaUrl: message.mediaUrl } : {}),
        ...(message.mentions ? { mentions: message.mentions } : {}),
      },
    });
    await integrations.requestAgentPhoneWebhook(
      rawBody,
      agentPhoneWebhookHeaders(rawBody, `evt-bdd-agentphone-${randomUUID()}`),
      [200],
    );
    // Webhook handling is waitUntil-detached; drain it so follow-up steps
    // cannot observe provider sends before thread/session state is persisted.
    await flushWaitUntilForTest();
    return messageId;
  }

  return {
    postAgentPhoneInboundMessage,

    captureAgentPhoneSends(): AgentPhoneSendCapture {
      const messages: AgentPhoneProviderSend[] = [];
      const typing: string[] = [];
      server.use(
        http.post(
          `${AGENTPHONE_API_BASE_URL}/v1/messages`,
          async ({ request }) => {
            const raw: unknown = await request.json();
            const record = isRecord(raw) ? raw : {};
            const send: AgentPhoneProviderSend = {
              agentId: stringField(record, "agent_id"),
              toNumber: stringField(record, "to_number"),
              conversationId: stringField(record, "conversation_id"),
              replyToMessageId: stringField(record, "reply_to_message_id"),
              body: stringField(record, "body"),
              mediaUrl: stringField(record, "media_url"),
            };
            messages.push(send);
            return HttpResponse.json({
              id: `apmsg_${randomUUID()}`,
              status: "sent",
              channel: "sms",
              from_number: AGENTPHONE_BDD_PHONE_NUMBER,
              to_number: send.toNumber ?? null,
              media_urls: send.mediaUrl ? [send.mediaUrl] : [],
            });
          },
        ),
        http.post(
          `${AGENTPHONE_API_BASE_URL}/v1/conversations/:id/typing`,
          ({ params }) => {
            typing.push(typeof params.id === "string" ? params.id : "");
            return HttpResponse.json({ status: "typing indicator sent" });
          },
        ),
      );
      return { messages, typing };
    },

    async linkViaWebhookConnectPrompt(
      actor: ApiTestUser,
      phone: string,
      capture: AgentPhoneSendCapture,
    ): Promise<void> {
      await postAgentPhoneInboundMessage({
        channel: "sms",
        from: phone,
        body: "hi",
      });
      const connectBody = harvestConnectBody(capture);
      await integrations.requestConnectAgentPhone(actor, connectBody, [200]);
      const welcome = capture.messages.at(-1);
      if (
        welcome?.toNumber !== phone ||
        welcome.agentId !== AGENTPHONE_BDD_AGENT_ID
      ) {
        throw new Error(
          "Expected the AgentPhone connect welcome text to reach the linked phone",
        );
      }
      const status = await integrations.getAgentPhoneLinkStatus(actor);
      if (!status.linked || status.phoneHandle !== phone) {
        throw new Error(
          `Expected AgentPhone link status to show ${phone} as linked`,
        );
      }
    },

    async requestPhoneUploadInitWithToken<Status extends 200 | 400 | 401 | 403>(
      token: string,
      body: PhoneUploadInitBody,
      statuses: readonly Status[],
    ) {
      const client = setupApp({
        context,
        routes: integrationsPhoneUploadInitRoutes,
      })(integrationsPhoneUploadInitContract);
      return await accept(
        client.init({
          headers: { authorization: `Bearer ${token}` },
          body,
        }),
        statuses,
      );
    },

    async requestPhoneUploadCompleteWithToken<
      Status extends 200 | 400 | 401 | 403 | 404 | 502,
    >(
      token: string,
      body: PhoneUploadCompleteBody,
      statuses: readonly Status[],
    ) {
      const client = setupApp({
        context,
        routes: integrationsPhoneUploadCompleteRoutes,
      })(integrationsPhoneUploadCompleteContract);
      return await accept(
        client.complete({
          headers: { authorization: `Bearer ${token}` },
          body,
        }),
        statuses,
      );
    },

    /**
     * Read a run's agent session id through the public activity-detail API
     * (GET /api/logs/:id) — the only session projection visible without
     * checkpoints.
     */
    async readRunSessionId(actor: ApiTestUser, runId: string): Promise<string> {
      const client = setupApp({ context, routes: logsRoutes })(
        logsByIdContract,
      );
      const response = await accept(
        client.getById({
          headers: authenticate(context, actor),
          params: { id: runId },
        }),
        [200],
      );
      if (!response.body.sessionId) {
        throw new Error(`Expected run ${runId} to expose a session id`);
      }
      return response.body.sessionId;
    },

    async downloadPhoneFileRaw(
      token: string,
      fileId: string,
    ): Promise<{
      readonly status: number;
      readonly headers: Headers;
      readonly text: string;
    }> {
      const response = await createApp({
        signal: context.signal,
        routes: TEST_APP_ROUTES,
      }).request(
        `/api/integrations/phone/download-file?file_id=${encodeURIComponent(fileId)}`,
        {
          method: "GET",
          headers: { authorization: `Bearer ${token}` },
        },
      );
      return {
        status: response.status,
        headers: response.headers,
        text: await response.text(),
      };
    },

    /**
     * Object-storage fake for AgentPhone chains: session-history blobs
     * download with deterministic content (so checkpointed sessions resume
     * end to end), registered upload objects appear in prefix listings
     * (phone upload-complete), and every other command acks like the plain
     * storage-write mock.
     */
    acceptAgentPhoneObjectStorage(): {
      addArtifactObject(object: {
        readonly userId: string;
        readonly uploadId: string;
        readonly filename: string;
        readonly size: number;
      }): void;
    } {
      const objects: {
        readonly bucket: string;
        readonly key: string;
        readonly size: number;
      }[] = [];
      context.mocks.s3.send.mockImplementation((...args: unknown[]) => {
        const input = commandInput(args[0]);
        const key = typeof input.Key === "string" ? input.Key : "";
        if (key.startsWith("blobs/") && key.endsWith(".blob")) {
          const body = sessionHistoryBlobBodyForKey(context, key);
          return Promise.resolve({
            Body: {
              async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
                if (body) {
                  yield body;
                }
              },
            },
          });
        }
        const bucket = typeof input.Bucket === "string" ? input.Bucket : "";
        const prefix = typeof input.Prefix === "string" ? input.Prefix : "";
        if (prefix !== "") {
          const contents = objects
            .filter((object) => {
              return object.bucket === bucket && object.key.startsWith(prefix);
            })
            .map((object) => {
              return {
                Key: object.key,
                Size: object.size,
                LastModified: new Date("2026-01-01T00:00:00.000Z"),
              };
            });
          return Promise.resolve({ Contents: contents });
        }
        return Promise.resolve({});
      });
      return {
        addArtifactObject(object): void {
          objects.push({
            bucket: env("R2_USER_ARTIFACTS_BUCKET_NAME"),
            key: `artifacts/${object.userId}/${object.uploadId}/${object.filename}`,
            size: object.size,
          });
        },
      };
    },
  };
}
