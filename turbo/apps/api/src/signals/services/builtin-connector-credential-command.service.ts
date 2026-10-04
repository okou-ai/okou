import type { FeatureSwitchContext } from "@okouai/core/feature-switch";
import { command } from "ccstate";

import { writeDb$ } from "../external/db";
import type { ConnectorRuntimeSelection } from "./connector-catalog-runtime.service";
import {
  loadBuiltinConnectorCredentialConnection,
  loadBuiltinConnectorCredentialValues,
  refreshBuiltinConnectorCredentialAccess,
  type BuiltinConnectorCredentialConnection,
  type BuiltinConnectorCredentialConnectionResult,
  type BuiltinConnectorCredentialRefreshResult,
} from "./builtin-connector-credential-runtime.service";

export const loadBuiltinConnectorCredentialConnection$ = command(
  async (
    { set },
    args: {
      readonly connectorId: string;
      readonly connectorSlug: string;
      readonly orgId: string;
      readonly snapshot: ConnectorRuntimeSelection;
      readonly userId: string;
    },
  ): Promise<BuiltinConnectorCredentialConnectionResult> => {
    return await loadBuiltinConnectorCredentialConnection({
      ...args,
      db: set(writeDb$),
    });
  },
);

export const loadBuiltinConnectorCredentialValues$ = command(
  async (
    { set },
    args: {
      readonly connection: BuiltinConnectorCredentialConnection;
      readonly featureSwitchContext?: FeatureSwitchContext;
      readonly valueRefs: readonly string[];
    },
    signal: AbortSignal,
  ): Promise<ReadonlyMap<string, string>> => {
    const values = await loadBuiltinConnectorCredentialValues({
      ...args,
      db: set(writeDb$),
    });
    signal.throwIfAborted();
    return values;
  },
);

export const refreshBuiltinConnectorCredentialAccess$ = command(
  async (
    { set },
    args: {
      readonly connection: BuiltinConnectorCredentialConnection;
      readonly featureSwitchContext?: FeatureSwitchContext;
      readonly orgId: string;
      readonly persist?: {
        readonly defaultExpiresInMs?: number;
        readonly markNeedsReconnectOnFailure?: boolean;
      };
      readonly runtimeEnvironmentName: string;
      readonly userId: string;
    },
    signal: AbortSignal,
  ): Promise<BuiltinConnectorCredentialRefreshResult> => {
    const db = set(writeDb$);
    const { persist, ...rest } = args;
    return await refreshBuiltinConnectorCredentialAccess(
      {
        ...rest,
        db,
        ...(persist === undefined ? {} : { persist: { ...persist, db } }),
      },
      signal,
    );
  },
);
