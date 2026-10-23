import {
  connectorCatalog,
  connectorCatalogEntries,
} from "@okouai/db/runtime/connector-catalog";
import { connectors } from "@okouai/db/schema/connector";
import { orgCustomConnectors } from "@okouai/db/schema/org-custom-connector";
import { orgCustomConnectorOauthConfigs } from "@okouai/db/schema/org-custom-connector-oauth-config";
import { userCustomConnectors } from "@okouai/db/schema/user-custom-connector";
import { userFeatureSwitches } from "@okouai/db/schema/user-feature-switches";
import { and, eq, inArray, ne, exists, sql } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import * as z from "zod";
import {
  nullableDriverValueDecoder,
  pgBooleanDecoder,
  pgIntegerDecoder,
  pgTextDecoder,
  zodEnumDriverValueDecoder,
} from "../../lib/db-structured-result";
import { connectorCatalogCurrentWhere } from "./connector-catalog-slug-source.service";
import { customConnectorDefinitionSelection } from "./custom-connector-definition-selection";
import { customConnectorRuntimeStorageReadPlan } from "./custom-connector-credential-access.service";
import { userFeatureSwitchRowCondition } from "./feature-switch-scope";
import { FEISHU_CUSTOM_CONNECTOR_PERMISSION_BUNDLE_REF } from "./feishu-custom-connector-permissions";

const sectionDecoder = zodEnumDriverValueDecoder(
  z.enum([
    "definition",
    "catalog",
    "account",
    "storage",
    "value",
    "feature",
    "grant",
  ]),
);
const authModeDecoder = zodEnumDriverValueDecoder(
  z.enum(["none", "manual", "oauth", "automatic"]),
);
const transportDecoder = zodEnumDriverValueDecoder(z.enum(["streamable-http"]));
const automaticAuthTypeDecoder = zodEnumDriverValueDecoder(
  z.enum(["none", "oauth"]),
);
const providerAdapterDecoder = zodEnumDriverValueDecoder(
  z.enum(["standard", "feishu"]),
);
const tokenAuthMethodDecoder = zodEnumDriverValueDecoder(
  z.enum(["client_secret_basic", "client_secret_post"]),
);
const pkceDecoder = zodEnumDriverValueDecoder(z.enum(["none", "S256"]));
const storageKindDecoder = zodEnumDriverValueDecoder(
  z.enum(["secret", "variable"]),
);

