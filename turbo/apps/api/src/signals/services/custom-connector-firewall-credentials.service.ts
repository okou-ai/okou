import { command } from "ccstate";
import { connectors } from "@okouai/db/schema/connector";

import { db$ } from "../external/db";
import {
  connectorAccountTargetKey,
  connectorAccountResolutionReadPlan,
  connectorAccountResolutionsFromRows,
} from "./connector-account-resolution.service";
import {
  CUSTOM_CONNECTOR_OAUTH_ACCESS_TOKEN_RUNTIME_KEY,
  customConnectorSecretKey,
  customConnectorRuntimeDefinitionReadPlan,
  customConnectorRuntimeStorageReadInput,
  customConnectorRuntimeDataFromRows,
} from "./custom-connector.service";
import {
  customConnectorRuntimeStorageReadQuery,
  customConnectorRuntimeStorageSnapshot,
} from "./custom-connector-credential-access.service";

export type CurrentCustomConnectorAuthRef =
  | {
      readonly secretName: string;
      readonly memberConnectorId: string;
      readonly kind: "secret";
      readonly key: string;
      readonly encryptedValue: string | null;
    }
  | {
      readonly secretName: string;
      readonly memberConnectorId: string;
      readonly kind: "variable";
      readonly key: string;
      readonly value: string | null;
    };

type CurrentCustomConnectorAuthRefsResolution =
  | {
      readonly kind: "available";
      readonly authRefs: readonly CurrentCustomConnectorAuthRef[];
      readonly runtimeAvailable: boolean;
    }
  | { readonly kind: "unavailable" };

export const readCurrentCustomConnectorAuthRefs$ = command(
  async (
    { get },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly customConnectorId: string;
      readonly sourceId: string;
    },
  ): Promise<CurrentCustomConnectorAuthRefsResolution> => {
    const db = get(db$);
    const memberLookupArgs = args;
    const memberConnectorId = await (async (): Promise<string | undefined> => {
      const target = {
        kind: "custom" as const,
        customConnectorId: memberLookupArgs.customConnectorId,
      };
      const plan = connectorAccountResolutionReadPlan({
        orgId: memberLookupArgs.orgId,
        userId: memberLookupArgs.userId,
        requests: [
          {
            target,
            selection: { kind: "exact", sourceId: memberLookupArgs.sourceId },
          },
        ],
      });
      const [exactRows, defaultRows] = await Promise.all([
        plan.exactWhere
          ? db.select(plan.columns).from(connectors).where(plan.exactWhere)
          : [],
        plan.defaultWhere
          ? db.select(plan.columns).from(connectors).where(plan.defaultWhere)
          : [],
      ]);
      const accountResolutions = connectorAccountResolutionsFromRows({
        requests: plan.requests,
        exactRows,
        defaultRows,
      });
      const accountResolution = accountResolutions.get(
        connectorAccountTargetKey(target),
      );
      return accountResolution?.kind === "resolved"
        ? accountResolution.account.connectorId
        : undefined;
    })();
    if (memberConnectorId === undefined) {
      return { kind: "unavailable" };
    }
    const runtimeScope = {
      orgId: args.orgId,
      userId: args.userId,
      connectorIds: [args.customConnectorId],
      memberConnectorIdsByCustomConnectorId: new Map([
        [args.customConnectorId, memberConnectorId],
      ]),
    };
    const [runtime] = await (async () => {
      const connectorRows = await (async () => {
        return await (async () => {
          const plan = customConnectorRuntimeDefinitionReadPlan(runtimeScope);
          return await db
            .select(plan.columns)
            .from(plan.from)
            .leftJoin(plan.join.table, plan.join.on)
            .where(plan.where);
        })();
      })();
      if (connectorRows.length === 0) {
        return [];
      }

      return await (async () => {
        return await (async () => {
          const { definitions, connectorIds, memberConnectorIds } =
            customConnectorRuntimeStorageReadInput(
              connectorRows,
              runtimeScope.memberConnectorIdsByCustomConnectorId,
            );
          if (memberConnectorIds.length === 0) {
            return customConnectorRuntimeDataFromRows(
              connectorRows,
              customConnectorRuntimeStorageSnapshot(
                definitions,
                [],
                runtimeScope.memberConnectorIdsByCustomConnectorId,
              ),
            );
          }
          const query = customConnectorRuntimeStorageReadQuery({
            orgId: runtimeScope.orgId,
            userId: runtimeScope.userId,
            connectorIds,
            memberConnectorIds,
          });
          const captured = db
            .$with("captured_custom_runtime_storage")
            .as(query);
          const rows = await db.with(captured).select().from(captured);
          const runtimeStorage = customConnectorRuntimeStorageSnapshot(
            definitions,
            rows,
            runtimeScope.memberConnectorIdsByCustomConnectorId,
          );
          return customConnectorRuntimeDataFromRows(
            connectorRows,
            runtimeStorage,
          );
        })();
      })();
    })();
    return currentCustomConnectorAuthRefsFromRuntime(
      runtime,
      memberConnectorId,
    );
  },
);

