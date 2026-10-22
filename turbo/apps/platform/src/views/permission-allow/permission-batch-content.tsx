import { useGet, useLastLoadable, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import { Button } from "@okouai/ui";
import { FeatureSwitchKey } from "@okouai/core";
import { Check, Loader2 } from "lucide-react";
import type { PermissionBatchSignals } from "../../signals/chat-page/permission-batch-signals.ts";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import { user$ } from "../../signals/auth.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import {
  findPermissionInMetadata,
  resolveUserPermissionGrantPolicy,
} from "../../signals/permission-allow/permission-allow-signals.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { PermissionGrantDurationSelect } from "../components/permission-grant-duration-select.tsx";
import { ConnectorIcon } from "../okou-page/components/settings/connector-icons.tsx";
import { AvatarFromUrl } from "../okou-page/sidebar-shared.tsx";

export function PermissionBatchContent({
  signals,
  standalone = false,
}: {
  signals: PermissionBatchSignals;
  standalone?: boolean;
}) {
  const features = useLoadable(featureSwitch$);
  if (
    features.state !== "hasData" ||
    !features.data[FeatureSwitchKey.BatchConnectorPermissions]
  ) {
    return null;
  }
  return <BatchContent signals={signals} standalone={standalone} />;
}

function useBatchResources(signals: PermissionBatchSignals) {
  const agent = useLoadable(signals.agent$);
  const user = useLastLoadable(user$);
  const grants = useLastLoadable(signals.grants$);
  const metadata = useLastLoadable(signals.metadata$);
  // Retain the last data during refresh, but never approve against a failed read.
  const currentGrants = useLoadable(signals.grants$);
  const currentMetadata = useLoadable(signals.metadata$);
  const savedSnapshot = useGet(signals.savedSnapshot$);
  const continued = useGet(signals.continued$);
  const dismissed = useGet(signals.dismissed$);
  const expiresIn = useGet(signals.expiresIn$);
  const setExpiresIn = useSet(signals.setExpiresIn$);
  const dismiss = useSet(signals.dismiss$);
  const [confirmState, confirm] = useLoadableSet(signals.confirm$);
  const [continueState, continueChat] = useLoadableSet(signals.continue$);
  const descriptor = signals.descriptor;
  const busy =
    confirmState.state === "loading" || continueState.state === "loading";
  const hasCallback = Boolean(descriptor.callbackPrompt && descriptor.threadId);
  return {
    agent,
    user,
    grants,
    metadata,
    currentGrants,
    currentMetadata,
    savedSnapshot,
    continued,
    dismissed,
    expiresIn,
    setExpiresIn,
    dismiss,
    confirmState,
    confirm,
    continueState,
    continueChat,
    descriptor,
    busy,
    hasCallback,
  };
}

type BatchResources = ReturnType<typeof useBatchResources>;

function getBatchMetadata(
  { metadata, descriptor }: BatchResources,
  ready: boolean,
) {
  const groups =
    metadata.state === "hasData"
      ? metadata.data
          .map((connector) => {
            return {
              connector,
              items: descriptor.items.filter((item) => {
                return item.connectorSlug === connector.connectorSlug;
              }),
            };
          })
          .filter((group) => {
            return group.items.length > 0;
          })
      : [];
  const complete =
    ready &&
    descriptor.items.every((item) => {
      const connector = groups.find((group) => {
        return group.connector.connectorSlug === item.connectorSlug;
      })?.connector;
      return (
        connector &&
        findPermissionInMetadata(connector, item.permission) !== null
      );
    });
  return { groups, complete };
}

function getBatchPolicy(
  resources: BatchResources,
  { groups, complete }: ReturnType<typeof getBatchMetadata>,
  loadFailed: boolean,
) {
  const {
    grants,
    currentGrants,
    savedSnapshot,
    descriptor,
    confirmState,
    continueState,
  } = resources;
  const chosenGrants =
    grants.state === "hasData"
      ? currentGrants.state === "loading" &&
        savedSnapshot &&
        grants.data === savedSnapshot.previousGrants
        ? savedSnapshot.grants
        : grants.data
      : [];
  const allowedCount =
    complete && !loadFailed
      ? descriptor.items.filter((item) => {
          const connector = groups.find((group) => {
            return group.connector.connectorSlug === item.connectorSlug;
          })?.connector;
          return (
            connector &&
            resolveUserPermissionGrantPolicy(
              chosenGrants,
              connector,
              item.permission,
            ) === "allow"
          );
        }).length
      : 0;
  const allowed =
    complete && !loadFailed && allowedCount === descriptor.items.length;
  const callbackFailed =
    allowed &&
    (confirmState.state === "hasError" || continueState.state === "hasError");

  return { allowedCount, allowed, callbackFailed, chosenGrants };
}

