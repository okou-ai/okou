import {
  integrationsWhatsappContract as contract,
  type WhatsappFile,
} from "@okouai/api-contracts/contracts/integrations-whatsapp";
import {
  whatsappConnectionCodes,
  whatsappUserLinks,
} from "@okouai/db/schema/whatsapp";
import { and, eq } from "drizzle-orm";
import { command } from "ccstate";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, queryOf } from "../context/request";
import { writeDb$ } from "../external/db";
import {
  isAgentPhoneApiError,
  sendAgentPhoneMessage,
} from "../external/agentphone-client";
import {
  materializeUploadedArtifact$,
  uploadedArtifactFetchUrl$,
} from "../services/uploaded-artifact.service";
import { createAgentPhoneConnectionCode$ } from "../services/agentphone-connection-code.service";
import {
  agentPhoneReplyChunks,
  normalizeAgentPhoneHandle,
  storeOutboundAgentPhoneMessage$,
} from "../services/agentphone-shared.service";
import {
  publishAgentPhoneUserChanged,
  publishAgentPhoneUserLinked,
  verifyAgentPhoneConnectSignature,
} from "../services/agentphone.service";
import { sendAgentPhoneConnectedMessages$ } from "../services/agentphone-connected-messages.service";
import { switchAgentPhoneIdentity$ } from "../services/agentphone-link.service";
import { connectWhatsappIdentity$ } from "../services/whatsapp-link.service";
import type {
  AgentPhoneConnectRequest,
  AgentPhoneConnectStatus,
} from "@okouai/api-contracts/contracts/integrations-agentphone";
import {
  isWhatsappSupportedHandle,
  whatsappConfigured,
  whatsappEnabled$,
  whatsappFileUploadEnabled$,
  whatsappPhoneNumber,
} from "../services/whatsapp-config";
import { logger } from "../../lib/log";
import { env, optionalEnv } from "../../lib/env";
import { badRequestMessage, conflict, notFound } from "../../lib/error";
import { settle, tapError } from "../utils";
import type { RouteEntry } from "../route-entry";

const log = logger("api:whatsapp:link");

const authOptions = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
} as const;
function notConfigured() {
  return {
    status: 503 as const,
    body: {
      error: {
        code: "NOT_CONFIGURED",
        message: "WhatsApp messaging is not configured",
      },
    },
  };
}
const loadLink$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  if (!(await set(whatsappEnabled$, auth.orgId, auth.userId, signal))) {
    return { enabled: false as const, link: null };
  }
  const [link] = await set(writeDb$)
    .select()
    .from(whatsappUserLinks)
    .where(
      and(
        eq(whatsappUserLinks.userId, auth.userId),
        eq(whatsappUserLinks.orgId, auth.orgId),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  return { enabled: true as const, link: link ?? null };
});

function verifiedWhatsappHandle(
  proof: AgentPhoneConnectRequest,
): string | null {
  const phoneHandle = normalizeAgentPhoneHandle(proof.phoneHandle, "whatsapp");
  return proof.channel === "whatsapp" &&
    isWhatsappSupportedHandle(phoneHandle) &&
    verifyAgentPhoneConnectSignature({
      phoneHandle,
      agentphoneAgentId: proof.agentphoneAgentId,
      timestamp: proof.timestamp,
      channel: "whatsapp",
      signature: proof.signature,
      secret: env("SECRETS_ENCRYPTION_KEY"),
    })
    ? phoneHandle
    : null;
}

const getConnectStatus$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const { enabled, link: current } = await set(loadLink$, signal);
  if (!enabled) {
    return notFound("WhatsApp integration is not enabled");
  }
  const phoneHandle = verifiedWhatsappHandle(
    get(queryOf(contract.getConnectStatus)),
  );
  if (!phoneHandle) {
    return badRequestMessage(
      "Invalid or expired WhatsApp connection link. Send /connect again.",
    );
  }
  const [requested] = await set(writeDb$)
    .select()
    .from(whatsappUserLinks)
    .where(eq(whatsappUserLinks.phoneHandle, phoneHandle))
    .limit(1);
  signal.throwIfAborted();
  const body: AgentPhoneConnectStatus = requested
    ? requested.userId === auth.userId && requested.orgId === auth.orgId
      ? { kind: "connected", phoneHandle }
      : { kind: "phone_in_use" }
    : current
      ? { kind: "phone_mismatch", currentPhoneHandle: current.phoneHandle }
      : { kind: "connect" };
  return { status: 200 as const, body };
});

