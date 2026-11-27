import { findFastControl } from "./chat-message-experience-test-helpers.ts";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import type { TestContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  createComposerConnectorHelpers,
  chatConnectorOverviewFixture,
  connectorAccount,
  httpConnector,
  SCOUT_THREAD_ID,
} from "./chat-composer-connectors-test-helpers.ts";

export function namedMenuAccounts(
  context: TestContext,
  prefix: string,
  size: number,
) {
  const customConnectors = Array.from({ length: size }, (_, i) => {
    return httpConnector({
      id: `aa000000-0000-4000-a000-${String(i + 1).padStart(12, "0")}`,
      slug: `fixture-${i}`,
      displayName: `${prefix} ${i}`,
      hasAccount: true,
    });
  });
  const accounts = customConnectors.map((c) => {
    return connectorAccount({
      id: `f${c.id.slice(1)}`,
      displayName: `${c.displayName} account`,
      isDefault: true,
      target: { kind: "custom", customConnectorId: c.id },
    });
  });
  createComposerConnectorHelpers(context).installComposerConnectorFixture({
    customConnectors,
    accounts,
    threadId: SCOUT_THREAD_ID,
  });
  return customConnectors.map((c) => {
    return chatConnectorOverviewFixture({
      target: { kind: "custom", customConnectorId: c.id },
      label: c.displayName,
      accounts,
    });
  });
}
export async function openChatMenu(context: TestContext) {
  await setupPage({
    context,
    path: `/chats/${SCOUT_THREAD_ID}`,
    host: "app.okou.ai",
  });
  const trigger = await findFastControl("button", "Connectors");
  click(trigger);
  await findFastControl("button", "Add connectors");
  return trigger;
}