function useBatchState(signals: PermissionBatchSignals) {
  const resources = useBatchResources(signals);
  const { agent, grants, metadata, currentGrants, currentMetadata } = resources;
  const ready =
    agent.state === "hasData" &&
    grants.state === "hasData" &&
    metadata.state === "hasData";
  const loadFailed =
    agent.state === "hasError" ||
    currentGrants.state === "hasError" ||
    currentMetadata.state === "hasError";
  const metadataState = getBatchMetadata(resources, ready);
  const policy = getBatchPolicy(resources, metadataState, loadFailed);
  return { ...resources, ...metadataState, ...policy, ready, loadFailed };
}

type BatchState = ReturnType<typeof useBatchState>;
type BatchViewProps = { batch: BatchState };

function BatchHeader({
  batch,
  standalone,
}: BatchViewProps & { standalone: boolean }) {
  const { t } = useTranslation();
  const { allowed, continued, agent, user, descriptor } = batch;
  return (
    <>
      {allowed ? (
        <div
          role="status"
          className="flex flex-col items-center gap-3 text-center"
        >
          <Check size={32} className="text-green-600 opacity-70" />
          <p className="text-lg font-medium text-foreground">
            {t(($) => {
              return $.authorization.permissionBatch.allowed;
            })}
          </p>
          {continued && (
            <p className="text-sm text-muted-foreground">
              {t(($) => {
                return $.authorization.permissionBatch.continued;
              })}
            </p>
          )}
        </div>
      ) : (
        <>
          {standalone && agent.state === "hasData" && (
            <>
              <p className="text-center text-lg font-medium leading-7 text-foreground">
                {t(
                  ($) => {
                    return $.authorization.permission.greeting;
                  },
                  {
                    userName:
                      user.state === "hasData"
                        ? (user.data?.firstName ??
                          user.data?.username ??
                          t(($) => {
                            return $.authorization.permission.userFallback;
                          }))
                        : t(($) => {
                            return $.authorization.permission.userFallback;
                          }),
                    targetName: agent.data.displayName ?? descriptor.agentId,
                  },
                )}
              </p>
              <div className="flex w-full items-center gap-2 rounded-lg border border-border bg-muted/30 py-3 pl-2 pr-8">
                <AvatarFromUrl
                  avatarUrl={agent.data.avatarUrl ?? null}
                  alt=""
                  className="h-10 w-10 shrink-0 rounded-full object-cover object-top"
                />
                <span className="text-sm font-medium text-foreground">
                  {agent.data.displayName ?? descriptor.agentId}
                </span>
              </div>
            </>
          )}
          <p className="text-sm font-medium text-foreground">
            {t(($) => {
              return $.authorization.permissionBatch.title;
            })}
          </p>
        </>
      )}
    </>
  );
}