const connectWhatsapp$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const { enabled } = await set(loadLink$, signal);
  if (!enabled) {
    return notFound("WhatsApp integration is not enabled");
  }
  const result = await get(bodyResultOf(contract.connectWhatsapp));
  signal.throwIfAborted();
  if (!result.ok) {
    return result.response;
  }
  const proof = result.data;
  const phoneHandle = verifiedWhatsappHandle(proof);
  if (!phoneHandle) {
    return badRequestMessage(
      "Invalid or expired WhatsApp connection link. Send /connect again.",
    );
  }
  if (!(await whatsappConfigured(signal))) {
    return notConfigured();
  }
  const linked = proof.replacePhoneHandle
    ? await set(
        switchAgentPhoneIdentity$,
        {
          userId: auth.userId,
          orgId: auth.orgId,
          phoneHandle,
          replacePhoneHandle: proof.replacePhoneHandle,
          channel: "whatsapp",
        },
        signal,
      )
    : await set(
        connectWhatsappIdentity$,
        { userId: auth.userId, orgId: auth.orgId, phoneHandle },
        signal,
      );
  signal.throwIfAborted();
  if (linked.kind !== "linked") {
    return conflict(
      linked.kind === "stale"
        ? "Your WhatsApp connection changed. Reload this page and try again."
        : "This WhatsApp account or workspace is already connected. Disconnect it first, or confirm the number you want to replace.",
    );
  }
  await publishAgentPhoneUserLinked(auth.userId);
  signal.throwIfAborted();
  await tapError(
    set(
      sendAgentPhoneConnectedMessages$,
      {
        userLinkId: linked.userLink.id,
        agentphoneAgentId: proof.agentphoneAgentId,
        toNumber: phoneHandle,
        channel: "whatsapp",
      },
      signal,
    ),
    (error) => {
      // Binding is already committed; a failed welcome must not undo ownership.
      log.warn("Connected WhatsApp user but confirmation failed", { error });
    },
  );
  signal.throwIfAborted();
  return { status: 200 as const, body: { phoneHandle } };
});

const getLinkStatus$ = command(async ({ set }, signal: AbortSignal) => {
  const { enabled, link } = await set(loadLink$, signal);
  if (!enabled) {
    return notFound("WhatsApp integration is not enabled");
  }
  const config = {
    agentPhoneNumber: whatsappPhoneNumber(),
    configured: await whatsappConfigured(signal),
  };
  return {
    status: 200 as const,
    body: link
      ? { ...config, linked: true as const, phoneHandle: link.phoneHandle }
      : { ...config, linked: false as const },
  };
});

const createLinkCode$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const { enabled, link } = await set(loadLink$, signal);
  if (!enabled) {
    return notFound("WhatsApp integration is not enabled");
  }
  if (!(await whatsappConfigured(signal))) {
    return notConfigured();
  }
  if (link) {
    return conflict("Your WhatsApp account is already connected");
  }
  const code = await set(
    createAgentPhoneConnectionCode$,
    {
      userId: auth.userId,
      orgId: auth.orgId,
      secret: env("SECRETS_ENCRYPTION_KEY"),
      channel: "whatsapp",
    },
    signal,
  );
  return {
    status: 200 as const,
    body: { code: code.code, expiresAt: code.expiresAt.toISOString() },
  };
});

const unlink$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const { enabled } = await set(loadLink$, signal);
  if (!enabled) {
    return notFound("WhatsApp integration is not enabled");
  }
  const db = set(writeDb$);
  await db
    .delete(whatsappConnectionCodes)
    .where(
      and(
        eq(whatsappConnectionCodes.userId, auth.userId),
        eq(whatsappConnectionCodes.orgId, auth.orgId),
      ),
    );
  signal.throwIfAborted();
  await db
    .delete(whatsappUserLinks)
    .where(
      and(
        eq(whatsappUserLinks.userId, auth.userId),
        eq(whatsappUserLinks.orgId, auth.orgId),
      ),
    );
  signal.throwIfAborted();
  await publishAgentPhoneUserChanged(auth.userId);
  signal.throwIfAborted();
  return { status: 204 as const, body: undefined };
});

