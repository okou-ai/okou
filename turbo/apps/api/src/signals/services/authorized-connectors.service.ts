import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import {
  customConnectorSlugSchema,
  type CustomConnectorSlug,
} from "@okouai/api-contracts/contracts/custom-connectors";
import {
  getCustomConnectorSkillName,
  getCustomConnectorSkillStorageName,
} from "@okouai/core/storage-names";
import { computed, type Computed } from "ccstate";
import { agentConnectorScopeFromRows } from "./agent-connector-scope.service";
import {
  connectorScopeForRuntimeSnapshot,
  getConnectorRuntimeConnector,
  type ConnectorRuntimeSelection,
} from "./connector-catalog-runtime.service";
import type { AgentConnectorSelection } from "./execution-agent-connectors.service";

interface AuthorizedConnectorSkill {
  readonly storageName: string;
  readonly versionId: string;
  readonly skillName: string;
}

type AuthorizedConnector =
  | {
      readonly kind: "builtin";
      readonly connectorSlug: ConnectorSlug;
      readonly isMcp: boolean;
      readonly skill: AuthorizedConnectorSkill | null;
    }
  | {
      readonly kind: "custom";
      readonly customConnectorId: string;
      readonly connectorSlug: CustomConnectorSlug;
      readonly isMcp: boolean;
      readonly skill: AuthorizedConnectorSkill | null;
    };

export type AuthorizedConnectors = readonly AuthorizedConnector[];

/** Agent authorization and catalog capability, independent of connected accounts. */
export function createAuthorizedConnectors(
  selection$: Computed<
    Promise<
      Pick<
        AgentConnectorSelection,
        "builtinConnectorSlugs" | "customConnectors"
      >
    >
  >,
  catalog$: Computed<Promise<ConnectorRuntimeSelection | null>>,
): Computed<Promise<AuthorizedConnectors>> {
  return computed(async (get) => {
    const [selection, catalog] = await Promise.all([
      get(selection$),
      get(catalog$),
    ]);
    const scope = agentConnectorScopeFromRows({
      connectorRows: selection.builtinConnectorSlugs.map((connectorSlug) => {
        return { connectorSlug };
      }),
      customConnectorRows: selection.customConnectors,
    });
    if (
      scope.allowedConnectorSlugs.length === 0 &&
      scope.allowedCustomConnectorIds.length === 0
    ) {
      return [];
    }
    if (!catalog) {
      throw new Error("Scoped connector catalog is missing from bootstrap");
    }
    const authorized: AuthorizedConnector[] = connectorScopeForRuntimeSnapshot(
      scope,
      catalog,
    ).allowedConnectorSlugs.map((connectorSlug) => {
      const connector = getConnectorRuntimeConnector(catalog, connectorSlug);
      if (!connector) {
        throw new Error(
          "Authorized connector is missing from captured catalog",
        );
      }
      return {
        kind: "builtin",
        connectorSlug,
        isMcp: connector.catalogConnector.mcp !== undefined,
        skill:
          connector.skill.kind === "none"
            ? null
            : {
                storageName: connector.skill.storageName,
                versionId: connector.skill.versionId,
                skillName: connectorSlug,
              },
      };
    });
    for (const connector of scope.customConnectorDefinitions) {
      const slug = customConnectorSlugSchema.safeParse(connector.connectorSlug);
      if (slug.success) {
        authorized.push({
          kind: "custom",
          customConnectorId: connector.customConnectorId,
          connectorSlug: slug.data,
          isMcp: connector.isMcp,
          skill:
            connector.skillStorageVersionId === null
              ? null
              : {
                  storageName: getCustomConnectorSkillStorageName(
                    connector.customConnectorId,
                  ),
                  versionId: connector.skillStorageVersionId,
                  skillName: getCustomConnectorSkillName(
                    slug.data,
                    connector.customConnectorId,
                  ),
                },
        });
      }
    }
    return authorized;
  });
}
