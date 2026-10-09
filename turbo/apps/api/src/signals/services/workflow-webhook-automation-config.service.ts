import type { WebhookReceivedEventConfig } from "@okouai/api-contracts/contracts/workflows";
import { workflowWebhookAutomations } from "@okouai/db/schema/workflow";
import { command } from "ccstate";
import { eq } from "drizzle-orm";
import { createHash, randomBytes } from "node:crypto";
import { webUrl } from "../../lib/web-url";
import { db$ } from "../external/db";
import {
  decryptPersistentSecretValue,
  encryptPersistentSecretValue,
} from "./crypto.utils";
import type { AutomationRow } from "./workflow-automation-enqueue.service";

export type WebhookAutomationRow =
  typeof workflowWebhookAutomations.$inferSelect;

export function defaultWebhookReceivedEventConfig(): WebhookReceivedEventConfig {
  return {
    provider: "webhook",
    event: "received",
    auth: { mode: "hmac-sha256" },
  };
}

export function mintWorkflowWebhookToken(): string {
  return `whk_${randomBytes(32).toString("base64url")}`;
}

export function mintWorkflowWebhookSecret(): string {
  return randomBytes(32).toString("hex");
}

export function hashWorkflowWebhookToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function workflowWebhookUrlForToken(token: string): string {
  const baseUrl = webUrl();
  return `${baseUrl}/api/webhooks/workflow-automations/${encodeURIComponent(
    token,
  )}`;
}

export async function encryptWorkflowWebhookToken(
  token: string,
  args: { readonly orgId: string; readonly userId: string },
): Promise<string> {
  return await encryptPersistentSecretValue(token, {
    orgId: args.orgId,
    userId: args.userId,
  });
}

export async function encryptWorkflowWebhookSecret(
  secret: string,
  args: { readonly orgId: string; readonly userId: string },
): Promise<string> {
  return await encryptPersistentSecretValue(secret, {
    orgId: args.orgId,
    userId: args.userId,
  });
}

async function decryptWorkflowWebhookToken(
  encryptedToken: string,
  args: { readonly orgId: string; readonly userId: string },
): Promise<string> {
  return await decryptPersistentSecretValue(encryptedToken, {
    orgId: args.orgId,
    userId: args.userId,
  });
}

async function decryptWorkflowWebhookSecret(
  encryptedSecret: string,
  args: { readonly orgId: string; readonly userId: string },
): Promise<string> {
  return await decryptPersistentSecretValue(encryptedSecret, {
    orgId: args.orgId,
    userId: args.userId,
  });
}

export function workflowWebhookSummaryFields(
  webhook: WebhookAutomationRow,
  args: { readonly webhookToken?: string; readonly webhookSecret?: string },
) {
  return {
    ...(args.webhookToken
      ? {
          webhookUrl: workflowWebhookUrlForToken(args.webhookToken),
        }
      : {}),
    secretLastFour: webhook.secretLastFour,
    disabledReason: webhook.disabledReason,
    lastReceivedAt: webhook.lastReceivedAt
      ? webhook.lastReceivedAt.toISOString()
      : null,
    ...(args.webhookSecret ? { webhookSecret: args.webhookSecret } : {}),
  };
}

export const buildWorkflowWebhookSummaryFields$ = command(
  async (
    { get },
    args: { readonly automation: AutomationRow } & (
      | {
          readonly webhookToken: string;
          readonly webhookSecret: string;
        }
      | {
          readonly webhookToken?: undefined;
          readonly webhookSecret?: undefined;
        }
    ),
    signal: AbortSignal,
  ): Promise<{
    readonly webhookUrl?: string;
    readonly secretLastFour: string;
    readonly disabledReason: "paid_plan_required" | null;
    readonly lastReceivedAt: string | null;
    readonly webhookSecret?: string;
  }> => {
    const db = get(db$);
    const [webhook] = await db
      .select()
      .from(workflowWebhookAutomations)
      .where(eq(workflowWebhookAutomations.automationId, args.automation.id))
      .limit(1);
    signal.throwIfAborted();
    if (!webhook) {
      throw new Error(
        `Workflow webhook automation config missing: ${args.automation.id}`,
      );
    }

    return workflowWebhookSummaryFields(webhook, args);
  },
);

export const revealWorkflowWebhookSecretFields$ = command(
  async (
    { get },
    args: {
      readonly automation: AutomationRow;
    },
    signal: AbortSignal,
  ): Promise<{
    readonly webhookUrl: string;
    readonly webhookSecret: string;
  }> => {
    const db = get(db$);
    const [webhook] = await db
      .select()
      .from(workflowWebhookAutomations)
      .where(eq(workflowWebhookAutomations.automationId, args.automation.id))
      .limit(1);
    signal.throwIfAborted();
    if (!webhook) {
      throw new Error(
        `Workflow webhook automation config missing: ${args.automation.id}`,
      );
    }
    const context = {
      orgId: args.automation.orgId,
      userId: args.automation.ownerUserId,
    };
    const [token, secret] = await Promise.all([
      decryptWorkflowWebhookToken(webhook.encryptedToken, context),
      decryptWorkflowWebhookSecret(webhook.encryptedSecret, context),
    ]);
    signal.throwIfAborted();
    return {
      webhookUrl: workflowWebhookUrlForToken(token),
      webhookSecret: secret,
    };
  },
);
