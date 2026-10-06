import type { CustomConnectorDefinitionVersion } from "./agent-connector-scope.service";
import type { PiStableContextPromptInputs } from "@okouai/db/jsonb-contracts/pi-stable-context";

export function customConnectorDefinitionHasStableSkill(
  definition: CustomConnectorDefinitionVersion,
  promptInputs: PiStableContextPromptInputs,
): definition is CustomConnectorDefinitionVersion & {
  readonly skillStorageVersionId: string;
} {
  return Boolean(
    definition.skillStorageVersionId &&
    (!definition.isMcp || promptInputs.customConnectorMcpEnabled),
  );
}
