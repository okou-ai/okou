import { optionalEnv } from "../../lib/env";
import {
  connectorCatalogExecutableCapabilityState as buildConnectorCatalogExecutableCapabilityState,
  evaluateConnectorCatalogCompatibility,
  type ExecutableCapabilityState,
} from "@okouai/connectors/connector-catalog/compatibility";

// Compatibility is evaluated on demand from captured entries and the current
// executable capability. Nothing about it is persisted.
export { evaluateConnectorCatalogCompatibility };
export type { ExecutableCapabilityState };

export function connectorCatalogExecutableCapabilityState(): ExecutableCapabilityState {
  return buildConnectorCatalogExecutableCapabilityState({
    isConfigured: (name) => {
      return optionalEnv(name) !== undefined;
    },
  });
}

export function connectorCatalogExecutableCapabilityDigest(): string {
  return connectorCatalogExecutableCapabilityState().digest;
}
