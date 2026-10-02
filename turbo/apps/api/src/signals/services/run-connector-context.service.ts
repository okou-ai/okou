/**
 * Run connector context preparation shared by execution owners: connector
 * scope, account candidates, stored builtin connector snapshots and secrets,
 * and custom connector runtime rows. Moved verbatim out of the legacy
 * execution graph; exact source reads stay in execution-connector-sources.
 */
import type { ConnectorRuntimeSelection } from "./connector-catalog-runtime.service";
import { compactRecord } from "./connector-runtime-preparation.service";

export type RunConnectorCatalogSelection =
  | { readonly kind: "empty" }
  | {
      readonly kind: "scoped";
      readonly selection: ConnectorRuntimeSelection;
    };

export function mergeRecords<T>(
  ...records: readonly (Record<string, T> | undefined)[]
): Record<string, T> | undefined {
  const merged: Record<string, T> = {};
  for (const record of records) {
    if (record) {
      Object.assign(merged, record);
    }
  }
  return compactRecord(merged);
}
