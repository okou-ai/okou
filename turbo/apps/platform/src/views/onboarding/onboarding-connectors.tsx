import type { ReactNode } from "react";
import { useGet, useLastLoadable, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { ChevronRight, Loader2, Plus } from "lucide-react";
import { cn, Skeleton } from "@okouai/ui";
import {
  connectorSlugSchema,
  type ConnectorSlug,
} from "@okouai/api-contracts/contracts/connector-identity";
import {
  connectConnectorNoAuth$,
  connectConnectorOAuthAuthCode$,
  connectFlowConnectorSlug$,
  justConnectedSlugs$,
  pollingOAuthAuthCodeConnectorSlug$,
  pollingOAuthDeviceAuthConnectorSlug$,
  selectedConnectorSlug$,
  setSelectedConnectorSlug$,
} from "../../signals/okou-page/settings/connectors.ts";
import { connectorCatalogStatus$ } from "../../signals/external/connectors.ts";
import type { PlatformConnectorCatalogStatusItem } from "../../signals/connector-domain.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { ConnectModal } from "../okou-page/components/settings/add-connection-dialog.tsx";
import { ConnectorCard } from "../okou-page/components/settings/connector-card.tsx";
import {
  ConnectorEntryCard,
  ConnectorEntryStatus,
} from "../okou-page/components/settings/connector-entry-card.tsx";
import { ConnectorIcon } from "../okou-page/components/settings/connector-icons.tsx";
import { defaultBuiltinConnectorAccountOptions } from "../../signals/okou-page/settings/connector-account-dialogs.ts";

type ConnectorSetupVariant = "workflow" | "prompt" | "sources";

function parseConnectorSlugs(values: readonly string[]): ConnectorSlug[] {
  return values.flatMap((value) => {
    const parsed = connectorSlugSchema.safeParse(value);
    return parsed.success ? [parsed.data] : [];
  });
}

/**
 * The source step's card: the connector directory's own entry card, showing the
 * catalog description until the source is connected and an account status strip
 * after that.
 */
function SourceConnectorCard({
  connectorSlug,
  connector,
  connected,
  busy,
  onActivate,
}: {
  readonly connectorSlug: ConnectorSlug;
  readonly connector: PlatformConnectorCatalogStatusItem | undefined;
  readonly connected: boolean;
  readonly busy: boolean;
  readonly onActivate: () => void;
}) {
  const { t } = useTranslation();

  if (!connector) {
    return <Skeleton className="h-[104px] rounded-surface" />;
  }

  return (
    <ConnectorEntryCard
      icon={<ConnectorIcon icon={connector.icon} size={20} />}
      label={connector.label}
      description={connector.description}
      showDescription={!connected}
      interactive={!busy}
      indicator={
        connected ? null : (
          <span
            className={cn(
              "flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground",
              !busy && "border border-border/60",
            )}
            aria-hidden="true"
          >
            {busy ? (
              <Loader2 size={16} className="animate-spin" />
            ) : (
              <Plus size={14} />
            )}
          </span>
        )
      }
      status={
        connected ? (
          <ConnectorEntryStatus
            tone="success"
            label={t(($) => {
              return $.connectors.card.connected;
            })}
            className="min-w-0 flex-1 text-xs text-muted-foreground"
          />
        ) : null
      }
      trailingAction={
        connected ? (
          <span
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground"
            aria-hidden="true"
          >
            <ChevronRight size={16} />
          </span>
        ) : null
      }
      action={
        <button
          type="button"
          aria-label={t(
            ($) => {
              return $.connectors.card.connectAria;
            },
            { connector: connector.label },
          )}
          data-connector-slug={connectorSlug}
          className="absolute inset-0 z-10 rounded-[inherit] border-0 bg-transparent p-0 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          disabled={busy}
          onClick={onActivate}
        />
      }
    />
  );
}

export function OnboardingConnectorSetup(props: {
  readonly connectorSlugs: readonly string[];
  readonly requiredConnectorSlugs?: readonly string[];
  readonly variant?: ConnectorSetupVariant;
  readonly children?: ReactNode;
}) {
  if (props.variant === "sources") {
    return <SourcesConnectorGrid {...props} />;
  }
  return <ListConnectorSetup {...props} />;
}

/** The source step's grid, on the connector directory's own entry card. */
function SourcesConnectorGrid({
  connectorSlugs,
  children,
}: {
  readonly connectorSlugs: readonly string[];
  readonly children?: ReactNode;
}) {
  const validConnectorSlugs = parseConnectorSlugs(connectorSlugs);
  const connectorCatalogItemsLoadable = useLastLoadable(
    connectorCatalogStatus$,
  );
  const setSelectedConnectorSlug = useSet(setSelectedConnectorSlug$);
  const selectedConnectorSlug = useGet(selectedConnectorSlug$);
  const connectFlowSlug = useGet(connectFlowConnectorSlug$);
  const pollingAuthCodeSlug = useGet(pollingOAuthAuthCodeConnectorSlug$);
  const pollingDeviceAuthSlug = useGet(pollingOAuthDeviceAuthConnectorSlug$);
  const justConnectedSlugs = useGet(justConnectedSlugs$);
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

  return (
    <>
      {/* Two columns whatever the card's width: three leaves each source too
          narrow to read its own description. */}
      <section className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {validConnectorSlugs.map((connectorSlug) => {
          const item = connectorCatalogItems.find((candidate) => {
            return candidate.slug === connectorSlug;
          });
          return (
            <SourceConnectorCard
              key={connectorSlug}
              connectorSlug={connectorSlug}
              connector={item}
              connected={
                item?.connected === true ||
                justConnectedSlugs.has(connectorSlug)
              }
              busy={
                connectFlowSlug === connectorSlug ||
                pollingAuthCodeSlug === connectorSlug ||
                pollingDeviceAuthSlug === connectorSlug
              }
              onActivate={() => {
                setSelectedConnectorSlug(connectorSlug);
              }}
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

/** The two list layouts this component still renders. */
function listLayout(
  variant: ConnectorSetupVariant | undefined,
): "workflow" | "prompt" {
  return variant === "prompt" ? "prompt" : "workflow";
}

function ListConnectorSetup({
  connectorSlugs,
  requiredConnectorSlugs,
  variant,
  children,
}: {
  readonly connectorSlugs: readonly string[];
  readonly requiredConnectorSlugs?: readonly string[];
  readonly variant?: ConnectorSetupVariant;
  readonly children?: ReactNode;
}) {
  const layout = listLayout(variant);
  const validConnectorSlugs = parseConnectorSlugs(connectorSlugs);
  const requiredSet = new Set(
    parseConnectorSlugs(requiredConnectorSlugs ?? []),
  );
  const pageSignal = useGet(pageSignal$);
  const connectorCatalogItemsLoadable = useLastLoadable(
    connectorCatalogStatus$,
  );
  const connect = useSet(connectConnectorOAuthAuthCode$);
  const connectNoAuth = useSet(connectConnectorNoAuth$);
  const selectedConnectorSlug = useGet(selectedConnectorSlug$);
  const setSelectedConnectorSlug = useSet(setSelectedConnectorSlug$);
  const connectFlowSlug = useGet(connectFlowConnectorSlug$);
  const pollingAuthCodeSlug = useGet(pollingOAuthAuthCodeConnectorSlug$);
  const pollingDeviceAuthSlug = useGet(pollingOAuthDeviceAuthConnectorSlug$);
  const justConnectedSlugs = useGet(justConnectedSlugs$);

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
          layout === "workflow" &&
            "mt-5 rounded-3xl border border-border bg-background px-6 pb-6",
          layout === "prompt" && "mt-6 flex flex-col gap-3",
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
              layout={layout}
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