// Independent sections share a typed transport, never a collection cross product.
// NULL slots are native SQL values; timestamp, int8, arrays and JSONB retain
// their column representations and the first UNION branch owns every decoder.
const emptySections = Object.freeze({
  definition_id: sql`NULL::uuid`
    .mapWith(nullableDriverValueDecoder(pgTextDecoder))
    .as("definition_id"),
  definition_orgId: sql`NULL::text`
    .mapWith(nullableDriverValueDecoder(pgTextDecoder))
    .as("definition_orgId"),
  definition_slug: sql`NULL::text`
    .mapWith(nullableDriverValueDecoder(pgTextDecoder))
    .as("definition_slug"),
  definition_displayName: sql`NULL::text`
    .mapWith(nullableDriverValueDecoder(pgTextDecoder))
    .as("definition_displayName"),
  definition_prefixTemplates: sql`NULL::jsonb`
    .mapWith(nullableDriverValueDecoder(orgCustomConnectors.prefixTemplates))
    .as("definition_prefixTemplates"),
  definition_fields: sql`NULL::jsonb`
    .mapWith(nullableDriverValueDecoder(orgCustomConnectors.fields))
    .as("definition_fields"),
  definition_headerInjections: sql`NULL::jsonb`
    .mapWith(nullableDriverValueDecoder(orgCustomConnectors.headerInjections))
    .as("definition_headerInjections"),
  definition_queryInjections: sql`NULL::jsonb`
    .mapWith(nullableDriverValueDecoder(orgCustomConnectors.queryInjections))
    .as("definition_queryInjections"),
  definition_authMode: sql`NULL::text`
    .mapWith(nullableDriverValueDecoder(authModeDecoder))
    .as("definition_authMode"),
  definition_enabled: sql`NULL::boolean`
    .mapWith(nullableDriverValueDecoder(pgBooleanDecoder))
    .as("definition_enabled"),
  definition_permissionBundleRef: sql`NULL::text`
    .mapWith(nullableDriverValueDecoder(pgTextDecoder))
    .as("definition_permissionBundleRef"),
  definition_mcpEndpoint: sql`NULL::text`
    .mapWith(nullableDriverValueDecoder(pgTextDecoder))
    .as("definition_mcpEndpoint"),
  definition_mcpTransport: sql`NULL::text`
    .mapWith(nullableDriverValueDecoder(transportDecoder))
    .as("definition_mcpTransport"),
  definition_skillMarkdown: sql`NULL::text`
    .mapWith(nullableDriverValueDecoder(pgTextDecoder))
    .as("definition_skillMarkdown"),
  definition_skillStorageVersionId: sql`NULL::text`
    .mapWith(nullableDriverValueDecoder(pgTextDecoder))
    .as("definition_skillStorageVersionId"),
  definition_storageVersion: sql`NULL::bigint`
    .mapWith(nullableDriverValueDecoder(orgCustomConnectors.storageVersion))
    .as("definition_storageVersion"),
  definition_createdBy: sql`NULL::text`
    .mapWith(nullableDriverValueDecoder(pgTextDecoder))
    .as("definition_createdBy"),
  definition_createdAt: sql`NULL::timestamp`
    .mapWith(nullableDriverValueDecoder(orgCustomConnectors.createdAt))
    .as("definition_createdAt"),
  definition_updatedAt: sql`NULL::timestamp`
    .mapWith(nullableDriverValueDecoder(orgCustomConnectors.updatedAt))
    .as("definition_updatedAt"),
  oauth_connectorId: sql`NULL::uuid`
    .mapWith(nullableDriverValueDecoder(pgTextDecoder))
    .as("oauth_connectorId"),
  oauth_orgId: sql`NULL::text`
    .mapWith(nullableDriverValueDecoder(pgTextDecoder))
    .as("oauth_orgId"),
  oauth_providerAdapter: sql`NULL::text`
    .mapWith(nullableDriverValueDecoder(providerAdapterDecoder))
    .as("oauth_providerAdapter"),
  oauth_clientId: sql`NULL::text`
    .mapWith(nullableDriverValueDecoder(pgTextDecoder))
    .as("oauth_clientId"),
  oauth_encryptedClientSecret: sql`NULL::text`
    .mapWith(nullableDriverValueDecoder(pgTextDecoder))
    .as("oauth_encryptedClientSecret"),
  oauth_authorizationUrl: sql`NULL::text`
    .mapWith(nullableDriverValueDecoder(pgTextDecoder))
    .as("oauth_authorizationUrl"),
  oauth_tokenUrl: sql`NULL::text`
    .mapWith(nullableDriverValueDecoder(pgTextDecoder))
    .as("oauth_tokenUrl"),
  oauth_tokenEndpointAuthMethod: sql`NULL::text`
    .mapWith(nullableDriverValueDecoder(tokenAuthMethodDecoder))
    .as("oauth_tokenEndpointAuthMethod"),
  oauth_pkceMethod: sql`NULL::text`
    .mapWith(nullableDriverValueDecoder(pkceDecoder))
    .as("oauth_pkceMethod"),
  oauth_scopes: sql`NULL::text[]`
    .mapWith(nullableDriverValueDecoder(orgCustomConnectorOauthConfigs.scopes))
    .as("oauth_scopes"),
  oauth_authorizationParams: sql`NULL::jsonb`
    .mapWith(
      nullableDriverValueDecoder(
        orgCustomConnectorOauthConfigs.authorizationParams,
      ),
    )
    .as("oauth_authorizationParams"),
  oauth_createdAt: sql`NULL::timestamp`
    .mapWith(
      nullableDriverValueDecoder(orgCustomConnectorOauthConfigs.createdAt),
    )
    .as("oauth_createdAt"),
  oauth_updatedAt: sql`NULL::timestamp`
    .mapWith(
      nullableDriverValueDecoder(orgCustomConnectorOauthConfigs.updatedAt),
    )
    .as("oauth_updatedAt"),
  catalog_schemaVersion: sql`NULL::integer`
    .mapWith(nullableDriverValueDecoder(pgIntegerDecoder))
    .as("catalog_schemaVersion"),
  catalog_hash: sql`NULL::text`
    .mapWith(nullableDriverValueDecoder(pgTextDecoder))
    .as("catalog_hash"),
  catalog_slug: sql`NULL::text`
    .mapWith(nullableDriverValueDecoder(pgTextDecoder))
    .as("catalog_slug"),
  catalog_authMethods: sql`NULL::jsonb`
    .mapWith(nullableDriverValueDecoder(connectorCatalogEntries.authMethods))
    .as("catalog_authMethods"),
  catalog_mcp: sql`NULL::jsonb`
    .mapWith(nullableDriverValueDecoder(connectorCatalogEntries.mcp))
    .as("catalog_mcp"),
  catalog_label: sql`NULL::text`
    .mapWith(nullableDriverValueDecoder(pgTextDecoder))
    .as("catalog_label"),
  catalog_description: sql`NULL::text`
    .mapWith(nullableDriverValueDecoder(pgTextDecoder))
    .as("catalog_description"),
  catalog_category: sql`NULL::text`
    .mapWith(nullableDriverValueDecoder(pgTextDecoder))
    .as("catalog_category"),
  catalog_icon: sql`NULL::jsonb`
    .mapWith(nullableDriverValueDecoder(connectorCatalogEntries.icon))
    .as("catalog_icon"),
  catalog_tags: sql`NULL::text[]`
    .mapWith(nullableDriverValueDecoder(connectorCatalogEntries.tags))
    .as("catalog_tags"),
  catalog_generation: sql`NULL::text[]`
    .mapWith(nullableDriverValueDecoder(connectorCatalogEntries.generation))
    .as("catalog_generation"),
  catalog_skill: sql`NULL::jsonb`
    .mapWith(nullableDriverValueDecoder(connectorCatalogEntries.skill))
    .as("catalog_skill"),
  catalog_firewall: sql`NULL::jsonb`
    .mapWith(nullableDriverValueDecoder(connectorCatalogEntries.firewall))
    .as("catalog_firewall"),
  account_authMethod: sql`NULL::text`
    .mapWith(nullableDriverValueDecoder(pgTextDecoder))
    .as("account_authMethod"),
  account_automaticAuthType: sql`NULL::text`
    .mapWith(nullableDriverValueDecoder(automaticAuthTypeDecoder))
    .as("account_automaticAuthType"),
  account_connectorId: sql`NULL::uuid`
    .mapWith(nullableDriverValueDecoder(pgTextDecoder))
    .as("account_connectorId"),
  account_connectorSlug: sql`NULL::text`
    .mapWith(nullableDriverValueDecoder(pgTextDecoder))
    .as("account_connectorSlug"),
  account_customConnectorId: sql`NULL::uuid`
    .mapWith(nullableDriverValueDecoder(pgTextDecoder))
    .as("account_customConnectorId"),
  account_storageVersion: sql`NULL::bigint`
    .mapWith(nullableDriverValueDecoder(connectors.storageVersion))
    .as("account_storageVersion"),
  storage_id: sql`NULL::uuid`
    .mapWith(nullableDriverValueDecoder(pgTextDecoder))
    .as("storage_id"),
  storage_updatedAt: sql`NULL::timestamp`
    .mapWith(nullableDriverValueDecoder(connectors.updatedAt))
    .as("storage_updatedAt"),
  storage_customConnectorId: sql`NULL::uuid`
    .mapWith(nullableDriverValueDecoder(pgTextDecoder))
    .as("storage_customConnectorId"),
  storage_storedAuthMethod: sql`NULL::text`
    .mapWith(nullableDriverValueDecoder(pgTextDecoder))
    .as("storage_storedAuthMethod"),
  storage_storedStorageVersion: sql`NULL::bigint`
    .mapWith(nullableDriverValueDecoder(connectors.storageVersion))
    .as("storage_storedStorageVersion"),
  storage_storedNeedsReconnect: sql`NULL::boolean`
    .mapWith(nullableDriverValueDecoder(pgBooleanDecoder))
    .as("storage_storedNeedsReconnect"),
  storage_tokenExpiresAt: sql`NULL::timestamp`
    .mapWith(nullableDriverValueDecoder(connectors.tokenExpiresAt))
    .as("storage_tokenExpiresAt"),
  storage_definitionAuthMethod: sql`NULL::text`
    .mapWith(nullableDriverValueDecoder(authModeDecoder))
    .as("storage_definitionAuthMethod"),
  storage_definitionMcpTransport: sql`NULL::text`
    .mapWith(nullableDriverValueDecoder(transportDecoder))
    .as("storage_definitionMcpTransport"),
  storage_definitionStorageVersion: sql`NULL::bigint`
    .mapWith(nullableDriverValueDecoder(orgCustomConnectors.storageVersion))
    .as("storage_definitionStorageVersion"),
  storage_oauthAccessTokenId: sql`NULL::uuid`
    .mapWith(nullableDriverValueDecoder(pgTextDecoder))
    .as("storage_oauthAccessTokenId"),
  storage_oauthRefreshTokenId: sql`NULL::uuid`
    .mapWith(nullableDriverValueDecoder(pgTextDecoder))
    .as("storage_oauthRefreshTokenId"),
  storage_automaticOAuthBindingId: sql`NULL::uuid`
    .mapWith(nullableDriverValueDecoder(pgTextDecoder))
    .as("storage_automaticOAuthBindingId"),
  storage_kind: sql`NULL::text`
    .mapWith(nullableDriverValueDecoder(storageKindDecoder))
    .as("storage_kind"),
  storage_key: sql`NULL::text`
    .mapWith(nullableDriverValueDecoder(pgTextDecoder))
    .as("storage_key"),
  storage_storedValue: sql`NULL::text`
    .mapWith(nullableDriverValueDecoder(pgTextDecoder))
    .as("storage_storedValue"),
  feature_userId: sql`NULL::text`
    .mapWith(nullableDriverValueDecoder(pgTextDecoder))
    .as("feature_userId"),
  feature_switches: sql`NULL::jsonb`
    .mapWith(nullableDriverValueDecoder(userFeatureSwitches.switches))
    .as("feature_switches"),
  grant_customConnectorId: sql`NULL::uuid`
    .mapWith(nullableDriverValueDecoder(pgTextDecoder))
    .as("grant_customConnectorId"),
  grant_permissionNames: sql`NULL::text[]`
    .mapWith(nullableDriverValueDecoder(userCustomConnectors.permissionNames))
    .as("grant_permissionNames"),
});

