import { feishuOrgInstallations } from "@okouai/db/schema/feishu-org-installation";
import { userFeatureSwitches } from "@okouai/db/schema/user-feature-switches";
import { command } from "ccstate";
import { eq } from "drizzle-orm";

import { db$, writeDb$ } from "../external/db";
import {
  FeishuApiError,
  feishuMessagePayload,
  feishuTokenUpdateValues,
  parseFeishuSentMessage,
  readFeishuResponseJson,
  resolveFeishuRequestCredentials,
  type FeishuOutboundMessage,
  type FeishuSentMessage,
} from "../external/feishu-client";
import {
  feishuInstallationAvailabilityReadPlan,
  feishuInstallationEnabledFromRows,
} from "./feishu-config";

export type FeishuMessageDelivery = {
  readonly installationId: string;
  readonly message: FeishuOutboundMessage;
  readonly idempotencyKey?: string;
} & (
  | {
      readonly kind: "send";
      readonly receiveIdType: "chat_id" | "open_id";
      readonly receiveId: string;
    }
  | {
      readonly kind: "reply";
      readonly messageId: string;
      readonly replyInThread?: boolean;
    }
);

export const deliverFeishuMessage$ = command(
  (
    { get, set },
    args: FeishuMessageDelivery,
    signal: AbortSignal,
  ): Promise<FeishuSentMessage> => {
    return (async () => {
      const contextArgs = args;
      const contextSignal = signal;
      const { token, apiOrigin, providerName } = await (async () => {
        const [installation] = await get(db$)
          .select()
          .from(feishuOrgInstallations)
          .where(eq(feishuOrgInstallations.id, contextArgs.installationId))
          .limit(1);
        contextSignal.throwIfAborted();
        if (!installation) {
          throw new Error("Bot installation not found");
        }
        if (
          !(await (async () => {
            const plan = feishuInstallationAvailabilityReadPlan(installation);
            if (plan.kind === "resolved") {
              return plan.enabled;
            }
            const rows = await get(db$)
              .select(plan.columns)
              .from(userFeatureSwitches)
              .where(plan.condition);
            return feishuInstallationEnabledFromRows(plan.scope, rows);
          })())
        ) {
          throw new FeishuApiError("Lark integration is not enabled", 403);
        }
        const credentials = await resolveFeishuRequestCredentials(
          installation,
          contextSignal,
        );
        if (credentials.refreshedToken) {
          await set(writeDb$)
            .update(feishuOrgInstallations)
            .set(feishuTokenUpdateValues(credentials.refreshedToken))
            .where(eq(feishuOrgInstallations.id, contextArgs.installationId));
          contextSignal.throwIfAborted();
        }
        return credentials.context;
      })();
      if (args.kind === "reply") {
        const response = fetch(
          `${apiOrigin}/open-apis/im/v1/messages/${encodeURIComponent(args.messageId)}/reply`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${token}`,
              "content-type": "application/json; charset=utf-8",
            },
            body: JSON.stringify({
              ...feishuMessagePayload(args.message),
              ...(args.replyInThread ? { reply_in_thread: true } : {}),
              ...(args.idempotencyKey ? { uuid: args.idempotencyKey } : {}),
            }),
          },
        );
        return parseFeishuSentMessage(
          await readFeishuResponseJson(response, providerName),
          `${providerName} message reply failed`,
          providerName,
        );
      }
      const url = new URL(`${apiOrigin}/open-apis/im/v1/messages`);
      url.searchParams.set("receive_id_type", args.receiveIdType);
      const response = fetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({
          receive_id: args.receiveId,
          ...feishuMessagePayload(args.message),
          ...(args.idempotencyKey ? { uuid: args.idempotencyKey } : {}),
        }),
      });
      return parseFeishuSentMessage(
        await readFeishuResponseJson(response, providerName),
        `${providerName} message send failed`,
        providerName,
      );
    })();
  },
);
