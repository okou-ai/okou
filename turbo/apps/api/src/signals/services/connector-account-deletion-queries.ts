import { gmailLabelAppliedEventConfigSchema } from "@okouai/api-contracts/contracts/workflows";
import type { FeatureSwitchContext } from "@okouai/core/feature-switch";
import {
  connectorAuthMethodOwnedSecretNames,
  connectorAuthMethodRevokeMetadata,
} from "@okouai/connectors/connector-auth-method";
import { workflowAutomations } from "@okouai/db/runtime/workflow-automation";
import { array, literal, number, object, string, union, uuid } from "zod";
import {
  builtinConnectorTokenRevokeReadPlan,
  prepareBuiltinConnectorAccountDeletionRevoke,
} from "./builtin-connector-credential-access.service";
import type { ConnectorRuntimeSelection } from "./connector-catalog-runtime.service";
import {
  workflowAutomationOwnerProjectionReadPlan,
  type ProjectedAutomation,
} from "./workflow-automation-account-projection.service";
import { gmailAutomationProjectionConfig } from "./gmail-automation-account.service";
import { notionConfigWithConnectorId } from "./notion-automation-account.service";

export interface BuiltinConnectorDeletionContext {
  readonly request: {
    readonly orgId: string;
    readonly userId: string;
    readonly connectorSlug: string;
    readonly sourceId: string;
  };
  readonly snapshot: ConnectorRuntimeSelection | null;
  readonly featureSwitchContext: FeatureSwitchContext | null;
}

export function deletionProjectionPreparationRead(
  request: BuiltinConnectorDeletionContext["request"],
) {
  if (request.connectorSlug !== "gmail" && request.connectorSlug !== "notion") {
    return null;
  }
  const read = workflowAutomationOwnerProjectionReadPlan({
    ...request,
    target: { kind: "builtin", connectorSlug: request.connectorSlug },
  });
  if (!read || !("eventConfig" in read.columns)) {
    throw new Error("Expected connector configuration projection");
  }
  return { ...read, from: workflowAutomations };
}

/** Preserve the actual contract parsers; SQL rejects a changed configuration. */
export function deletionPreparedProjections(
  rows: readonly ProjectedAutomation[],
  connectionId: string,
) {
  return Object.fromEntries(
    rows.map((automation) => {
      if (!("eventType" in automation)) {
        throw new Error("Expected connector configuration projection");
      }
      const template =
        automation.eventType === "gmail-label-applied"
          ? gmailLabelAppliedEventConfigSchema.safeParse(automation.eventConfig)
              .success
            ? gmailAutomationProjectionConfig(automation)
            : null
          : notionConfigWithConnectorId(
              automation.eventType,
              automation.eventConfig,
              connectionId,
            );
      return [
        automation.id,
        {
          id: automation.id,
          eventType: automation.eventType,
          config: automation.eventConfig,
          valid: template !== null,
          template,
        },
      ] as const;
    }),
  );
}

export function deletionPreparedRevocations(
  context: BuiltinConnectorDeletionContext,
) {
  type Prepared = {
    readonly preparation: NonNullable<
      ReturnType<typeof prepareBuiltinConnectorAccountDeletionRevoke>
    >;
    readonly read: ReturnType<
      typeof builtinConnectorTokenRevokeReadPlan
    > | null;
  };
  const prepared: Prepared[] = [];
  if (context.snapshot === null || context.featureSwitchContext === null) {
    return prepared;
  }
  const connector = context.snapshot.connectors.get(
    context.request.connectorSlug,
  );
  if (!connector) {
    return prepared;
  }
  for (const method of connector.catalogConnector.authMethods) {
    const runtimeMethod = connector.methods.get(method.id);
    if (runtimeMethod?.executable !== true) {
      continue;
    }
    const preparation = prepareBuiltinConnectorAccountDeletionRevoke({
      ...context.request,
      snapshot: context.snapshot,
      featureSwitchContext: context.featureSwitchContext,
      existing: {
        id: context.request.sourceId,
        authMethod: method.id,
        storageVersion: runtimeMethod.method.storage.version,
      },
    });
    if (preparation !== null) {
      const metadata = connectorAuthMethodRevokeMetadata(
        preparation.access.runtimeMethod.method,
      );
      const declared = new Set(
        connectorAuthMethodOwnedSecretNames(
          preparation.access.runtimeMethod.method,
        ),
      );
      const invalid =
        metadata.kind === "token-revoke" &&
        Object.values(metadata.inputs).some((input) => {
          return !declared.has(input.secretName);
        });
      // Only the method actually observed by SQL may reject deletion. An invalid
      // unrelated method must not change the missing-account or sibling outcome.
      prepared.push({
        preparation,
        read: invalid
          ? null
          : builtinConnectorTokenRevokeReadPlan(preparation.access),
      });
    }
  }
  return prepared;
}

export const builtinDeletionSqlResultSchema = union([
  object({ kind: literal("missing") }),
  object({
    kind: literal("deleted"),
    resolvedSelectionCount: number().int().nonnegative(),
    promotedDefaultConnectionId: uuid().nullable(),
    revokeIndex: number().int().nonnegative().nullable(),
    secretRows: array(
      object({ name: string(), encryptedValue: string().nullable() }),
    ),
  }),
]);