interface CustomRuntimeSnapshotInput {
  readonly scope: {
    readonly orgId: string;
    readonly userId: string;
    readonly agentId: string;
  };
  readonly registrations: readonly {
    readonly customConnectorId: string;
    readonly sourceId?: string;
  }[];
}

function customRuntimeSnapshotTargets(
  registrations: CustomRuntimeSnapshotInput["registrations"],
) {
  const customConnectorIds = [
    ...new Set(
      registrations.map((registration) => {
        return registration.customConnectorId;
      }),
    ),
  ];
  // Collect raw identities without running request normalization before catalog
  // materialization. Wrong-target identities must still be captured below.
  const sources = registrations.flatMap((registration) => {
    return registration.sourceId === undefined
      ? []
      : [
          {
            customConnectorId: registration.customConnectorId,
            sourceId: registration.sourceId,
          },
        ];
  });
  const sourceIds = [
    ...new Set(
      sources.map((source) => {
        return source.sourceId;
      }),
    ),
  ];
  return { customConnectorIds, sources, sourceIds };
}

function customRuntimeSnapshotReadPlan(args: CustomRuntimeSnapshotInput) {
  const queryBuilder = new QueryBuilder();
  const { customConnectorIds, sources, sourceIds } =
    customRuntimeSnapshotTargets(args.registrations);
  const definitions = queryBuilder.$with("custom_runtime_definitions").as(
    queryBuilder
      .select(customConnectorDefinitionSelection())
      .from(orgCustomConnectors)
      .where(
        and(
          eq(orgCustomConnectors.orgId, args.scope.orgId),
          eq(orgCustomConnectors.enabled, true),
          inArray(orgCustomConnectors.id, customConnectorIds),
        ),
      ),
  );
  const dependencySlug = sql`substring(${definitions.permissionBundleRef} from '^builtin:([^@]+)@1$')`;
  const requestedSources = queryBuilder
    .$with("custom_runtime_requested_sources")
    .as(
      queryBuilder
        .select({
          sourceId: sql`source_id`.mapWith(connectors.id).as("source_id"),
          customConnectorId: sql`custom_connector_id`
            .mapWith(orgCustomConnectors.id)
            .as("custom_connector_id"),
        })
        .from(
          sql`unnest(${sql.param(
            sources.map((source) => {
              return source.sourceId;
            }),
          )}::uuid[], ${sql.param(
            sources.map((source) => {
              return source.customConnectorId;
            }),
          )}::uuid[]) as requested_sources(source_id, custom_connector_id)`,
        ),
    );
  const dependencies = queryBuilder.$with("custom_runtime_metadata_slugs").as(
    queryBuilder
      .selectDistinct({
        slug: dependencySlug
          .mapWith(nullableDriverValueDecoder(pgTextDecoder))
          .as("dependency_slug"),
      })
      .from(definitions)
      .where(
        and(
          ne(
            definitions.permissionBundleRef,
            FEISHU_CUSTOM_CONNECTOR_PERMISSION_BUNDLE_REF,
          ),
          sql`${dependencySlug} COLLATE "C" ~ '^[a-z0-9][a-z0-9-]{0,63}$'`,
        ),
      ),
  );
  const sourceCondition = and(
    inArray(
      orgCustomConnectors.id,
      queryBuilder.select({ id: definitions.id }).from(definitions),
    ),
    exists(
      queryBuilder
        .select({ sourceId: requestedSources.sourceId })
        .from(requestedSources)
        .where(
          and(
            eq(requestedSources.sourceId, connectors.id),
            eq(requestedSources.customConnectorId, orgCustomConnectors.id),
          ),
        ),
    ),
  );
  const storagePlan = customConnectorRuntimeStorageReadPlan({
    orgId: args.scope.orgId,
    userId: args.scope.userId,
    connectorIds: customConnectorIds,
    memberConnectorIds: sourceIds,
    sourceCondition,
  });
  const storage = storagePlan.storedConnections;
  const storedValues = storagePlan.storedValues;
  return {
    definitions,
    requestedSources,
    dependencies,
    storage,
    storedValues,
    customConnectorIds,
    sourceIds,
  };
}

