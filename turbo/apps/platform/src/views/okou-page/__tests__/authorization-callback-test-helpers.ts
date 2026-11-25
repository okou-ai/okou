import { chatThreadMetadataContract } from "@okouai/api-contracts/contracts/chat-threads";
import type { testContext } from "../../../signals/__tests__/test-helpers.ts";

export function mockAuthorizationCallbackThread(
  context: ReturnType<typeof testContext>,
  threadId: string,
  accessible = () => {
    return true;
  },
): void {
  context.mocks.api(chatThreadMetadataContract.get, ({ params, respond }) => {
    if (params.id !== threadId) {
      throw new Error("Unexpected authorization callback thread");
    }
    if (!accessible()) {
      return respond(404, {
        error: { code: "NOT_FOUND", message: "Chat unavailable" },
      });
    }
    return respond(200, {
      id: threadId,
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
