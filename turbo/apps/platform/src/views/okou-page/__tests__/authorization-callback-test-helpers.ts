import { chatThreadMetadataContract } from "@okouai/api-contracts/contracts/chat-threads";
import type { testContext } from "../../../signals/__tests__/test-helpers.ts";

export function mockAuthorizationCallbackThread(
  context: ReturnType<typeof testContext>,
  threadId: string,
): void {
  context.mocks.api(chatThreadMetadataContract.get, ({ params, respond }) => {
    if (params.id !== threadId) {
      throw new Error("Unexpected authorization callback thread");
    }
    return respond(200, {
      id: threadId,
      agentId: "90000000-0000-4000-8000-000000000001",
      title: "Authorization callback",
      selectedModel: null,
      modelSettings: {},
      serviceTier: null,
      pinnedAt: null,
      archived: false,
      muted: false,
      computerUseHostId: null,
      cloudBrowserEnabled: false,
    });
  });
}