type CustomRuntimeReadPlan = ReturnType<typeof customRuntimeSnapshotReadPlan>;

function customRuntimeDefinitionRows(
  definitions: CustomRuntimeReadPlan["definitions"],
) {
  return new QueryBuilder()
    .select({
      section: sql`'definition'`.mapWith(sectionDecoder).as("section"),
      ...emptySections,
      definition_id: definitions.id,
      definition_orgId: definitions.orgId,
      definition_slug: definitions.slug,
      definition_displayName: definitions.displayName,
      definition_prefixTemplates: definitions.prefixTemplates,
      definition_fields: definitions.fields,
      definition_headerInjections: definitions.headerInjections,
      definition_queryInjections: definitions.queryInjections,
      definition_authMode: definitions.authMode,
      definition_enabled: definitions.enabled,
      definition_permissionBundleRef: definitions.permissionBundleRef,
      definition_mcpEndpoint: definitions.mcpEndpoint,
      definition_mcpTransport: definitions.mcpTransport,
      definition_skillMarkdown: definitions.skillMarkdown,
      definition_skillStorageVersionId: definitions.skillStorageVersionId,
      definition_storageVersion: definitions.storageVersion,
      definition_createdBy: definitions.createdBy,
      definition_createdAt: definitions.createdAt,
      definition_updatedAt: definitions.updatedAt,
      oauth_connectorId: orgCustomConnectorOauthConfigs.connectorId,
      oauth_orgId: orgCustomConnectorOauthConfigs.orgId,
      oauth_providerAdapter: orgCustomConnectorOauthConfigs.providerAdapter,
      oauth_clientId: orgCustomConnectorOauthConfigs.clientId,
      oauth_encryptedClientSecret:
        orgCustomConnectorOauthConfigs.encryptedClientSecret,
      oauth_authorizationUrl: orgCustomConnectorOauthConfigs.authorizationUrl,
      oauth_tokenUrl: orgCustomConnectorOauthConfigs.tokenUrl,
      oauth_tokenEndpointAuthMethod:
        orgCustomConnectorOauthConfigs.tokenEndpointAuthMethod,
      oauth_pkceMethod: orgCustomConnectorOauthConfigs.pkceMethod,
      oauth_scopes: orgCustomConnectorOauthConfigs.scopes,
      oauth_authorizationParams:
        orgCustomConnectorOauthConfigs.authorizationParams,
      oauth_createdAt: orgCustomConnectorOauthConfigs.createdAt,
      oauth_updatedAt: orgCustomConnectorOauthConfigs.updatedAt,
    })
    .from(definitions)
    .leftJoin(
      orgCustomConnectorOauthConfigs,
      and(
        eq(orgCustomConnectorOauthConfigs.connectorId, definitions.id),
        eq(orgCustomConnectorOauthConfigs.orgId, definitions.orgId),
      ),
    );
}

