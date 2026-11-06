import { randomUUID } from "node:crypto";
import { onTestFinished } from "vitest";
import type { TestContext } from "../../../../__tests__/test-context";
import type { ApiTestUser } from "./api-bdd";
import { createConnectorBddApi } from "./api-bdd-connectors";
import { readPublishedArchive } from "./published-archive";
import { installWorkflowVolumeS3Fixture } from "./workflow-volume-s3";
import { enableConnectorSkillBundles } from "./enable-connector-skill-bundles";

/** Read-only bundles published through the ordinary Connector API. */
export async function readonlyConnectorSkills(
  context: TestContext,
  actor: ApiTestUser,
  agentId: string,
  labels: readonly string[],
) {
  await enableConnectorSkillBundles(context, actor);
  installWorkflowVolumeS3Fixture(context, new Map(), { bundlesOnly: true });
  const connectors = createConnectorBddApi(context);
  const ids: string[] = [];
  const mounts = [];
  for (const label of labels) {
    const start = context.mocks.s3.send.mock.calls.length;
    const connector = await connectors.createCustomConnector(actor, {
      displayName: `${label} ${randomUUID().slice(0, 8)}`,
      prefixTemplates: [`https://readonly-${randomUUID()}.example.test/api/`],
      fields: [
        { key: "secret", label: "Token", kind: "secret", required: true },
      ],
      headerInjections: [
        { name: "Authorization", valueTemplate: "Bearer {{secrets.secret}}" },
      ],
      queryInjections: [],
      authMode: "manual",
      skillMarkdown: `Use the ${label} connector.`,
    });
    ids.push(connector.id);
    onTestFinished(async () => {
      await connectors.deleteCustomConnector(actor, connector.id);
    });
    mounts.push({
      ...readPublishedArchive(context, start),
      mountPath: `/home/user/.claude/skills/custom-${connector.slug.slice(1, 49)}-${connector.id.replaceAll("-", "").slice(0, 8)}`,
    });
  }
  await connectors.updateAgentCustomConnectors(actor, agentId, ids);
  return mounts;
}
