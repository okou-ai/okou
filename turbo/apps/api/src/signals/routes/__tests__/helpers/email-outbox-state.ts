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
