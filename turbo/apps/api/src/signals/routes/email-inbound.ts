import { recordSentEmailMessageId$ } from "../services/email-channel-maintenance.service";
import { uuid } from "zod";
import { handleReceivedChannelEmail$ } from "../services/email-channel.service";
import { command } from "ccstate";
import { emailInboundContract } from "@okouai/api-contracts/contracts/email";
import { emailSuppressions } from "@okouai/db/schema/email-suppression";

import { request$ } from "../context/hono";
import { clerk$ } from "../external/clerk";
import { writeDb$ } from "../external/db";
import type { RouteEntry } from "../route-entry";
import {
  getSvixHeaders,
  getUserIdByEmail$,
  unsubscribeUser$,
  verifyResendWebhook,
} from "../services/email-common.service";
import { safeSync } from "../utils";

interface WebhookEvent {
  readonly type?: string;
  readonly data?: {
    readonly to?: readonly string[];
    readonly email_id?: string;
    readonly message_id?: string;
    readonly tags?: Readonly<Record<string, string>>;
  };
}

function jsonResponse(
  body: { readonly received: true } | { readonly error: string },
  status = 200,
): Response {
  return Response.json(body, { status });
}

const handleBounce$ = command(
  async ({ set }, event: WebhookEvent, signal: AbortSignal): Promise<void> => {
    const recipients = event.data?.to ?? [];
    if (recipients.length === 0) {
      return;
    }
    const db = set(writeDb$);
    await db
      .insert(emailSuppressions)
      .values(
        recipients.map((address) => {
          return {
            emailAddress: address,
            reason: "bounced",
            resendEmailId: event.data?.email_id ?? null,
          };
        }),
      )
      .onConflictDoNothing();
    signal.throwIfAborted();
  },
);

const handleComplaint$ = command(
  async (
    { get, set },
    event: WebhookEvent,
    signal: AbortSignal,
  ): Promise<void> => {
    const recipients = event.data?.to ?? [];
    if (recipients.length === 0) {
      return;
    }
    const db = set(writeDb$);
    await db
      .insert(emailSuppressions)
      .values(
        recipients.map((address) => {
          return {
            emailAddress: address,
            reason: "complained",
            resendEmailId: event.data?.email_id ?? null,
          };
        }),
      )
      .onConflictDoNothing();
    signal.throwIfAborted();

    // Preserve Clerk initialization and error timing even for cached recipients.
    get(clerk$);
    for (const address of recipients) {
      const userId = await set(getUserIdByEmail$, address);
      signal.throwIfAborted();
      if (userId) {
        await set(unsubscribeUser$, userId);
        signal.throwIfAborted();
      }
    }
  },
);

const handleInboundRoute$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const req = get(request$);
    const svixHeaders = getSvixHeaders(req.raw.headers);
    if (!svixHeaders) {
      return jsonResponse({ error: "Missing signature headers" }, 401);
    }

    const rawBody = await req.text();
    signal.throwIfAborted();

    const payloadResult = safeSync(() => {
      return verifyResendWebhook(rawBody, svixHeaders);
    });
    signal.throwIfAborted();
    if ("error" in payloadResult) {
      return jsonResponse({ error: "Invalid signature" }, 401);
    }

    const event = payloadResult.ok as WebhookEvent;
    if (event.type === "email.bounced") {
      await set(handleBounce$, event, signal);
      signal.throwIfAborted();
    } else if (event.type === "email.complained") {
      await set(handleComplaint$, event, signal);
      signal.throwIfAborted();
    }

    if (event.type === "email.sent") {
      await set(
        recordSentEmailMessageId$,
        {
          outboxId: event.data?.tags?.okou_email_message,
          messageId: event.data?.message_id,
        },
        signal,
      );
    }
    if (event.type === "email.received") {
      const emailId = uuid().safeParse(event.data?.email_id);
      if (emailId.success) {
        await set(handleReceivedChannelEmail$, emailId.data, signal);
        signal.throwIfAborted();
      }
    }
    return jsonResponse({ received: true });
  },
);

export const emailInboundRoutes: readonly RouteEntry[] = [
  {
    route: emailInboundContract.post,
    handler: handleInboundRoute$,
  },
];
