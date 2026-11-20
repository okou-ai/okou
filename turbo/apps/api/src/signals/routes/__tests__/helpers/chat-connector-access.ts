import {
  connectorPermissionsContract,
  type ApplyConnectorPermissions,
} from "@okouai/api-contracts/contracts/connector-permissions";
import { connectorPermissionsRoutes } from "../../connector-permissions";
import {
  chatConnectorAccessContract,
  type ChatConnectorAccess,
} from "@okouai/api-contracts/contracts/chat-connector-access";
import type {
  ConnectorAccountSelection,
  ConnectorAccountTarget,
} from "@okouai/api-contracts/contracts/connector-accounts";
import { accept, type TestContext } from "../../../../__tests__/test-context";
import { setupApp } from "../../../../__tests__/test-helpers";
import { chatConnectorAccessRoutes } from "../../chat-connector-access";
import type { ApiTestUser } from "./api-bdd";
import { createRouteMocks } from "./route-test";

export function createChatConnectorAccessApi(context: TestContext) {
  const mocks = createRouteMocks(context);
  const client = setupApp({ context, routes: chatConnectorAccessRoutes })(
    chatConnectorAccessContract,
  );
  const headers = { authorization: "Bearer clerk-session" };

  const rules = setupApp({ context, routes: connectorPermissionsRoutes })(
    connectorPermissionsContract,
  );

  return {
    async readPermissions(actor: ApiTestUser, target: ConnectorAccountTarget) {
      mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
      return (await accept(rules.get({ headers, query: target }), [200])).body;
    },
    async applyPermissions(
      actor: ApiTestUser,
      body: ApplyConnectorPermissions,
    ) {
      mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
      return (await accept(rules.apply({ headers, body }), [200])).body;
    },
    async setDefault(
      actor: ApiTestUser,
      selection: ConnectorAccountSelection,
      enabled: boolean,
    ): Promise<void> {
      mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
      await accept(
        client.updateAccountDefault({
          headers,
          params: { connectionId: selection.connectionId },
          body: { target: selection.target, enabled },
        }),
        [200],
      );
    },
    async setThreadOverride(
      actor: ApiTestUser,
      threadId: string,
      selection: ConnectorAccountSelection,
      enabled: boolean | null,
    ): Promise<ChatConnectorAccess> {
      mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
      const result = await accept(
        client.setThreadOverride({
          headers,
          params: { threadId, connectionId: selection.connectionId },
          body: { target: selection.target, enabled },
        }),
        [200],
      );
      return result.body;
    },
  };
}
