import {
  testEmailOutboxStateContract,
  type TestEmailOutboxStateActionBody,
  type TestEmailOutboxStateActionResponse,
  type TestEmailOutboxStateItem,
  type TestOfficialAutomationResultEmailClaim,
} from "@okouai/api-contracts/contracts/test-email-outbox-state";

import { setupAppWithRoutes } from "../../../../__tests__/test-app";
import { accept, type TestContext } from "../../../../__tests__/test-context";
import { testEmailOutboxStateRoutes } from "../../test-email-outbox-state";

interface SeedEmailOutboxItemOptions {
  readonly template?: "data-export-ready" | "morning-brief-result";
  readonly toAddress: string;
  readonly subject: string;
  readonly status: "pending" | "failed";
  readonly createdAt: Date;
}

interface FindEmailOutboxItemsOptions {
  readonly toAddress: string;
  readonly subject: string;
}

interface FindEmailOutboxSourceItemsOptions {
  readonly sourceRunId: string;
  readonly sourceWorkflowAutomationId: string;
}

interface EmailOutboxSourceState {
  readonly items: readonly TestEmailOutboxStateItem[];
  readonly claim: TestOfficialAutomationResultEmailClaim | null;
}

function stateClient(context: TestContext) {
  return setupAppWithRoutes({
    context,
    routes: testEmailOutboxStateRoutes,
  })(testEmailOutboxStateContract);
}

async function postAction(
  context: TestContext,
  body: TestEmailOutboxStateActionBody,
): Promise<TestEmailOutboxStateActionResponse> {
  const response = await accept(stateClient(context).action({ body }), [200]);
  return response.body;
}

export function createEmailOutboxStateApi(context: TestContext) {
  async function findItems(
    options: FindEmailOutboxItemsOptions,
  ): Promise<readonly TestEmailOutboxStateItem[]> {
    const response = await postAction(context, {
      action: "find-item",
      to_address: options.toAddress,
      subject: options.subject,
    });
    if (response.action !== "find-item") {
      throw new Error("Expected the email outbox find response");
    }
    return response.items;
  }

  return {
    async seedItem(
      options: SeedEmailOutboxItemOptions,
    ): Promise<TestEmailOutboxStateItem> {
      const response = await postAction(context, {
        action: "seed-item",
        ...(options.template ? { template: options.template } : {}),
        to_address: options.toAddress,
        subject: options.subject,
        status: options.status,
        created_at: options.createdAt.toISOString(),
      });
      if (response.action !== "seed-item") {
        throw new Error("Expected the email outbox seed response");
      }
      return response.item;
    },

    findItems,

    async seedLinkedNativeMail(options: {
      readonly orgId: string;
      readonly userId: string;
      readonly membershipId: string;
      readonly activeAuthority?: boolean;
      readonly toAddress: string;
      readonly createdAt: Date;
    }): Promise<TestEmailOutboxStateItem & { readonly agentId: string }> {
      const response = await postAction(context, {
        action: "seed-native-mail",
        org_id: options.orgId,
        user_id: options.userId,
        membership_id: options.membershipId,
        ...(options.activeAuthority === undefined
          ? {}
          : { active_authority: options.activeAuthority }),
        to_address: options.toAddress,
        created_at: options.createdAt.toISOString(),
      });
      if (response.action !== "seed-native-mail") {
        throw new Error("Expected the linked Native email seed response");
      }
      return { ...response.item, agentId: response.agent_id };
    },

    async cleanupNativeOwner(orgId: string, userId: string): Promise<void> {
      const response = await postAction(context, {
        action: "cleanup-native-owner",
        org_id: orgId,
        user_id: userId,
      });
      if (response.action !== "cleanup-native-owner" || !response.cleaned) {
        throw new Error("Expected the Native owner fixture cleanup response");
      }
    },

    async nativeReceiptExists(itemId: string): Promise<boolean> {
      const response = await postAction(context, {
        action: "read-native-receipt",
        item_id: itemId,
      });
      if (response.action !== "read-native-receipt") {
        throw new Error("Expected the Native email receipt response");
      }
      return response.exists;
    },

    async deleteLinkedNativeMail(itemId: string): Promise<boolean> {
      const response = await postAction(context, {
        action: "delete-native-mail",
        item_id: itemId,
      });
      if (response.action !== "delete-native-mail") {
        throw new Error("Expected the Native email cleanup response");
      }
      return response.deleted;
    },

    async findSourceState(
      options: FindEmailOutboxSourceItemsOptions,
    ): Promise<EmailOutboxSourceState> {
      const response = await postAction(context, {
        action: "find-source",
        source_run_id: options.sourceRunId,
        source_workflow_automation_id: options.sourceWorkflowAutomationId,
      });
      if (response.action !== "find-source") {
        throw new Error("Expected the email outbox source response");
      }
      return { items: response.items, claim: response.claim };
    },

    async findItem(
      options: FindEmailOutboxItemsOptions,
    ): Promise<TestEmailOutboxStateItem> {
      const items = await findItems(options);
      if (items.length !== 1) {
        throw new Error(
          `Expected one email outbox item, found ${items.length}`,
        );
      }
      const item = items[0];
      if (!item) {
        throw new Error("Expected the uniquely matched email outbox item");
      }
      return item;
    },

    async readItem(itemId: string): Promise<TestEmailOutboxStateItem | null> {
      const response = await postAction(context, {
        action: "read-items",
        item_ids: [itemId],
      });
      if (response.action !== "read-items") {
        throw new Error("Expected the email outbox read response");
      }
      return response.items[0] ?? null;
    },

    async deleteItems(itemIds: readonly string[]): Promise<number> {
      const response = await postAction(context, {
        action: "delete-items",
        item_ids: [...itemIds],
      });
      if (response.action !== "delete-items") {
        throw new Error("Expected the email outbox delete response");
      }
      return response.deleted;
    },

    async drainItems(itemIds: readonly string[]): Promise<number> {
      const response = await accept(
        stateClient(context).drain({ body: { item_ids: [...itemIds] } }),
        [200],
      );
      return response.body.drained;
    },

    async cleanupExpiredItems(itemIds: readonly string[]): Promise<number> {
      const response = await accept(
        stateClient(context).cleanup({ body: { item_ids: [...itemIds] } }),
        [200],
      );
      return response.body.cleaned;
    },
  };
}