function customRuntimeCatalogRows(
  dependencies: CustomRuntimeReadPlan["dependencies"],
) {
  return new QueryBuilder()
    .select({
      section: sql`'catalog'`.mapWith(sectionDecoder).as("section"),
      ...emptySections,
      catalog_schemaVersion: connectorCatalog.schemaVersion,
      catalog_hash: connectorCatalog.hash,
      catalog_slug: connectorCatalogEntries.slug,
      catalog_authMethods: connectorCatalogEntries.authMethods,
      catalog_mcp: connectorCatalogEntries.mcp,
      catalog_label: connectorCatalogEntries.label,
      catalog_description: connectorCatalogEntries.description,
      catalog_category: connectorCatalogEntries.category,
      catalog_icon: connectorCatalogEntries.icon,
      catalog_tags: connectorCatalogEntries.tags,
      catalog_generation: connectorCatalogEntries.generation,
      catalog_skill: connectorCatalogEntries.skill,
      catalog_firewall: connectorCatalogEntries.firewall,
    })
    .from(connectorCatalog)
    .leftJoin(
      connectorCatalogEntries,
      and(
        eq(connectorCatalogEntries.hash, connectorCatalog.hash),
        inArray(
          connectorCatalogEntries.slug,
          new QueryBuilder()
            .select({ slug: dependencies.slug })
            .from(dependencies),
        ),
      ),
    )
    .where(connectorCatalogCurrentWhere());
}

