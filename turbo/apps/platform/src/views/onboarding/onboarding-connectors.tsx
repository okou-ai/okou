import type { ReactNode } from "react";
import { useGet, useLastLoadable, useSet } from "ccstate-react";
import { cn } from "@okouai/ui";
import {
  connectorSlugSchema,
  type ConnectorSlug,
} from "@okouai/api-contracts/contracts/connector-identity";
import {
  connectBuiltinConnectorNoAuth$,
  connectBuiltinConnectorOAuthAuthCode$,
  builtinConnectFlowSlug$,
  justConnectedBuiltinSlugs$,
  builtinPollingOAuthAuthCodeSlug$,
  builtinPollingOAuthDeviceAuthSlug$,
  selectedBuiltinConnectorSlug$,
  setSelectedBuiltinConnectorSlug$,
} from "../../signals/okou-page/settings/connectors.ts";
import { connectorCatalogStatus$ } from "../../signals/external/connectors.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { ConnectModal } from "../okou-page/components/settings/add-connection-dialog.tsx";
import { ConnectorCard } from "../okou-page/components/settings/connector-card.tsx";
import { defaultBuiltinConnectorAccountOptions } from "../../signals/okou-page/settings/connector-account-dialogs.ts";

type ConnectorSetupVariant = "workflow" | "prompt";

function parseConnectorSlugs(values: readonly string[]): ConnectorSlug[] {
  return values.flatMap((value) => {
    const parsed = connectorSlugSchema.safeParse(value);
    return parsed.success ? [parsed.data] : [];
  });
}

export function OnboardingConnectorSetup({
  connectorSlugs,
  requiredConnectorSlugs,
  variant = "workflow",
  children,
}: {
  readonly connectorSlugs: readonly string[];
  readonly requiredConnectorSlugs?: readonly string[];
  readonly variant?: ConnectorSetupVariant;
  readonly children?: ReactNode;
}) {
  const validConnectorSlugs = parseConnectorSlugs(connectorSlugs);
  const requiredSet = new Set(
    parseConnectorSlugs(requiredConnectorSlugs ?? []),
  );
  const pageSignal = useGet(pageSignal$);
  const connectorCatalogItemsLoadable = useLastLoadable(
    connectorCatalogStatus$,
  );
  const connect = useSet(connectBuiltinConnectorOAuthAuthCode$);
  const connectNoAuth = useSet(connectBuiltinConnectorNoAuth$);
  const selectedConnectorSlug = useGet(selectedBuiltinConnectorSlug$);
  const setSelectedConnectorSlug = useSet(setSelectedBuiltinConnectorSlug$);
  const connectFlowSlug = useGet(builtinConnectFlowSlug$);
  const pollingAuthCodeSlug = useGet(builtinPollingOAuthAuthCodeSlug$);
  const pollingDeviceAuthSlug = useGet(builtinPollingOAuthDeviceAuthSlug$);
  const justConnectedSlugs = useGet(justConnectedBuiltinSlugs$);

  if (validConnectorSlugs.length === 0 && children === undefined) {
    return null;
  }

  const connectorCatalogItems =
    connectorCatalogItemsLoadable.state === "hasData"
      ? connectorCatalogItemsLoadable.data.connectors
      : [];
  const selectedConnector = selectedConnectorSlug
    ? connectorCatalogItems.find((connector) => {
        return connector.slug === selectedConnectorSlug;
      })
    : undefined;
  const selectedAccountOptions =
    defaultBuiltinConnectorAccountOptions(selectedConnector);
  const loading = connectorCatalogItemsLoadable.state === "loading";

  return (
    <>
      <section
        className={cn(
          variant === "workflow"
            ? "mt-5 rounded-3xl border border-border bg-background px-6 pb-6"
            : "mt-6 flex flex-col gap-3",
        )}
      >
        {validConnectorSlugs.map((connectorSlug) => {
          const item = connectorCatalogItems.find((candidate) => {
            return candidate.slug === connectorSlug;
          });
          const connected =
            item?.connected === true || justConnectedSlugs.has(connectorSlug);
          const connecting =
            connectFlowSlug === connectorSlug ||
            pollingAuthCodeSlug === connectorSlug ||
            pollingDeviceAuthSlug === connectorSlug;
          const accountOptions = defaultBuiltinConnectorAccountOptions(item);

          return (
            <ConnectorCard
              key={connectorSlug}
              variant="onboarding"
              connectorSlug={connectorSlug}
              connector={item}
              connected={connected}
              busy={connecting}
              loading={loading}
              layout={variant}
              required={requiredSet.has(connectorSlug)}
              connect={
                item && accountOptions
                  ? {
                      openModal: () => {
                        setSelectedConnectorSlug(connectorSlug);
                      },
                      connectBrowserAuth: (authMethod) => {
                        return connect(
                          connectorSlug,
                          authMethod,
                          {
                            connectorLabel: item.label,
                            connectorIcon: item.icon,
                            authorizeVisibleAgents: true,
                            ...accountOptions,
                          },
                          pageSignal,
                        );
                      },
                      connectNoAuth: (authMethod) => {
                        return connectNoAuth(
                          {
                            connectorSlug,
                            authMethod,
                            options: {
                              connectorLabel: item.label,
                              authorizeVisibleAgents: true,
                              ...accountOptions,
                            },
                          },
                          pageSignal,
                        );
                      },
                    }
                  : undefined
              }
            />
          );
        })}
        {children}
      </section>
      {selectedConnector && selectedAccountOptions ? (
        <ConnectModal
          item={selectedConnector}
          accountOptions={selectedAccountOptions}
          authorizeVisibleAgentsOnConnect
          onClose={() => {
            setSelectedConnectorSlug(null);
          }}
        />
      ) : null}
    </>
  );
}