const sendMessage$ = command(async ({ get, set }, signal: AbortSignal) => {
  const result = await get(bodyResultOf(contract.sendMessage));
  signal.throwIfAborted();
  if (!result.ok) {
    return result.response;
  }
  const { enabled, link } = await set(loadLink$, signal);
  if (!enabled || !link || !isWhatsappSupportedHandle(link.phoneHandle)) {
    return notFound("No supported WhatsApp account is connected");
  }
  const agentphoneAgentId = optionalEnv("AGENTPHONE_AGENT_ID");
  const fromNumber = whatsappPhoneNumber();
  if (
    !agentphoneAgentId ||
    !fromNumber ||
    !(await whatsappConfigured(signal))
  ) {
    return notConfigured();
  }
  const messages: { id: string }[] = [];
  for (const body of agentPhoneReplyChunks(result.data.text, "whatsapp")) {
    const sent = await settle(
      sendAgentPhoneMessage(
        {
          agentphoneAgentId,
          toNumber: link.phoneHandle,
          channel: "whatsapp",
          body,
        },
        signal,
      ),
      signal,
    );
    if (!sent.ok) {
      const providerError = isAgentPhoneApiError(sent.error)
        ? sent.error
        : null;
      if (
        !providerError &&
        !(sent.error instanceof TypeError) &&
        !(sent.error instanceof SyntaxError)
      ) {
        throw sent.error;
      }
      const rejected = providerError !== null && providerError.status < 500;
      return {
        status: rejected ? (400 as const) : (502 as const),
        body: {
          acceptedMessages: messages,
          delivery: rejected ? ("failed" as const) : ("unknown" as const),
          error: {
            code: "WHATSAPP_SEND_FAILED",
            message: `${rejected ? `WhatsApp rejected the message (HTTP ${providerError.status}).` : "The latest WhatsApp send has an unknown delivery outcome. Do not retry it automatically."} ${messages.length} part(s) accepted${
              messages.length
                ? ` (${messages
                    .map((message) => {
                      return message.id;
                    })
                    .join(", ")})`
                : ""
            }. Outside the 24-hour service window, an approved template is required.`,
          },
        },
      };
    }
    await set(storeOutboundAgentPhoneMessage$, {
      agentphoneMessageId: sent.value.id,
      conversationId: null,
      agentphoneAgentId,
      userLinkId: link.id,
      phoneHandle: link.phoneHandle,
      fromNumber: sent.value.fromNumber ?? fromNumber,
      toNumber: sent.value.toNumber,
      body,
      channel: "whatsapp",
      userChannel: "whatsapp",
      visibilityRecipients: [],
    });
    signal.throwIfAborted();
    messages.push({ id: sent.value.id });
  }
  return {
    status: 200 as const,
    body: {
      channel: "whatsapp" as const,
      toNumber: link.phoneHandle,
      messages,
    },
  };
});

function whatsappFileSendFailure(error: unknown, file: WhatsappFile) {
  const providerError = isAgentPhoneApiError(error) ? error : null;
  if (
    !providerError &&
    !(error instanceof TypeError) &&
    !(error instanceof SyntaxError)
  ) {
    throw error;
  }
  const rejected = providerError !== null && providerError.status < 500;
  return {
    status: rejected ? (400 as const) : (502 as const),
    body: {
      file,
      delivery: rejected ? ("failed" as const) : ("unknown" as const),
      error: {
        code: "WHATSAPP_SEND_FAILED",
        message: rejected
          ? `WhatsApp rejected the file (HTTP ${providerError.status}). Check the file type and the 24-hour service window before another send. The uploaded artifact remains available.`
          : "The WhatsApp file send has an unknown delivery outcome. Do not retry it automatically. The uploaded artifact remains available.",
      },
    },
  };
}

