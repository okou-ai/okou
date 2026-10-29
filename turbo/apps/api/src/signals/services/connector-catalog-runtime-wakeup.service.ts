import { agentRuns } from "@okouai/db/runtime/agent-run";
import { connectors } from "@okouai/db/schema/connector";
import { orgCustomConnectorOauthConfigs } from "@okouai/db/schema/org-custom-connector-oauth-config";
import { orgCustomConnectors } from "@okouai/db/schema/org-custom-connector";
import type { ConnectorCatalogArtifact } from "@okouai/connectors/connector-catalog/artifacts/artifacts";
import { command } from "ccstate";

import { logger } from "../../lib/log";
import { db$ } from "../external/db";
import { settle } from "../utils";
import type { ConnectorRuntimeSnapshot } from "./connector-catalog-runtime.service";
import { loadCustomConnectorPermissionBundle } from "./custom-connector-permission-bundle.service";
import {
  uniqueConnectorRuntimeTargets,
  connectorRuntimeWakeupCondition,
  publishConnectorRuntimeWakeupRows,
  reportConnectorRuntimeWakeupDiscoveryFailure,
  type ConnectorRuntimeWakeupBusinessArgs,
} from "./connector-runtime-wakeup.service";
import {
  builtinCatalogWakeupReadPlan,
  builtinCatalogWakeupAccountsByOrg,
} from "./connector-catalog-builtin-wakeup-plan";
import {
  customCatalogWakeupConnectorsByRef,
  customConnectorPermissionBundleFingerprint,
  customCatalogWakeupReadPlan,
  catalogWakeupRunColumns,
  customCatalogWakeup,
  builtinCatalogWakeup,
  customCatalogWakeupSummary,
} from "./connector-catalog-wakeup-plan";

const log = logger("connector-catalog:sync");

interface CatalogRuntimeWakeupArgs {
  readonly previousSnapshot: ConnectorRuntimeSnapshot | undefined;
  readonly currentArtifact: ConnectorCatalogArtifact;
}

function reportCatalogWakeupDiscoveryFailure(
  wakeup: ConnectorRuntimeWakeupBusinessArgs,
  error: unknown,
): void {
  reportConnectorRuntimeWakeupDiscoveryFailure({
    orgId: wakeup.scope.orgId,
    scopedToUser: wakeup.scope.userId !== undefined,
    scopedToAgent: wakeup.scope.agentId !== undefined,
    targetCount: uniqueConnectorRuntimeTargets(wakeup.targets).length,
    error,
  });
}

function reportCatalogWakeupFailures(
  results: readonly (
    { readonly ok: true } | { readonly ok: false; readonly error: unknown }
  )[],
): void {
  for (const result of results) {
    if (!result.ok) {
      log.warn("Failed to publish connector catalog runtime wakeups", {
        error: result.error,
      });
    }
  }
}

const publishCatalogWakeup$ = command(
  async (
    { get },
    wakeup: ConnectorRuntimeWakeupBusinessArgs,
  ): Promise<void> => {
    const result = await settle(
      (async () => {
        const targets = uniqueConnectorRuntimeTargets(wakeup.targets);
        if (targets.length === 0) {
          return;
        }
        const db = get(db$);
        const rows = await db
          .select(catalogWakeupRunColumns())
          .from(agentRuns)
          .where(connectorRuntimeWakeupCondition(wakeup.scope));
        await publishConnectorRuntimeWakeupRows({
          scope: wakeup.scope,
          targets,
          rows,
        });
      })(),
    );
    if (!result.ok) {
      reportCatalogWakeupDiscoveryFailure(wakeup, result.error);
    }
  },
);

const publishCustomCatalogRuntimeWakeups$ = command(
  async ({ get, set }, args: CatalogRuntimeWakeupArgs): Promise<void> => {
    const readPlan = customCatalogWakeupReadPlan(args.currentArtifact);
    const currentCatalog = readPlan.catalog;
    const db = get(db$);
    const rows = await db
      .select(readPlan.columns)
      .from(orgCustomConnectors)
      .leftJoin(orgCustomConnectorOauthConfigs, readPlan.oauthCondition)
      .where(readPlan.condition);

    const connectorIdsByRef = customCatalogWakeupConnectorsByRef(rows);
    const affectedByOrg = new Map<string, string[]>();
    for (const [ref, connectors] of connectorIdsByRef) {
      const [previousBundle, currentBundle] = await Promise.all([
        args.previousSnapshot
          ? loadCustomConnectorPermissionBundle({
              catalog: args.previousSnapshot.serverFirewallMetadata,
              ref,
            })
          : null,
        loadCustomConnectorPermissionBundle({
          catalog: currentCatalog,
          ref,
        }),
      ]);
      if (
        customConnectorPermissionBundleFingerprint(previousBundle) ===
        customConnectorPermissionBundleFingerprint(currentBundle)
      ) {
        continue;
      }
      for (const connector of connectors) {
        const connectorIds = affectedByOrg.get(connector.orgId) ?? [];
        connectorIds.push(connector.connectorId);
        affectedByOrg.set(connector.orgId, connectorIds);
      }
    }

    const publications = [];
    for (const [orgId, customConnectorIds] of affectedByOrg) {
      publications.push(
        (async () => {
          const wakeup = customCatalogWakeup(orgId, customConnectorIds);
          await set(publishCatalogWakeup$, wakeup);
        })(),
      );
    }
    await Promise.all(publications);
    log.debug(
      "Evaluated Custom connector catalog wakeups",
      customCatalogWakeupSummary(connectorIdsByRef.size, affectedByOrg),
    );
  },
);

const publishBuiltinCatalogRuntimeWakeups$ = command(
  async ({ get, set }, args: CatalogRuntimeWakeupArgs): Promise<void> => {
    const plan = builtinCatalogWakeupReadPlan({
      previousArtifact: args.previousSnapshot?.acceptedSnapshot.artifact,
      currentArtifact: args.currentArtifact,
    });
    if (!plan.needsRead) {
      return;
    }
    const db = get(db$);
    const accounts = await db
      .selectDistinct(plan.columns)
      .from(connectors)
      .where(plan.condition);
    const byOrg = builtinCatalogWakeupAccountsByOrg(accounts);
    const pending = byOrg.entries();
    async function publishOrgWakeups() {
      for (const [orgId, slugs] of pending) {
        const wakeup = builtinCatalogWakeup(orgId, slugs);
        await set(publishCatalogWakeup$, wakeup);
      }
    }
    const workerCount = Math.min(4, byOrg.size);
    const workers = [];
    for (let index = 0; index < workerCount; index++) {
      workers.push(publishOrgWakeups());
    }
    await Promise.all(workers);
  },
);

// Finish notification attempts for the committed switch before the sync caller
// observes cancellation, matching the original post-publication operation.
export const publishCatalogRuntimeWakeups$ = command(
  async ({ set }, args: CatalogRuntimeWakeupArgs): Promise<void> => {
    const results = await Promise.all([
      settle(set(publishCustomCatalogRuntimeWakeups$, args)),
      settle(set(publishBuiltinCatalogRuntimeWakeups$, args)),
    ]);
    reportCatalogWakeupFailures(results);
  },
);
