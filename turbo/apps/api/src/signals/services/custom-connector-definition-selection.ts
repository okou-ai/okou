import { orgCustomConnectors } from "@okouai/db/schema/org-custom-connector";
import { customConnectorNetworkBindingSelection } from "./custom-connector-network-binding";
import type { infer as zInfer } from "zod";
import type { customConnectorNetworkMetadataSchema } from "@okouai/api-contracts/validators/custom-connector-network";
import type {
  CustomConnectorHttpRow,
  CustomConnectorMcpRow,
  CustomConnectorOAuthConfigRow,
} from "./custom-connector.service";

export type CustomConnectorExecutionOAuthConfig = Omit<
  CustomConnectorOAuthConfigRow,
  "connectorId" | "orgId" | "createdAt" | "updatedAt"
>;

type ExecutionDefinitionFields =
  "enabled" | "createdBy" | "createdAt" | "updatedAt" | "oauthConfig";

/** Execution configuration excludes definition audit data and stored user tokens. */
export type CustomConnectorExecutionDefinition =
  | (Omit<CustomConnectorHttpRow, ExecutionDefinitionFields> & {
      readonly oauthConfig: CustomConnectorExecutionOAuthConfig | null;
    })
  | (Omit<
      CustomConnectorMcpRow,
      ExecutionDefinitionFields | "permissionBundleRef"
    > & { readonly oauthConfig: CustomConnectorExecutionOAuthConfig | null });

export function customConnectorDefinitionSelection() {
  return {
    networkBinding: customConnectorNetworkBindingSelection().as(
      "connector_network_binding",
    ),
    id: orgCustomConnectors.id,
    orgId: orgCustomConnectors.orgId,
    slug: orgCustomConnectors.slug,
    displayName: orgCustomConnectors.displayName,
    prefixTemplates: orgCustomConnectors.prefixTemplates,
    fields: orgCustomConnectors.fields,
    headerInjections: orgCustomConnectors.headerInjections,
    queryInjections: orgCustomConnectors.queryInjections,
    authMode: orgCustomConnectors.authMode,
    enabled: orgCustomConnectors.enabled,
    permissionBundleRef: orgCustomConnectors.permissionBundleRef,
    mcpEndpoint: orgCustomConnectors.mcpEndpoint,
    mcpTransport: orgCustomConnectors.mcpTransport,
    skillMarkdown: orgCustomConnectors.skillMarkdown,
    skillStorageVersionId: orgCustomConnectors.skillStorageVersionId,
    storageVersion: orgCustomConnectors.storageVersion,
    createdBy: orgCustomConnectors.createdBy,
    createdAt: orgCustomConnectors.createdAt,
    updatedAt: orgCustomConnectors.updatedAt,
  } as const;
}

export type CustomConnectorDefinitionRow = Pick<
  typeof orgCustomConnectors.$inferSelect,
  Exclude<
    keyof ReturnType<typeof customConnectorDefinitionSelection>,
    "networkBinding"
  >
> & {
  readonly networkBinding?: zInfer<
    typeof customConnectorNetworkMetadataSchema
  > | null;
};
