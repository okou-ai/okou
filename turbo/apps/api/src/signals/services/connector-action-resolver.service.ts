import { computed, type Computed } from "ccstate";
import type {
  ConnectorAuthMethodId,
  ConnectorSlug,
} from "@okouai/api-contracts/contracts/connector-identity";
import type {
  PublicConnectorCatalogAuthMethodDetail,
  PublicConnectorCatalogDetail,
} from "@okouai/api-contracts/contracts/connector-catalog";
import type { ConnectorAuthMethodRuntimeConfig } from "@okouai/connectors/connector-config";

import { logger } from "../../lib/log";
import { db$ } from "../external/db";
import {
  getConnectorRuntimeConnector,
  getConnectorRuntimeMethod,
  loadConnectorRuntimeSnapshot,
  type ConnectorRuntimeConnector,
  type ConnectorRuntimeMethod,
  type ConnectorRuntimeSnapshot,
} from "./connector-catalog-runtime.service";

const log = logger("api:connector-action-resolver");

type ConnectorCatalogGrantKind =
  PublicConnectorCatalogAuthMethodDetail["grantKind"];

type ConnectorSlugResolutionFailure =
  | { readonly ok: false; readonly reason: "unknown_connector" }
  | {
      readonly ok: false;
      readonly reason: "missing_executable_capability";
    };

export type ConnectorActionResolutionFailure =
  | ConnectorSlugResolutionFailure
  | {
      readonly ok: false;
      readonly reason: "unknown_auth_method";
      readonly catalogConnector: PublicConnectorCatalogDetail;
    }
  | {
      readonly ok: false;
      readonly reason: "wrong_grant_kind";
      readonly actualGrantKind: ConnectorCatalogGrantKind;
      readonly catalogConnector: PublicConnectorCatalogDetail;
    }
  | { readonly ok: false; readonly reason: "hidden_auth_method" };

export type ResolvedConnectorSlug = {
  readonly ok: true;
  readonly connectorSlug: ConnectorSlug;
  readonly catalogConnector: PublicConnectorCatalogDetail;
  readonly runtimeConnector: ConnectorRuntimeConnector;
  readonly snapshot: ConnectorRuntimeSnapshot;
};

export type ResolvedConnectorActionMethod = ResolvedConnectorSlug & {
  readonly authMethodId: ConnectorAuthMethodId;
  readonly catalogMethod: PublicConnectorCatalogAuthMethodDetail;
  readonly method: ConnectorAuthMethodRuntimeConfig;
  readonly runtimeMethod: ConnectorRuntimeMethod;
};

export type ConnectorSlugResolution =
  | ResolvedConnectorSlug
  | ConnectorSlugResolutionFailure;

export type ConnectorActionMethodResolution =
  | ResolvedConnectorActionMethod
  | ConnectorActionResolutionFailure;

export type ConnectorSlugsResolution =
  | {
      readonly ok: true;
      readonly connectors: readonly ResolvedConnectorSlug[];
    }
  | (ConnectorSlugResolutionFailure & {
      readonly connectorSlug: ConnectorSlug;
    });

/**
 * Resolves connector execution contracts, never connector discovery policy.
 *
 * Feature switches only filter UI/discovery projections. They are not
 * authorization or compatibility boundaries and are never read here. Authored
 * method visibility is separate: it controls new actions through
 * resolveNewActionMethod, while resolveMethod deliberately lets in-flight and
 * persisted credentials continue. Execution fails closed when the connector or
 * method is absent, has the wrong grant kind, is incompatible, or lacks its
 * local executable capability.
 */
export interface ConnectorActionResolver {
  readonly resolveSlug: (args: {
    readonly connectorSlug: ConnectorSlug;
    readonly requireExecutable: boolean;
  }) => ConnectorSlugResolution;
  readonly resolveMethod: (args: {
    readonly connectorSlug: ConnectorSlug;
    readonly authMethodId: ConnectorAuthMethodId;
    readonly expectedGrantKind: ConnectorCatalogGrantKind;
  }) => ConnectorActionMethodResolution;
  readonly resolveNewActionMethod: (args: {
    readonly connectorSlug: ConnectorSlug;
    readonly authMethodId: ConnectorAuthMethodId;
    readonly expectedGrantKind: ConnectorCatalogGrantKind;
  }) => ConnectorActionMethodResolution;
  readonly resolveSlugs: (args: {
    readonly connectorSlugs: readonly ConnectorSlug[];
    readonly requireExecutable: boolean;
  }) => ConnectorSlugsResolution;
}

function resolvedSlug(args: {
  readonly connectorSlug: ConnectorSlug;
  readonly requireExecutable: boolean;
  readonly runtimeConnector: ConnectorRuntimeConnector;
  readonly snapshot: ConnectorRuntimeSnapshot;
}): ResolvedConnectorSlug | ConnectorSlugResolutionFailure {
  if (
    args.requireExecutable &&
    ![...args.runtimeConnector.methods.values()].some((method) => {
      return method.executable;
    })
  ) {
    log.warn("Connector runtime capability is unavailable", {
      connectorSlug: args.connectorSlug,
      reason: "missing_executable_capability",
    });
    return { ok: false, reason: "missing_executable_capability" };
  }
  return {
    ok: true,
    connectorSlug: args.connectorSlug,
    catalogConnector: args.runtimeConnector.catalogConnector,
    runtimeConnector: args.runtimeConnector,
    snapshot: args.snapshot,
  };
}

