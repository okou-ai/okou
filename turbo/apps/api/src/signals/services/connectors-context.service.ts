import { computed, type Computed } from "ccstate";
import type { AuthorizedConnectors } from "./authorized-connectors.service";
import type { RunPromptAndSkills, SkillVolume } from "./run-prompt-and-skills";

const MCP_CONNECTOR_PROMPT_INVENTORY_LIMIT = 20;

export function createConnectorsContext(
  authorizedConnectors$: Computed<Promise<AuthorizedConnectors>>,
): Computed<Promise<RunPromptAndSkills>> {
  return computed(async (get): Promise<RunPromptAndSkills> => {
    const connectors = await get(authorizedConnectors$);
    const customVolumes: SkillVolume[] = [];
    const builtinVolumes: SkillVolume[] = [];
    for (const connector of connectors) {
      if (connector.skill === null) {
        continue;
      }
      const volume = {
        name: connector.skill.storageName,
        version: connector.skill.versionId,
        skillName: connector.skill.skillName,
      };
      if (connector.kind === "custom") {
        customVolumes.push({ ...volume, source: "custom_connector_skill" });
      } else {
        builtinVolumes.push({
          ...volume,
          system: true,
          source: "connector_skill",
        });
      }
    }
    return {
      systemPromptVariables: { connectors: connectorPrompt(connectors) },
      userPromptVariables: {},
      skillVolumes: [...customVolumes, ...builtinVolumes],
    };
  });
}

function connectorPrompt(connectors: AuthorizedConnectors): string {
  const slugs = connectors
    .filter((connector) => {
      return connector.isMcp;
    })
    .map((connector) => {
      return connector.connectorSlug;
    })
    .sort();
  if (slugs.length === 0) {
    return "";
  }
  const inventory = slugs
    .slice(0, MCP_CONNECTOR_PROMPT_INVENTORY_LIMIT)
    .map((slug) => {
      return `- \`${slug}\``;
    });
  const omittedCount = slugs.length - inventory.length;
  if (omittedCount > 0) {
    inventory.push(
      `- ${omittedCount} additional authorized MCP connector${omittedCount === 1 ? " was" : "s were"} omitted from this prompt`,
    );
  }
  return [
    "# MCP Connectors",
    "",
    "The following MCP connectors are authorized for this Agent:",
    ...inventory,
    "",
    "Authorization does not guarantee that an account is connected or currently available.",
    "Use the Okou CLI to discover and invoke their tools:",
    "1. Run `okou mcp list --json` to check current connector metadata and availability.",
    "2. Before choosing a tool, run `okou mcp list-tools <connector-slug> --json`.",
    "3. Invoke the exact returned tool name with `okou mcp call <connector-slug> <tool-name> --input '<json>' --json`, providing JSON that matches its input schema.",
    "",
    "Runner enforcement is authoritative. If discovery or invocation reports that a connector is unavailable, do not bypass it. Connect or reauthorize the account as needed, then start a new Run.",
  ].join("\n");
}