function BatchPermissionDetails({ batch }: BatchViewProps) {
  const { t } = useTranslation();
  const {
    complete,
    loadFailed,
    allowedCount,
    descriptor,
    groups,
    chosenGrants,
  } = batch;
  return (
    <>
      {complete && !loadFailed && (
        <p className="text-sm text-muted-foreground">
          {t(
            ($) => {
              return $.authorization.permissionBatch.allowedCount;
            },
            { allowed: allowedCount, total: descriptor.items.length },
          )}
        </p>
      )}
      <p className="text-sm text-muted-foreground">
        {t(($) => {
          return $.authorization.permissionBatch.scopeNote;
        })}
      </p>
      {groups.map(({ connector, items }) => {
        return (
          <section
            key={connector.connectorSlug}
            className="flex flex-col gap-3 rounded-lg border border-border px-4 py-3"
          >
            <h3 className="flex items-center gap-2 border-b border-border/70 pb-3 text-sm font-medium text-foreground">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] bg-muted/40">
                <ConnectorIcon icon={connector.icon} size={20} />
              </span>
              {connector.label}
            </h3>
            <ul className="flex flex-col gap-3">
              {items.map((item) => {
                const permission = findPermissionInMetadata(
                  connector,
                  item.permission,
                );
                return (
                  <li
                    key={item.permission}
                    className="flex min-w-0 flex-col items-start gap-1"
                  >
                    <code className="max-w-full break-all rounded border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-xs text-sky-700">
                      {item.permission}
                    </code>
                    {!loadFailed &&
                      resolveUserPermissionGrantPolicy(
                        chosenGrants,
                        connector,
                        item.permission,
                      ) === "allow" && (
                        <span className="text-xs text-muted-foreground">
                          {t(($) => {
                            return $.chat.permissions.alreadyAllowed;
                          })}
                        </span>
                      )}
                    {permission?.description && (
                      <p className="text-sm text-foreground">
                        {permission.description}
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </>
  );
}

function BatchFeedback({ batch }: BatchViewProps) {
  const { t } = useTranslation();
  const {
    allowed,
    ready,
    loadFailed,
    complete,
    expiresIn,
    busy,
    setExpiresIn,
    confirmState,
    callbackFailed,
  } = batch;
  return (
    <>
      {!allowed && !ready && !loadFailed && (
        <Loader2
          aria-label={t(($) => {
            return $.authorization.permissionBatch.loading;
          })}
          size={20}
          className="animate-spin self-center text-muted-foreground"
        />
      )}
      {!allowed && (loadFailed || (ready && !complete)) && (
        <p role="alert" className="text-sm text-destructive">
          {t(($) => {
            return $.authorization.permissionBatch.loadFailed;
          })}
        </p>
      )}
      {!allowed && complete && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-border/70 px-3 py-2">
          <span className="text-sm font-medium text-foreground">
            {t(($) => {
              return $.authorization.permission.duration;
            })}
          </span>
          <PermissionGrantDurationSelect
            value={expiresIn}
            disabled={busy || loadFailed}
            onValueChange={setExpiresIn}
            ariaLabel={t(($) => {
              return $.authorization.permission.durationLabel;
            })}
          />
        </div>
      )}
      {!allowed && expiresIn === "always" && (
        <p className="text-sm text-muted-foreground">
          {t(($) => {
            return $.authorization.permissionBatch.alwaysNote;
          })}
        </p>
      )}
      {confirmState.state === "hasError" && !allowed && (
        <p role="alert" className="text-sm text-destructive">
          {t(($) => {
            return $.authorization.permission.errors.updateFailed;
          })}
        </p>
      )}
      {callbackFailed && (
        <p role="alert" className="text-sm text-destructive">
          {t(($) => {
            return $.authorization.permissionBatch.continueFailed;
          })}
        </p>
      )}
    </>
  );
}

function BatchActions({
  batch,
  standalone,
}: BatchViewProps & { standalone: boolean }) {
  const { t } = useTranslation();
  const pageSignal = useGet(pageSignal$);
  const {
    allowed,
    busy,
    loadFailed,
    complete,
    confirm,
    descriptor,
    hasCallback,
    continued,
    continueChat,
    dismiss,
  } = batch;
  return (
    <>
      {!allowed && (
        <Button
          type="button"
          disabled={busy || loadFailed || !complete}
          onClick={() => {
            detach(confirm(pageSignal), Reason.DomCallback);
          }}
          className="h-9 w-full rounded-[10px]"
        >
          {busy
            ? t(($) => {
                return $.authorization.permission.saving;
              })
            : t(
                ($) => {
                  return $.authorization.permissionBatch.allowAll;
                },
                { count: descriptor.items.length },
              )}
        </Button>
      )}
      {allowed && hasCallback && !continued && (
        <Button
          type="button"
          disabled={busy}
          onClick={() => {
            detach(continueChat(pageSignal), Reason.DomCallback);
          }}
          className="h-9 w-full rounded-[10px]"
        >
          {busy
            ? t(($) => {
                return $.authorization.permissionBatch.continuing;
              })
            : t(($) => {
                return $.authorization.permissionBatch.continue;
              })}
        </Button>
      )}
      {standalone && !allowed && (
        <Button
          type="button"
          variant="ghost"
          disabled={busy}
          onClick={() => {
            dismiss();
          }}
        >
          {t(($) => {
            return $.authorization.permissionBatch.notNow;
          })}
        </Button>
      )}
    </>
  );
}

function BatchContent({
  signals,
  standalone,
}: {
  signals: PermissionBatchSignals;
  standalone: boolean;
}) {
  const { t } = useTranslation();
  const batch = useBatchState(signals);
  if (batch.dismissed && !batch.allowed) {
    return (
      <p role="status" className="text-center text-sm text-muted-foreground">
        {t(($) => {
          return $.authorization.permissionBatch.dismissed;
        })}
      </p>
    );
  }
  return (
    <div className="flex w-full min-w-0 flex-col gap-4">
      <BatchHeader batch={batch} standalone={standalone} />
      <BatchPermissionDetails batch={batch} />
      <BatchFeedback batch={batch} />
      <BatchActions batch={batch} standalone={standalone} />
      {!standalone && (
        <a
          href={signals.href}
          className="text-sm text-muted-foreground underline underline-offset-4"
        >
          {t(($) => {
            return $.authorization.permissionBatch.details;
          })}
        </a>
      )}
    </div>
  );
}