function customRuntimeAccountRows(
  scope: CustomRuntimeSnapshotInput["scope"],
  sourceIds: readonly string[],
) {
  return new QueryBuilder()
    .select({
      section: sql`'account'`.mapWith(sectionDecoder).as("section"),
      ...emptySections,
      account_authMethod: connectors.authMethod,
      account_automaticAuthType: connectors.automaticAuthType,
      account_connectorId: connectors.id,
      account_connectorSlug: connectors.connectorSlug,
      account_customConnectorId: connectors.customConnectorId,
      account_storageVersion: connectors.storageVersion,
    })
    .from(connectors)
    .where(
      and(
        eq(connectors.orgId, scope.orgId),
        eq(connectors.userId, scope.userId),
        inArray(connectors.id, sourceIds),
      ),
    );
}

function customRuntimeStorageRows(storage: CustomRuntimeReadPlan["storage"]) {
  return new QueryBuilder()
    .select({
      section: sql`'storage'`.mapWith(sectionDecoder).as("section"),
      ...emptySections,
      storage_id: storage.id,
      storage_updatedAt: storage.updatedAt,
      storage_customConnectorId: storage.customConnectorId,
      storage_storedAuthMethod: storage.storedAuthMethod,
      storage_storedStorageVersion: storage.storedStorageVersion,
      storage_storedNeedsReconnect: storage.storedNeedsReconnect,
      storage_tokenExpiresAt: storage.tokenExpiresAt,
      storage_definitionAuthMethod: storage.definitionAuthMethod,
      storage_definitionMcpTransport: storage.definitionMcpTransport,
      storage_definitionStorageVersion: storage.definitionStorageVersion,
      storage_oauthAccessTokenId: storage.oauthAccessTokenId,
      storage_oauthRefreshTokenId: storage.oauthRefreshTokenId,
      storage_automaticOAuthBindingId: storage.automaticOAuthBindingId,
    })
    .from(storage);
}

function customRuntimeValueRows(
  storedValues: CustomRuntimeReadPlan["storedValues"],
) {
  return new QueryBuilder()
    .select({
      section: sql`'value'`.mapWith(sectionDecoder).as("section"),
      ...emptySections,
      storage_id: storedValues.memberConnectorId,
      storage_kind: storedValues.kind,
      storage_key: storedValues.key,
      storage_storedValue: storedValues.storedValue,
    })
    .from(storedValues);
}

function customRuntimeFeatureRows(scope: CustomRuntimeSnapshotInput["scope"]) {
  return new QueryBuilder()
    .select({
      section: sql`'feature'`.mapWith(sectionDecoder).as("section"),
      ...emptySections,
      feature_userId: userFeatureSwitches.userId,
      feature_switches: userFeatureSwitches.switches,
    })
    .from(userFeatureSwitches)
    .where(userFeatureSwitchRowCondition(scope.orgId, scope.userId));
}

function customRuntimeGrantRows(
  scope: CustomRuntimeSnapshotInput["scope"],
  customConnectorIds: readonly string[],
) {
  return new QueryBuilder()
    .select({
      section: sql`'grant'`.mapWith(sectionDecoder).as("section"),
      ...emptySections,
      grant_customConnectorId: userCustomConnectors.customConnectorId,
      grant_permissionNames: userCustomConnectors.permissionNames,
    })
    .from(userCustomConnectors)
    .where(
      and(
        eq(userCustomConnectors.orgId, scope.orgId),
        eq(userCustomConnectors.userId, scope.userId),
        eq(userCustomConnectors.agentId, scope.agentId),
        inArray(userCustomConnectors.customConnectorId, customConnectorIds),
      ),
    );
}

