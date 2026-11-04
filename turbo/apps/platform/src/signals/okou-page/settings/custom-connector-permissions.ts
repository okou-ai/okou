import { command, computed, state } from "ccstate";
import { toast } from "@okouai/ui/components/ui/sonner";
import { isIntegrationManagedCustomConnector } from "@okouai/api-contracts/validators/custom-connectors";
import type {
  CustomConnectorPermissionBundleResponse,
  CustomConnectorResponse,
} from "@okouai/api-contracts/contracts/custom-connectors";
import { customConnectorByIdContract } from "@okouai/api-contracts/client/custom-connectors";
import { agentCustomConnectorsContract } from "@okouai/api-contracts/client/agent-custom-connectors";

import { apiClient$ } from "../../api-client.ts";
import { i18n } from "../../../i18n/index.ts";
import { accept } from "../../../lib/accept.ts";
import { resetSignal, withCleanup } from "../../utils.ts";
import {
  customConnectorAgentAuthorizations$,
  customConnectors$,
  reloadCustomConnectorAuthorizedAgents$,
} from "./custom-connectors.ts";
import { agentCustomConnectorGrants$ } from "../job-detail/custom-connectors.ts";
import { requireCustomConnectorAccountReady } from "./connector-accounts.ts";

type CustomConnectorPermissionSurface = "agent-detail" | "access-management";

export interface CustomConnectorPermissionDraft {
  readonly surface: CustomConnectorPermissionSurface;
  readonly agentId: string;
  readonly connectorId: string;
  readonly initiallyAuthorized: boolean;
  readonly initialPermissionNames: readonly string[];
  readonly permissionNames: readonly string[];
}

const internalPermissionDraft$ = state<CustomConnectorPermissionDraft | null>(
  null,
);
const resetPermissionSignal$ = resetSignal();
const resetPermissionSaveSignal$ = resetSignal();

export const customConnectorPermissionDraft$ = computed((get) => {
  return get(internalPermissionDraft$);
});

const permissionConnectorId$ = computed((get) => {
  return get(internalPermissionDraft$)?.connectorId ?? null;
});

export const openCustomConnectorPermissions$ = command(
  (
    { set },
    args: {
      readonly surface: CustomConnectorPermissionSurface;
      readonly agentId: string;
      readonly connectorId: string;
      readonly initiallyAuthorized: boolean;
      readonly permissionNames: readonly string[];
    },
    signal: AbortSignal,
  ): void => {
    signal.throwIfAborted();
    const sessionSignal = set(resetPermissionSignal$, signal);
    sessionSignal.addEventListener(
      "abort",
      () => {
        set(resetPermissionSaveSignal$);
        set(internalPermissionDraft$, null);
      },
      { once: true },
    );
    set(internalPermissionDraft$, {
      surface: args.surface,
      agentId: args.agentId,
      connectorId: args.connectorId,
      initiallyAuthorized: args.initiallyAuthorized,
      initialPermissionNames: [...args.permissionNames],
      permissionNames: [...args.permissionNames],
    });
  },
);

export const prepareCustomConnectorPermissions$ = command(
  async (
    { get, set },
    args: {
      readonly surface: CustomConnectorPermissionSurface;
      readonly agentId: string;
      readonly connector: CustomConnectorResponse;
      readonly initiallyAuthorized: boolean;
      readonly permissionNames: readonly string[];
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const attemptSignal = set(resetPermissionSignal$, signal);
    if (
      !args.initiallyAuthorized &&
      !isIntegrationManagedCustomConnector(args.connector)
    ) {
      await requireCustomConnectorAccountReady(
        get(apiClient$),
        args.connector.id,
        attemptSignal,
      );
    }
    attemptSignal.throwIfAborted();
    set(
      openCustomConnectorPermissions$,
      {
        surface: args.surface,
        agentId: args.agentId,
        connectorId: args.connector.id,
        initiallyAuthorized: args.initiallyAuthorized,
        permissionNames: args.permissionNames,
      },
      signal,
    );
  },
);

export const closeCustomConnectorPermissions$ = command(({ set }): void => {
  set(resetPermissionSignal$);
});

export const setCustomConnectorPermissionDraftValue$ = command(
  (
    { set },
    args: {
      readonly agentId: string;
      readonly connectorId: string;
      readonly permissionName: string;
      readonly allow: boolean;
    },
  ): void => {
    set(internalPermissionDraft$, (current) => {
      if (
        current?.agentId !== args.agentId ||
        current.connectorId !== args.connectorId
      ) {
        return current;
      }
      const permissionNames = new Set(current.permissionNames);
      if (args.allow) {
        permissionNames.add(args.permissionName);
      } else {
        permissionNames.delete(args.permissionName);
      }
      return { ...current, permissionNames: [...permissionNames] };
    });
  },
);

export const customConnectorPermissionBundle$ = computed(
  async (get): Promise<CustomConnectorPermissionBundleResponse | null> => {
    const connectorId = get(permissionConnectorId$);
    if (!connectorId) {
      return null;
    }
    const client = get(apiClient$)(customConnectorByIdContract);
    const result = await accept(
      client.permissions({ params: { id: connectorId } }),
      [200, 404],
    );
    return result.status === 200 ? result.body : null;
  },
);

export const saveCustomConnectorPermissions$ = command(
  async (
    { get, set },
    args: {
      readonly surface: CustomConnectorPermissionSurface;
      readonly agentId: string;
      readonly connectorId: string;
      readonly permissionNames: readonly string[];
    },
    signal: AbortSignal,
  ): Promise<void> => {
    signal.throwIfAborted();
    const sessionSignal = set(resetPermissionSaveSignal$, signal);
    const draft = get(internalPermissionDraft$);
    const addsAccess =
      !draft ||
      draft.agentId !== args.agentId ||
      draft.connectorId !== args.connectorId ||
      !draft.initiallyAuthorized ||
      args.permissionNames.some((permission) => {
        return !draft.initialPermissionNames.includes(permission);
      });
    if (addsAccess) {
      const connector = (await get(customConnectors$)).find((candidate) => {
        return candidate.id === args.connectorId;
      });
      sessionSignal.throwIfAborted();
      if (!connector) {
        throw new Error("This connector is no longer available.");
      }
      if (!isIntegrationManagedCustomConnector(connector)) {
        await requireCustomConnectorAccountReady(
          get(apiClient$),
          args.connectorId,
          sessionSignal,
        );
      }
    }
    const client = get(apiClient$)(agentCustomConnectorsContract);
    // eslint-disable-next-line ccstate/no-with-cleanup -- Legacy 20261022: existing withCleanup only; do not add new usages.
    await withCleanup(
      accept(
        client.update({
          params: { id: args.agentId },
          body: {
            grants: [
              {
                customConnectorId: args.connectorId,
                permissionNames: [...args.permissionNames],
              },
            ],
            operation: "add",
          },
          fetchOptions: { signal: sessionSignal },
        }),
        [200],
      ),
      () => {
        set(reloadCustomConnectorAuthorizedAgents$);
      },
    );
    signal.throwIfAborted();
    sessionSignal.throwIfAborted();
    await (args.surface === "agent-detail"
      ? get(agentCustomConnectorGrants$)
      : get(customConnectorAgentAuthorizations$));
    signal.throwIfAborted();
    sessionSignal.throwIfAborted();
    toast.success(
      i18n.t(($) => {
        return $.connectors.access.permissionsUpdated;
      }),
    );
    set(closeCustomConnectorPermissions$);
  },
);
