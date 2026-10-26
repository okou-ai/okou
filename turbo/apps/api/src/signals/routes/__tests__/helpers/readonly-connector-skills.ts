import { randomUUID } from "node:crypto";
import { getCustomConnectorSkillStorageName } from "@okouai/core/storage-names";
import { onTestFinished } from "vitest";
import type { TestContext } from "../../../../__tests__/test-context";
import type { ApiTestUser } from "./api-bdd";
import { createConnectorBddApi } from "./api-bdd-connectors";

/** Ordinary read-only Storage fixtures, owned and published by Connectors. */
export async function readonlyConnectorSkills(
  context: TestContext,
  actor: ApiTestUser,
  agentId: string,
  labels: readonly string[],
) {
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
    const archiveKeys = context.mocks.s3.send.mock.calls
      .slice(start)
      .flatMap(([command]) => {
        const candidate = command as {
          readonly constructor?: { readonly name?: string };
          readonly input?: { readonly Key?: string };
        };
        return candidate.constructor?.name === "PutObjectCommand" &&
          candidate.input?.Key?.endsWith("/archive.tar.gz")
          ? [candidate.input.Key]
          : [];
      });
    const archiveKey = archiveKeys[0];
    const versionId = archiveKey
      ? /\/([a-f0-9]{64})\/archive\.tar\.gz$/u.exec(archiveKey)?.[1]
      : undefined;
    if (archiveKeys.length !== 1 || !archiveKey || !versionId) {
      throw new Error("Expected one published Connector skill archive");
    }
    mounts.push({
      name: getCustomConnectorSkillStorageName(connector.id),
      mountPath: `/home/user/.claude/skills/custom-${connector.slug.slice(1, 49)}-${connector.id.replaceAll("-", "").slice(0, 8)}`,
      versionId,
      archiveKey,
    });
  }
  await connectors.updateAgentCustomConnectors(actor, agentId, ids);
  return mounts;
}