export function customRuntimeSnapshotReadQuery(
  args: CustomRuntimeSnapshotInput,
) {
  const queryBuilder = new QueryBuilder();
  const {
    definitions,
    requestedSources,
    dependencies,
    storage,
    storedValues,
    sourceIds,
    customConnectorIds,
  } = customRuntimeSnapshotReadPlan(args);
  const emptyRows = queryBuilder
    .select({
      section: sql`'definition'`.mapWith(sectionDecoder).as("section"),
      ...emptySections,
    })
    .from(definitions)
    .where(sql`false`);
  const sections = queryBuilder
    .$with("custom_runtime_sections")
    .as(
      emptyRows
        .unionAll(customRuntimeDefinitionRows(definitions))
        .unionAll(customRuntimeCatalogRows(dependencies))
        .unionAll(customRuntimeAccountRows(args.scope, sourceIds))
        .unionAll(customRuntimeStorageRows(storage))
        .unionAll(customRuntimeValueRows(storedValues))
        .unionAll(customRuntimeFeatureRows(args.scope))
        .unionAll(customRuntimeGrantRows(args.scope, customConnectorIds)),
    );
  return queryBuilder
    .with(
      definitions,
      requestedSources,
      dependencies,
      storage,
      storedValues,
      sections,
    )
    .select()
    .from(sections);
}

// SQL slot decoding is separate from ordered business materialization. Required
// slots cannot silently become absent entities. JSONB business validation stays
// with the original definition/catalog materializers at their original phase.
function requiredSlot<T>(value: T | null): T {
  if (value === null) {
    throw new Error("Missing required custom runtime snapshot slot");
  }
  return value;
}

type SnapshotRow = ReturnType<
  typeof customRuntimeSnapshotReadQuery
>["_"]["result"][number];

function customRuntimeDefinitionFromRow(row: SnapshotRow) {
  return {
    connector: {
      id: requiredSlot(row.definition_id),
      orgId: requiredSlot(row.definition_orgId),
      slug: requiredSlot(row.definition_slug),
      displayName: requiredSlot(row.definition_displayName),
      prefixTemplates: requiredSlot(row.definition_prefixTemplates),
      fields: requiredSlot(row.definition_fields),
      headerInjections: requiredSlot(row.definition_headerInjections),
      queryInjections: requiredSlot(row.definition_queryInjections),
      authMode: requiredSlot(row.definition_authMode),
      enabled: requiredSlot(row.definition_enabled),
      permissionBundleRef: row.definition_permissionBundleRef,
      mcpEndpoint: row.definition_mcpEndpoint,
      mcpTransport: row.definition_mcpTransport,
      skillMarkdown: row.definition_skillMarkdown,
      skillStorageVersionId: row.definition_skillStorageVersionId,
      storageVersion: requiredSlot(row.definition_storageVersion),
      createdBy: requiredSlot(row.definition_createdBy),
      createdAt: requiredSlot(row.definition_createdAt),
      updatedAt: requiredSlot(row.definition_updatedAt),
    },
    oauthConfig:
      row.oauth_connectorId === null
        ? null
        : {
            connectorId: requiredSlot(row.oauth_connectorId),
            orgId: requiredSlot(row.oauth_orgId),
            providerAdapter: requiredSlot(row.oauth_providerAdapter),
            clientId: requiredSlot(row.oauth_clientId),
            encryptedClientSecret: requiredSlot(
              row.oauth_encryptedClientSecret,
            ),
            authorizationUrl: requiredSlot(row.oauth_authorizationUrl),
            tokenUrl: requiredSlot(row.oauth_tokenUrl),
            tokenEndpointAuthMethod: requiredSlot(
              row.oauth_tokenEndpointAuthMethod,
            ),
            pkceMethod: requiredSlot(row.oauth_pkceMethod),
            scopes: requiredSlot(row.oauth_scopes),
            authorizationParams: requiredSlot(row.oauth_authorizationParams),
            createdAt: requiredSlot(row.oauth_createdAt),
            updatedAt: requiredSlot(row.oauth_updatedAt),
          },
  };
}