function executableMethod(args: {
  readonly resolvedSlug: ResolvedConnectorSlug;
  readonly authMethodId: ConnectorAuthMethodId;
  readonly catalogMethod: PublicConnectorCatalogAuthMethodDetail;
}): ResolvedConnectorActionMethod | ConnectorActionResolutionFailure {
  const runtimeMethod = getConnectorRuntimeMethod({
    snapshot: args.resolvedSlug.snapshot,
    connectorSlug: args.resolvedSlug.connectorSlug,
    authMethodId: args.authMethodId,
    requireExecutable: true,
  });
  if (
    runtimeMethod === undefined ||
    runtimeMethod.method.grant.kind !== args.catalogMethod.grantKind
  ) {
    log.warn("Connector auth method runtime capability is unavailable", {
      connectorSlug: args.resolvedSlug.connectorSlug,
      authMethodId: args.authMethodId,
      reason: "missing_executable_capability",
    });
    return { ok: false, reason: "missing_executable_capability" };
  }
  return {
    ...args.resolvedSlug,
    authMethodId: args.authMethodId,
    catalogMethod: args.catalogMethod,
    method: runtimeMethod.method,
    runtimeMethod,
  };
}

function createConnectorActionResolver(
  snapshot: ConnectorRuntimeSnapshot,
): ConnectorActionResolver {
  const resolveSlug: ConnectorActionResolver["resolveSlug"] = (input) => {
    const runtimeConnector = getConnectorRuntimeConnector(
      snapshot,
      input.connectorSlug,
    );
    if (runtimeConnector === undefined) {
      return { ok: false, reason: "unknown_connector" };
    }
    return resolvedSlug({
      connectorSlug: input.connectorSlug,
      requireExecutable: input.requireExecutable,
      runtimeConnector,
      snapshot,
    });
  };

  const resolveMethod: ConnectorActionResolver["resolveMethod"] = (input) => {
    const runtimeConnector = getConnectorRuntimeConnector(
      snapshot,
      input.connectorSlug,
    );
    if (runtimeConnector === undefined) {
      return { ok: false, reason: "unknown_connector" };
    }
    const catalogConnector = runtimeConnector.catalogConnector;
    const catalogMethod = catalogConnector.authMethods.find((method) => {
      return method.id === input.authMethodId;
    });
    if (!catalogMethod) {
      return {
        ok: false,
        reason: "unknown_auth_method",
        catalogConnector,
      };
    }
    if (catalogMethod.grantKind !== input.expectedGrantKind) {
      return {
        ok: false,
        reason: "wrong_grant_kind",
        actualGrantKind: catalogMethod.grantKind,
        catalogConnector,
      };
    }

    const selectedSlug = resolvedSlug({
      connectorSlug: input.connectorSlug,
      requireExecutable: true,
      runtimeConnector,
      snapshot,
    });
    if (!selectedSlug.ok) {
      return selectedSlug;
    }
    return executableMethod({
      resolvedSlug: selectedSlug,
      authMethodId: input.authMethodId,
      catalogMethod,
    });
  };

  return {
    resolveSlug,
    resolveMethod,

    resolveNewActionMethod(input) {
      const runtimeConnector = getConnectorRuntimeConnector(
        snapshot,
        input.connectorSlug,
      );
      const catalogMethod = runtimeConnector?.catalogConnector.authMethods.find(
        (method) => {
          return method.id === input.authMethodId;
        },
      );
      if (catalogMethod?.grantKind === input.expectedGrantKind) {
        if (
          !runtimeConnector?.authoredVisibleMethodIds.has(input.authMethodId)
        ) {
          return { ok: false, reason: "hidden_auth_method" };
        }
      }

      return resolveMethod(input);
    },

    resolveSlugs(input) {
      const connectors: ResolvedConnectorSlug[] = [];
      for (const connectorSlug of input.connectorSlugs) {
        const resolved = resolveSlug({
          connectorSlug,
          requireExecutable: input.requireExecutable,
        });
        if (!resolved.ok) {
          return { ...resolved, connectorSlug };
        }
        connectors.push(resolved);
      }
      return { ok: true, connectors };
    },
  };
}

export function connectorActionResolver(): Computed<
  Promise<ConnectorActionResolver>
> {
  return computed(async (get): Promise<ConnectorActionResolver> => {
    const snapshot = await loadConnectorRuntimeSnapshot(get(db$));
    return createConnectorActionResolver(snapshot);
  });
}

export function connectorActionResolverForSnapshot(
  snapshot: ConnectorRuntimeSnapshot,
): Computed<ConnectorActionResolver> {
  return computed((): ConnectorActionResolver => {
    return createConnectorActionResolver(snapshot);
  });
}