function currentCustomConnectorAuthRefsFromRuntime(
  runtime:
    ReturnType<typeof customConnectorRuntimeDataFromRows>[number] | undefined,
  memberConnectorId: string,
): CurrentCustomConnectorAuthRefsResolution {
  if (!runtime) {
    return { kind: "unavailable" };
  }
  if (runtime.credentialAccess.kind === "incompatible") {
    return { kind: "unavailable" };
  }
  if (runtime.credentialAccess.kind === "absent") {
    return { kind: "unavailable" };
  }
  if (runtime.credentialAccess.memberConnectorId !== memberConnectorId) {
    return { kind: "unavailable" };
  }

  const declaredFields = new Map(
    runtime.connector.fields.map((field) => {
      const secretName = customConnectorSecretKey({
        connectorId: runtime.connector.id,
        kind: field.kind,
        key: field.key,
      });
      return [secretName, field] as const;
    }),
  );
  const refs = new Map<string, CurrentCustomConnectorAuthRef>();
  for (const value of runtime.values) {
    const secretName = customConnectorSecretKey({
      connectorId: runtime.connector.id,
      kind: value.kind,
      key: value.key,
    });
    const field = declaredFields.get(secretName);
    if (!field) {
      // Stored values survive definition edits, but removed fields are no
      // longer part of the executable credential contract.
      continue;
    }
    refs.set(
      secretName,
      value.kind === "secret"
        ? {
            secretName,
            memberConnectorId,
            kind: "secret",
            key: value.key,
            encryptedValue: value.encryptedValue,
          }
        : {
            secretName,
            memberConnectorId,
            kind: "variable",
            key: value.key,
            value: value.value,
          },
    );
  }
  for (const [secretName, field] of declaredFields) {
    if (refs.has(secretName)) {
      continue;
    }
    refs.set(
      secretName,
      field.kind === "secret"
        ? {
            secretName,
            memberConnectorId,
            kind: "secret",
            key: field.key,
            encryptedValue: null,
          }
        : {
            secretName,
            memberConnectorId,
            kind: "variable",
            key: field.key,
            value: null,
          },
    );
  }
  if (
    runtime.connector.authMode === "oauth" ||
    (runtime.connector.authMode === "automatic" &&
      runtime.credentialAccess.resolvedAuthMethod === "oauth")
  ) {
    const secretName = customConnectorSecretKey({
      connectorId: runtime.connector.id,
      kind: "secret",
      key: CUSTOM_CONNECTOR_OAUTH_ACCESS_TOKEN_RUNTIME_KEY,
    });
    refs.set(secretName, {
      secretName,
      memberConnectorId,
      kind: "secret",
      key: CUSTOM_CONNECTOR_OAUTH_ACCESS_TOKEN_RUNTIME_KEY,
      encryptedValue: null,
    });
  }
  return {
    kind: "available",
    authRefs: [...refs.values()],
    runtimeAvailable: runtime.credentialAccess.runtimeAvailable,
  };
}