function customRuntimeCatalogFromRow(row: SnapshotRow) {
  return {
    current: {
      schemaVersion: requiredSlot(row.catalog_schemaVersion),
      hash: requiredSlot(row.catalog_hash),
    },
    entry:
      row.catalog_slug === null
        ? null
        : {
            slug: requiredSlot(row.catalog_slug),
            authMethods: requiredSlot(row.catalog_authMethods),
            mcp: row.catalog_mcp,
            label: requiredSlot(row.catalog_label),
            description: requiredSlot(row.catalog_description),
            category: requiredSlot(row.catalog_category),
            icon: requiredSlot(row.catalog_icon),
            tags: requiredSlot(row.catalog_tags),
            generation: requiredSlot(row.catalog_generation),
            skill: requiredSlot(row.catalog_skill),
            firewall: requiredSlot(row.catalog_firewall),
          },
  };
}

function customRuntimeAccountFromRow(row: SnapshotRow) {
  return {
    authMethod: requiredSlot(row.account_authMethod),
    automaticAuthType: row.account_automaticAuthType,
    connectorId: requiredSlot(row.account_connectorId),
    connectorSlug: row.account_connectorSlug,
    customConnectorId: row.account_customConnectorId,
    storageVersion: requiredSlot(row.account_storageVersion),
  };
}

function customRuntimeStorageFromRow(row: SnapshotRow) {
  return {
    id: requiredSlot(row.storage_id),
    updatedAt: requiredSlot(row.storage_updatedAt),
    customConnectorId: requiredSlot(row.storage_customConnectorId),
    storedAuthMethod: requiredSlot(row.storage_storedAuthMethod),
    storedStorageVersion: requiredSlot(row.storage_storedStorageVersion),
    storedNeedsReconnect: requiredSlot(row.storage_storedNeedsReconnect),
    tokenExpiresAt: row.storage_tokenExpiresAt,
    definitionAuthMethod: requiredSlot(row.storage_definitionAuthMethod),
    definitionMcpTransport: row.storage_definitionMcpTransport,
    definitionStorageVersion: requiredSlot(
      row.storage_definitionStorageVersion,
    ),
    oauthAccessTokenId: row.storage_oauthAccessTokenId,
    oauthRefreshTokenId: row.storage_oauthRefreshTokenId,
    automaticOAuthBindingId: row.storage_automaticOAuthBindingId,
    kind: row.storage_kind,
    key: row.storage_key,
    storedValue: row.storage_storedValue,
  };
}

export function customRuntimeSnapshotSectionsFromRows(
  rows: readonly SnapshotRow[],
) {
  const definitionRows = rows.flatMap((row) => {
    return row.section === "definition"
      ? [customRuntimeDefinitionFromRow(row)]
      : [];
  });
  const catalogRows = rows.flatMap((row) => {
    return row.section === "catalog" ? [customRuntimeCatalogFromRow(row)] : [];
  });
  const accountRows = rows.flatMap((row) => {
    return row.section === "account" ? [customRuntimeAccountFromRow(row)] : [];
  });
  const storageRows = rows.flatMap((row) => {
    return row.section === "storage" ? [customRuntimeStorageFromRow(row)] : [];
  });
  const valuesByAccountId = new Map<
    string,
    { kind: "secret" | "variable"; key: string; storedValue: string }[]
  >();
  const connectionIds = new Set(
    storageRows.map((row) => {
      return row.id;
    }),
  );
  for (const row of rows) {
    if (row.section !== "value") {
      continue;
    }
    const id = requiredSlot(row.storage_id);
    if (!connectionIds.has(id)) {
      throw new Error("Unknown captured custom runtime credential account");
    }
    const values = valuesByAccountId.get(id) ?? [];
    values.push({
      kind: requiredSlot(row.storage_kind),
      key: requiredSlot(row.storage_key),
      storedValue: requiredSlot(row.storage_storedValue),
    });
    valuesByAccountId.set(id, values);
  }
  const runtimeStorageRows = storageRows.flatMap((connection) => {
    const values = valuesByAccountId.get(connection.id);
    return values === undefined
      ? [connection]
      : values.map((value) => {
          return { ...connection, ...value };
        });
  });
  const featureRows = rows.flatMap((row) => {
    if (row.section !== "feature") {
      return [];
    }
    return [
      {
        userId: requiredSlot(row.feature_userId),
        switches: requiredSlot(row.feature_switches),
      },
    ];
  });
  const grantRows = rows.flatMap((row) => {
    if (row.section !== "grant") {
      return [];
    }
    return [
      {
        customConnectorId: requiredSlot(row.grant_customConnectorId),
        permissionNames: requiredSlot(row.grant_permissionNames),
      },
    ];
  });
  return {
    definitionRows,
    catalogRows,
    accountRows,
    storageRows: runtimeStorageRows,
    featureRows,
    grantRows,
  };
}
