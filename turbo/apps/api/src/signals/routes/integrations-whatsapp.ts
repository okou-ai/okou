import { integrationsWhatsappContract as contract } from "@okouai/api-contracts/contracts/integrations-whatsapp";
import {
  whatsappConnectionCodes,
  whatsappUserLinks,
} from "@okouai/db/schema/whatsapp";
import { and, eq } from "drizzle-orm";
import { command } from "ccstate";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { writeDb$ } from "../external/db";
import {
  isAgentPhoneApiError,
  sendAgentPhoneMessage,
} from "../external/agentphone-client";
import { createAgentPhoneConnectionCode$ } from "../services/agentphone-connection-code.service";
import {
  agentPhoneReplyChunks,
  storeOutboundAgentPhoneMessage$,
} from "../services/agentphone-shared.service";
import { publishAgentPhoneUserChanged } from "../services/agentphone.service";
import {
  isWhatsappSupportedHandle,
  whatsappConfigured,
  whatsappEnabled$,
  whatsappPhoneNumber,
} from "../services/whatsapp-config";
import { env, optionalEnv } from "../../lib/env";
import { conflict, notFound } from "../../lib/error";
import { settle } from "../utils";
import type { RouteEntry } from "../route-entry";

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

export const integrationsWhatsappRoutes: readonly RouteEntry[] = [
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