const sendUploadedFile$ = command(async ({ get, set }, signal: AbortSignal) => {
  const result = await get(bodyResultOf(contract.sendUploadedFile));
  signal.throwIfAborted();
  if (!result.ok) {
    return result.response;
  }
  const auth = get(organizationAuthContext$);
  if (
    !(await set(whatsappFileUploadEnabled$, auth.orgId, auth.userId, signal))
  ) {
    return notFound("WhatsApp file delivery is not enabled");
  }
  const { enabled, link } = await set(loadLink$, signal);
  if (!enabled || !link || !isWhatsappSupportedHandle(link.phoneHandle)) {
    return notFound("No supported WhatsApp account is connected");
  }
  const agentphoneAgentId = optionalEnv("AGENTPHONE_AGENT_ID");
  const fromNumber = whatsappPhoneNumber();
  if (
    !agentphoneAgentId ||
    !fromNumber ||
    !(await whatsappConfigured(signal))
  ) {
    return notConfigured();
  }
  const object = await set(
    materializeUploadedArtifact$,
    {
      userId: auth.userId,
      orgId: auth.orgId,
      id: result.data.fileId,
    },
    signal,
  );
  signal.throwIfAborted();
  if (!object) {
    return notFound("Uploaded file not found");
  }
  const file = {
    id: result.data.fileId,
    filename: object.filename,
    contentType: object.contentType,
    size: object.size,
    url: object.url,
  };
  if (object.contentType.startsWith("audio/") && result.data.caption) {
    return {
      status: 400 as const,
      body: {
        file,
        delivery: "failed" as const,
        error: {
          code: "WHATSAPP_AUDIO_CAPTION_UNSUPPORTED",
          message:
            "WhatsApp audio cannot carry a caption. Send the audio without --text and send any text separately.",
        },
      },
    };
  }
  const fetchUrl = await set(uploadedArtifactFetchUrl$, object, signal);
  signal.throwIfAborted();
  const sent = await settle(
    sendAgentPhoneMessage(
      {
        agentphoneAgentId,
        toNumber: link.phoneHandle,
        channel: "whatsapp",
        body: result.data.caption ?? "",
        mediaUrls: [fetchUrl],
      },
      signal,
    ),
    signal,
  );
  if (!sent.ok) {
    return whatsappFileSendFailure(sent.error, file);
  }
  // Archive the accepted effect before cancellation can hide its receipt.
  await set(storeOutboundAgentPhoneMessage$, {
    agentphoneMessageId: sent.value.id,
    conversationId: null,
    agentphoneAgentId,
    userLinkId: link.id,
    phoneHandle: link.phoneHandle,
    fromNumber: sent.value.fromNumber ?? fromNumber,
    toNumber: sent.value.toNumber,
    body: result.data.caption,
    mediaUrl: object.url,
    channel: "whatsapp",
    userChannel: "whatsapp",
    visibilityRecipients: [],
  });
  signal.throwIfAborted();
  return {
    status: 200 as const,
    body: {
      channel: "whatsapp" as const,
      toNumber: link.phoneHandle,
      messages: [{ id: sent.value.id }],
      file,
    },
  };
});

export const integrationsWhatsappRoutes: readonly RouteEntry[] = [
  {
    route: contract.getConnectStatus,
    handler: authRoute(authOptions, getConnectStatus$),
  },
  {
    route: contract.connectWhatsapp,
    handler: authRoute(authOptions, connectWhatsapp$),
  },
  {
    route: contract.sendUploadedFile,
    handler: authRoute(
      { ...authOptions, requiredCapability: "whatsapp:file:write" },
      sendUploadedFile$,
    ),
  },
  {
    route: contract.getLinkStatus,
    handler: authRoute(authOptions, getLinkStatus$),
  },
  {
    route: contract.createLinkCode,
    handler: authRoute(authOptions, createLinkCode$),
  },
  { route: contract.unlink, handler: authRoute(authOptions, unlink$) },
  {
    route: contract.sendMessage,
    handler: authRoute(
      { ...authOptions, requiredCapability: "whatsapp:write" },
      sendMessage$,
    ),
  },
];
