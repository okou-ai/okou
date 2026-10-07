import {
  testEmailOutboxStateContract,
  type TestEmailOutboxStateActionBody,
  type TestEmailOutboxStateActionResponse,
  type TestEmailOutboxStateItem,
} from "@okouai/api-contracts/contracts/test-email-outbox-state";

import { setupAppWithRoutes } from "../../../../__tests__/test-app";
import { accept, type TestContext } from "../../../../__tests__/test-context";
import { testEmailOutboxStateRoutes } from "../../test-email-outbox-state";

interface FindEmailOutboxItemsOptions {
  readonly toAddress: string;
  readonly subject: string;
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
    findItems,

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
  };
}
