import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import {
  contentBundleSchema,
  type ContentBundle,
} from "@okouai/api-contracts/contracts/content-bundle";
import {
  customConnectorSlugSchema,
  type CustomConnectorSlug,
} from "@okouai/api-contracts/contracts/custom-connectors";
import {
  getCustomConnectorSkillName,
  getCustomConnectorSkillStorageName,
} from "@okouai/core/storage-names";
import { connectorCatalogEntries } from "@okouai/db/runtime/connector-catalog";
import { computed, type Computed } from "ccstate";
import { and, eq, inArray } from "drizzle-orm";
import { db$ } from "../external/db";
import {
  agentConnectorScopeFromRows,
  type AgentConnectorScopeSnapshot,
} from "./agent-connector-scope.service";
import {
  connectorScopeForRuntimeSnapshot,
  getConnectorRuntimeConnector,
  type ConnectorRuntimeSelection,
} from "./connector-catalog-runtime.service";
import type { AgentConnectorSelection } from "./execution-agent-connectors.service";

type AuthorizedConnectorSkill = { readonly skillName: string } & (
  | { readonly contentBundle: ContentBundle }
  | { readonly storageName: string; readonly versionId: string }
);

function requiredSkillBundle(
  row:
    | {
        readonly bundle: ContentBundle | null;
        readonly sourceVersionId: string | null;
      }
    | undefined,
  versionId: string,
): ContentBundle {
  if (!row?.bundle || row.sourceVersionId !== versionId) {
    throw new Error("Authorized connector Skill bundle is unavailable");
  }
  return contentBundleSchema.parse(row.bundle);
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
  bundleDelivery$: Computed<Promise<boolean>>,
): Computed<Promise<AuthorizedConnectors>> {
  return computed(async (get) => {
    const [selection, catalog, bundleDelivery] = await Promise.all([
      get(selection$),
      get(catalog$),
      get(bundleDelivery$),
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
    if (!bundleDelivery) {
      return authorizedConnectorsFromBundles({
        scope,
        catalog,
        bundleDelivery,
        builtinBundles: new Map(),
        customBundles: new Map(),
      });
    }
    const builtinSlugs = connectorScopeForRuntimeSnapshot(
      scope,
      catalog,
    ).allowedConnectorSlugs;
    const bundledSlugs = builtinSlugs.filter((slug) => {
      return (
        getConnectorRuntimeConnector(catalog, slug)?.skill.kind === "bundled"
      );
    });
    const db = get(db$);
    // Built-in generations are immutable. Custom references already belong to
    // the same authorized row snapshot as their selected source version.
    const builtinRows =
      bundledSlugs.length === 0
        ? []
        : await db
            .select({
              slug: connectorCatalogEntries.slug,
              bundle: connectorCatalogEntries.skillContentBundle,
              sourceVersionId:
                connectorCatalogEntries.skillContentBundleSourceVersionId,
            })
            .from(connectorCatalogEntries)
            .where(
              and(
                eq(
                  connectorCatalogEntries.hash,
                  catalog.catalogIdentity.catalogDigest,
                ),
                inArray(connectorCatalogEntries.slug, bundledSlugs),
              ),
            );
    const builtinBundles = new Map(
      builtinRows.map((row) => {
        return [row.slug, row];
      }),
    );
    const customBundles = new Map(
      selection.customConnectors.map((row) => {
        return [
          row.customConnectorId,
          {
            bundle: row.skillContentBundle,
            sourceVersionId: row.skillContentBundleSourceVersionId,
          },
        ];
      }),
    );
    return authorizedConnectorsFromBundles({
      scope,
      catalog,
      bundleDelivery,
      builtinBundles,
      customBundles,
    });
  });
}

function authorizedConnectorsFromBundles({
  scope,
  catalog,
  bundleDelivery,
  builtinBundles,
  customBundles,
}: {
  readonly scope: AgentConnectorScopeSnapshot;
  readonly catalog: ConnectorRuntimeSelection;
  readonly bundleDelivery: boolean;
  readonly builtinBundles: ReadonlyMap<
    string,
    {
      readonly bundle: ContentBundle | null;
      readonly sourceVersionId: string | null;
    }
  >;
  readonly customBundles: ReadonlyMap<
    string,
    {
      readonly bundle: ContentBundle | null;
      readonly sourceVersionId: string | null;
    }
  >;
}): AuthorizedConnectors {
  const authorized: AuthorizedConnector[] = connectorScopeForRuntimeSnapshot(
    scope,
    catalog,
  ).allowedConnectorSlugs.map((connectorSlug) => {
    const connector = getConnectorRuntimeConnector(catalog, connectorSlug);
    if (!connector) {
      throw new Error("Authorized connector is missing from captured catalog");
    }
    return {
      kind: "builtin",
      connectorSlug,
      isMcp: connector.catalogConnector.mcp !== undefined,
      skill:
        connector.skill.kind === "none"
          ? null
          : {
              ...(bundleDelivery
                ? {
                    contentBundle: requiredSkillBundle(
                      builtinBundles.get(connectorSlug),
                      connector.skill.versionId,
                    ),
                  }
                : {
                    storageName: connector.skill.storageName,
                    versionId: connector.skill.versionId,
                  }),
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
                ...(bundleDelivery
                  ? {
                      contentBundle: requiredSkillBundle(
                        customBundles.get(connector.customConnectorId),
                        connector.skillStorageVersionId,
                      ),
                    }
                  : {
                      storageName: getCustomConnectorSkillStorageName(
                        connector.customConnectorId,
                      ),
                      versionId: connector.skillStorageVersionId,
                    }),
                skillName: getCustomConnectorSkillName(
                  slug.data,
                  connector.customConnectorId,
                ),
              },
      });
    }
  }
  return authorized;
}
