import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import {
  contentBundleSchema,
  type ContentBundle,
} from "@okouai/api-contracts/contracts/content-bundle";
import {
  customConnectorSlugSchema,
  type CustomConnectorSlug,
} from "@okouai/api-contracts/contracts/custom-connectors";
import { getCustomConnectorSkillName } from "@okouai/core/storage-names";
import { connectorCatalogEntries } from "@okouai/db/runtime/connector-catalog";
import { computed, type Computed } from "ccstate";
import { and, eq, inArray } from "drizzle-orm";
import { logger } from "../../lib/log";
import { db$ } from "../external/db";
import {
  connectorScopeForRuntimeSnapshot,
  getConnectorRuntimeConnector,
  type ConnectorExecutionRuntimeSelection,
} from "./connector-catalog-runtime.service";
import type { ExecutionConnectorSelection } from "./execution-connector-selection";

interface AuthorizedConnectorSkill {
  readonly skillName: string;
  readonly contentBundle: ContentBundle;
}

const log = logger("api:authorized-connector-skills");

function availableSkillBundle(
  connectorId: string,
  skillName: string,
  row:
    | {
        readonly bundle: ContentBundle | null;
        readonly sourceVersionId: string | null;
      }
    | undefined,
  versionId: string,
): AuthorizedConnectorSkill | null {
  if (!row?.bundle || row.sourceVersionId !== versionId) {
    log.warn("Connector Skill bundle is unavailable", { connectorId });
    return null;
  }
  const bundle = contentBundleSchema.safeParse(row.bundle);
  if (!bundle.success) {
    log.warn("Connector Skill bundle is invalid", { connectorId });
    return null;
  }
  return { skillName, contentBundle: bundle.data };
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

/** Build authorized connector skill bundles from member selection and catalog metadata. */
export function createAuthorizedConnectors(
  selection$: Computed<Promise<ExecutionConnectorSelection>>,
  catalog$: Computed<Promise<ConnectorExecutionRuntimeSelection | null>>,
): Computed<Promise<AuthorizedConnectors>> {
  return computed(async (get) => {
    const [{ scope, customConnectors }, catalog] = await Promise.all([
      get(selection$),
      get(catalog$),
    ]);
    if (
      scope.allowedConnectorSlugs.length === 0 &&
      scope.allowedCustomConnectorIds.length === 0
    ) {
      return [];
    }
    if (!catalog) {
      throw new Error("Scoped connector catalog is missing from bootstrap");
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
    return authorizedConnectorsFromBundles({
      builtinSlugs,
      customConnectors,
      catalog,
      builtinBundles,
    });
  });
}

function authorizedConnectorsFromBundles({
  builtinSlugs,
  customConnectors,
  catalog,
  builtinBundles,
}: {
  readonly builtinSlugs: readonly ConnectorSlug[];
  readonly customConnectors: ExecutionConnectorSelection["customConnectors"];
  readonly catalog: ConnectorExecutionRuntimeSelection;
  readonly builtinBundles: ReadonlyMap<
    string,
    {
      readonly bundle: ContentBundle | null;
      readonly sourceVersionId: string | null;
    }
  >;
}): AuthorizedConnectors {
  const authorized: AuthorizedConnector[] = builtinSlugs.map(
    (connectorSlug) => {
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
            : availableSkillBundle(
                connectorSlug,
                connectorSlug,
                builtinBundles.get(connectorSlug),
                connector.skill.versionId,
              ),
      };
    },
  );
  for (const connector of customConnectors) {
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
            : availableSkillBundle(
                connector.customConnectorId,
                getCustomConnectorSkillName(
                  slug.data,
                  connector.customConnectorId,
                ),
                {
                  bundle: connector.skillContentBundle,
                  sourceVersionId: connector.skillContentBundleSourceVersionId,
                },
                connector.skillStorageVersionId,
              ),
      });
    }
  }
  return authorized;
}
