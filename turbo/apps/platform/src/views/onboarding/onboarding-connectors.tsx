import type { ReactNode } from "react";
import { useGet, useLastLoadable, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { ChevronRight, Loader2, Plus } from "lucide-react";
import { cn, Button } from "@okouai/ui";
import {
  connectorSlugSchema,
  type ConnectorSlug,
} from "@okouai/api-contracts/contracts/connector-identity";
import {
  connectBuiltinConnectorNoAuth$,
  connectBuiltinConnectorOAuthAuthCode$,
  connectBuiltinConnectorOAuthAuthCodeAndSettle$,
  builtinConnectFlowSlug$,
  justConnectedBuiltinSlugs$,
  builtinPollingOAuthAuthCodeSlug$,
  builtinPollingOAuthDeviceAuthSlug$,
  getOnlyAvailableBuiltinConnectorStatusBrowserAuthMethodDetail,
  runBuiltinConnectorConnectSuccess$,
  selectedBuiltinConnectorCatalogItem$,
  selectedBuiltinConnectorSlug$,
  setSelectedBuiltinConnectorSlug$,
} from "../../signals/okou-page/settings/connectors.ts";
import { reloadBuiltinConnectors$ } from "../../signals/external/connectors.ts";
import { onboardingSourceConnectors$ } from "../../signals/onboarding/onboarding-sources-first-catalog.ts";
import {
  onboardingMakeConnectorItems$,
  onboardingWorkflowConnectorItems$,
} from "../../signals/onboarding/onboarding-connector-items.ts";
import type {
  PlatformConnectorCatalogConnectItem,
  PlatformConnectorCatalogStatusItem,
} from "../../signals/connector-domain.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { ConnectModal } from "../okou-page/components/settings/add-connection-dialog.tsx";
import { ConnectorCard } from "../okou-page/components/settings/connector-card.tsx";
import {
  ConnectorEntryCard,
  ConnectorEntryStatus,
} from "../okou-page/components/settings/connector-entry-card.tsx";
import { ConnectorIcon } from "../okou-page/components/settings/connector-icons.tsx";
import { defaultBuiltinConnectorAccountOptions } from "../../signals/okou-page/settings/connector-account-dialogs.ts";
import { detach, Reason } from "../../signals/utils.ts";

interface ConnectorSetupBaseProps {
  readonly connectorSlugs: readonly string[];
  readonly requiredConnectorSlugs?: readonly string[];
  /**
   * The sources grid reports its own funnel events. The list layouts belong to
   * other flows and pass neither.
   */
  readonly onConnectStart?: (connectorSlug: ConnectorSlug) => void;
  readonly onConnected?: (connectorSlug: ConnectorSlug) => void;
  readonly children?: ReactNode;
}

/** The source step's grid: its connectors come from the onboarding sources. */
type SourcesConnectorSetupProps = ConnectorSetupBaseProps & {
  readonly variant: "sources";
};

/** The list layouts of the workflow run and template pages. */
type ListConnectorSetupProps = ConnectorSetupBaseProps & {
  readonly variant?: "workflow" | "prompt";
};

type ConnectorSetupProps = SourcesConnectorSetupProps | ListConnectorSetupProps;

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
  readonly connector: PlatformConnectorCatalogConnectItem;
  readonly connected: boolean;
  readonly busy: boolean;
  readonly onActivate: () => void;
}) {
  const { t } = useTranslation();

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

export function OnboardingConnectorSetup(props: ConnectorSetupProps) {
  if (props.variant === "sources") {
    return <SourcesConnectorGrid {...props} />;
  }
  return <ListConnectorSetup {...props} />;
}

/** The picked connector's full entry, for the connect modal it opens. */
function useSelectedConnector(): {
  readonly selectedConnector: PlatformConnectorCatalogStatusItem | undefined;
  readonly setSelectedConnectorSlug: (slug: ConnectorSlug | null) => void;
} {
  const selectedConnectorSlug = useGet(selectedBuiltinConnectorSlug$);
  const setSelectedConnectorSlug = useSet(setSelectedBuiltinConnectorSlug$);
  const selectedLoadable = useLastLoadable(
    selectedBuiltinConnectorCatalogItem$,
  );
  const selectedConnector =
    selectedConnectorSlug !== null &&
    selectedLoadable.state === "hasData" &&
    selectedLoadable.data?.slug === selectedConnectorSlug
      ? selectedLoadable.data
      : undefined;
  return { selectedConnector, setSelectedConnectorSlug };
}

function useSourceConnectorActivate(
  onConnectStart: ConnectorSetupProps["onConnectStart"],
  onConnected: ConnectorSetupProps["onConnected"],
) {
  const pageSignal = useGet(pageSignal$);
  const selectConnector = useSet(setSelectedBuiltinConnectorSlug$);
  const directConnect = useSet(connectBuiltinConnectorOAuthAuthCodeAndSettle$);
  const runConnectSuccess = useSet(runBuiltinConnectorConnectSuccess$);

  return (item: PlatformConnectorCatalogConnectItem, connected: boolean) => {
    onConnectStart?.(item.slug);
    const authMethod =
      getOnlyAvailableBuiltinConnectorStatusBrowserAuthMethodDetail(item);
    const accountOptions = defaultBuiltinConnectorAccountOptions(item);
    if (!connected && authMethod && accountOptions) {
      detach(
        directConnect(
          {
            connectorSlug: item.slug,
            method: authMethod,
            options: {
              connectorLabel: item.label,
              connectorIcon: item.icon,
              authorizeVisibleAgents: true,
              ...accountOptions,
            },
            onSuccess: (connectionId, signal) => {
              return runConnectSuccess(
                item.slug,
                () => {
                  onConnected?.(item.slug);
                },
                connectionId,
                signal,
              );
            },
          },
          pageSignal,
        ),
        Reason.DomCallback,
      );
      return;
    }
    selectConnector(item.slug);
  };
}

/** The source step's grid, on the connector directory's own entry card. */
function SourcesConnectorGrid({
  connectorSlugs,
  onConnectStart,
  onConnected,
}: SourcesConnectorSetupProps) {
  const validConnectorSlugs = parseConnectorSlugs(connectorSlugs);
  const connectorCatalogItemsLoadable = useLastLoadable(
    onboardingSourceConnectors$,
  );
  const retryCatalog = useSet(reloadBuiltinConnectors$);
  const { t } = useTranslation();
  const { selectedConnector, setSelectedConnectorSlug } =
    useSelectedConnector();
  const activate = useSourceConnectorActivate(onConnectStart, onConnected);
  const connectFlowSlug = useGet(builtinConnectFlowSlug$);
  const pollingAuthCodeSlug = useGet(builtinPollingOAuthAuthCodeSlug$);
  const pollingDeviceAuthSlug = useGet(builtinPollingOAuthDeviceAuthSlug$);
  const justConnectedSlugs = useGet(justConnectedBuiltinSlugs$);
  const connectorCatalogItems =
    connectorCatalogItemsLoadable.state === "hasData"
      ? connectorCatalogItemsLoadable.data
      : [];
  const selectedAccountOptions =
    defaultBuiltinConnectorAccountOptions(selectedConnector);

  if (connectorCatalogItemsLoadable.state === "hasError") {
    return (
      <div
        role="alert"
        className="flex items-center justify-between gap-3 text-sm text-muted-foreground"
      >
        <p>
          {t(($) => {
            return $.connectors.catalog.directory.builtinLoadFailed;
          })}
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={retryCatalog}
        >
          {t(($) => {
            return $.connectors.catalog.directory.retry;
          })}
        </Button>
      </div>
    );
  }

  if (connectorCatalogItemsLoadable.state === "loading") {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        {t(($) => {
          return $.connectors.catalog.directory.loading;
        })}
      </p>
    );
  }

  return (
    <>
      {/* Two columns whatever the card's width: three leaves each source too
          narrow to read its own description. */}
      <section className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {validConnectorSlugs.map((connectorSlug) => {
          const item = connectorCatalogItems.find((candidate) => {
            return candidate.slug === connectorSlug;
          });
          if (!item) {
            return null;
          }
          const connected =
            item.connected || justConnectedSlugs.has(connectorSlug);
          return (
            <SourceConnectorCard
              key={connectorSlug}
              connectorSlug={connectorSlug}
              connector={item}
              connected={connected}
              busy={
                connectFlowSlug === connectorSlug ||
                pollingAuthCodeSlug === connectorSlug ||
                pollingDeviceAuthSlug === connectorSlug
              }
              onActivate={() => {
                activate(item, connected);
              }}
            />
          );
        })}
      </section>
      {selectedConnector && selectedAccountOptions ? (
        <ConnectModal
          item={selectedConnector}
          accountOptions={selectedAccountOptions}
          authorizeVisibleAgentsOnConnect
          onSuccess={() => {
            onConnected?.(selectedConnector.slug);
          }}
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
  variant: ListConnectorSetupProps["variant"],
): "workflow" | "prompt" {
  return variant === "prompt" ? "prompt" : "workflow";
}

function ListConnectorSetup({
  connectorSlugs,
  requiredConnectorSlugs,
  variant,
  children,
}: ListConnectorSetupProps) {
  const layout = listLayout(variant);
  // Each layout belongs to one page, whose few connectors are looked up by
  // slug: the workflow run page's workflow, the template link's connectors.
  const connectorItems$ =
    layout === "prompt"
      ? onboardingMakeConnectorItems$
      : onboardingWorkflowConnectorItems$;
  const validConnectorSlugs = parseConnectorSlugs(connectorSlugs);
  const requiredSet = new Set(
    parseConnectorSlugs(requiredConnectorSlugs ?? []),
  );
  const pageSignal = useGet(pageSignal$);
  const connectorCatalogItemsLoadable = useLastLoadable(connectorItems$);
  const connect = useSet(connectBuiltinConnectorOAuthAuthCode$);
  const connectNoAuth = useSet(connectBuiltinConnectorNoAuth$);
  const { selectedConnector, setSelectedConnectorSlug } =
    useSelectedConnector();
  const connectFlowSlug = useGet(builtinConnectFlowSlug$);
  const pollingAuthCodeSlug = useGet(builtinPollingOAuthAuthCodeSlug$);
  const pollingDeviceAuthSlug = useGet(builtinPollingOAuthDeviceAuthSlug$);
  const justConnectedSlugs = useGet(justConnectedBuiltinSlugs$);

  if (validConnectorSlugs.length === 0 && children === undefined) {
    return null;
  }

  const connectorCatalogItems =
    connectorCatalogItemsLoadable.state === "hasData"
      ? connectorCatalogItemsLoadable.data
      : [];
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
