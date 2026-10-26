import { useGet, useLastLoadable, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import { UNKNOWN_PERMISSION_GRANT } from "@okouai/connectors/firewall-contracts";
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  IconButton,
  cn,
} from "@okouai/ui";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { AlertCircle, Check, Loader2, ShieldCheck, X } from "lucide-react";
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
  const dismissed = useGet(signals.dismissed$);
  const expiresIn = useGet(signals.expiresIn$);
  const setExpiresIn = useSet(signals.setExpiresIn$);
  const dismiss = useSet(signals.dismiss$);
  const [confirmState, confirm] = useLoadableSet(signals.confirm$);
  const descriptor = signals.descriptor;
  const busy = confirmState.state === "loading";
  const continued =
    Boolean(descriptor.threadId && descriptor.callbackPrompt) &&
    confirmState.state === "hasData" &&
    confirmState.data === true;
  return {
    agent: agent.state === "hasData" ? agent.data : null,
    user: user.state === "hasData" ? user.data : null,
    grants: grants.state === "hasData" ? grants.data : [],
    metadata: metadata.state === "hasData" ? metadata.data : [],
    ready:
      agent.state === "hasData" &&
      grants.state === "hasData" &&
      metadata.state === "hasData",
    loadFailed:
      agent.state === "hasError" ||
      currentGrants.state === "hasError" ||
      currentMetadata.state === "hasError",
    continued,
    dismissed,
    expiresIn,
    setExpiresIn,
    dismiss,
    saveFailed: confirmState.state === "hasError",
    confirm,
    descriptor,
    busy,
  };
}

type BatchResources = ReturnType<typeof useBatchResources>;

function getBatchMetadata(
  { metadata, descriptor }: BatchResources,
  ready: boolean,
) {
  const groups = metadata
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
    });
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
  const { grants, descriptor, saveFailed, continued } = resources;
  const chosenGrants = grants;
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
  const callbackFailed = allowed && !continued && saveFailed;

  return { allowedCount, allowed, callbackFailed, chosenGrants };
}

function useBatchState(signals: PermissionBatchSignals) {
  const resources = useBatchResources(signals);
  const { ready, loadFailed } = resources;
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
          {standalone && agent !== null && (
            <>
              <p className="text-center text-lg font-medium leading-7 text-foreground">
                {t(
                  ($) => {
                    return $.authorization.permission.greeting;
                  },
                  {
                    userName:
                      user !== null
                        ? (user?.firstName ??
                          user?.username ??
                          t(($) => {
                            return $.authorization.permission.userFallback;
                          }))
                        : t(($) => {
                            return $.authorization.permission.userFallback;
                          }),
                    targetName: agent.displayName ?? descriptor.agentId,
                  },
                )}
              </p>
              <div className="flex w-full items-center gap-2 rounded-lg border border-border bg-muted/30 py-3 pl-2 pr-8">
                <AvatarFromUrl
                  avatarUrl={agent.avatarUrl ?? null}
                  alt=""
                  className="h-10 w-10 shrink-0 rounded-full object-cover object-top"
                />
                <span className="text-sm font-medium text-foreground">
                  {agent.displayName ?? descriptor.agentId}
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
                      {item.permission === UNKNOWN_PERMISSION_GRANT
                        ? t(($) => {
                            return $.chat.permissions.otherEndpoints;
                          })
                        : item.permission}
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
    saveFailed,
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
      {saveFailed && !allowed && (
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
    saveFailed,
    confirm,
    descriptor,
    dismiss,
  } = batch;
  return (
    <>
      {!allowed && (
        <Button
          type="button"
          disabled={busy || loadFailed || !complete || saveFailed}
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

function BatchCardDescription({
  batch,
  failed,
}: BatchViewProps & { failed: boolean }) {
  const { t } = useTranslation();
  const {
    allowed,
    allowedCount,
    callbackFailed,
    complete,
    continued,
    descriptor,
    groups,
    loadFailed,
    ready,
    saveFailed,
  } = batch;
  const description =
    loadFailed || (ready && !complete)
      ? t(($) => {
          return $.authorization.permissionBatch.loadFailed;
        })
      : callbackFailed
        ? t(($) => {
            return $.authorization.permissionBatch.continueFailed;
          })
        : saveFailed && !allowed
          ? t(($) => {
              return $.authorization.permission.errors.updateFailed;
            })
          : !ready
            ? t(($) => {
                return $.authorization.permissionBatch.loading;
              })
            : continued && allowed
              ? t(($) => {
                  return $.authorization.permissionBatch.continued;
                })
              : [
                  t(
                    ($) => {
                      return $.authorization.permissionBatch.allowedCount;
                    },
                    { allowed: allowedCount, total: descriptor.items.length },
                  ),
                  groups
                    .map(({ connector }) => {
                      return connector.label;
                    })
                    .join(", "),
                ].join(" · ");
  return (
    <p
      className={cn(
        "mt-0.5 line-clamp-2 text-sm leading-5",
        failed ? "text-destructive" : "text-muted-foreground",
      )}
    >
      {description}
    </p>
  );
}

function BatchCardSummary({ batch }: BatchViewProps) {
  const { t } = useTranslation();
  const {
    allowed,
    busy,
    callbackFailed,
    complete,
    loadFailed,
    ready,
    saveFailed,
  } = batch;
  const failed =
    loadFailed ||
    (ready && !complete) ||
    (!allowed && saveFailed) ||
    callbackFailed;
  return (
    <div className="flex h-full w-full flex-col justify-between gap-3 px-4 py-3 text-left @[640px]:flex-row @[640px]:items-center">
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-gray-50 text-muted-foreground">
          {failed ? (
            <AlertCircle size={22} className="text-destructive" />
          ) : busy || !ready ? (
            <Loader2 size={22} className="animate-spin" />
          ) : allowed ? (
            <Check size={22} className="text-green-600" />
          ) : (
            <ShieldCheck size={22} />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[0.9375rem] font-medium leading-5 text-foreground">
            {allowed
              ? t(($) => {
                  return $.authorization.permissionBatch.allowed;
                })
              : t(($) => {
                  return $.authorization.permissionBatch.title;
                })}
          </div>
          <BatchCardDescription batch={batch} failed={failed} />
        </div>
      </div>
      <DialogTrigger
        render={
          <Button
            type="button"
            variant="neutral"
            size="sm"
            className="shrink-0 self-end @[640px]:self-auto"
          />
        }
      >
        {allowed
          ? t(($) => {
              return $.authorization.permissionBatch.details;
            })
          : t(($) => {
              return $.authorization.permissionBatch.review;
            })}
      </DialogTrigger>
    </div>
  );
}

function BatchDialog({ batch, href }: BatchViewProps & { href: string }) {
  const { t } = useTranslation();
  return (
    <Dialog>
      <BatchCardSummary batch={batch} />
      <DialogContent maxWidth={640} showCloseButton={false}>
        <DialogHeader className="flex-row items-center gap-3 space-y-0 text-left">
          <DialogTitle className="min-w-0 flex-1 leading-6">
            {t(($) => {
              return $.authorization.permissionBatch.title;
            })}
          </DialogTitle>
          {/* Initial focus stays above the list instead of scrolling to duration. */}
          <DialogClose
            render={
              <IconButton
                className="shrink-0"
                aria-label={t(($) => {
                  return $.connectors.actions.close;
                })}
              />
            }
          >
            <X size={20} />
          </DialogClose>
        </DialogHeader>
        {batch.allowed && <BatchHeader batch={batch} standalone={false} />}
        <BatchPermissionDetails batch={batch} />
        <BatchFeedback batch={batch} />
        <BatchActions batch={batch} standalone={false} />
        <a
          href={href}
          className="break-words text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
        >
          {t(($) => {
            return $.authorization.permissionBatch.details;
          })}
        </a>
      </DialogContent>
    </Dialog>
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
  if (!standalone) {
    // Keep operation state mounted across dialog closes and asynchronous updates.
    return <BatchDialog batch={batch} href={signals.href} />;
  }
  return (
    <div className="flex w-full min-w-0 flex-col gap-4">
      <BatchHeader batch={batch} standalone={standalone} />
      <BatchPermissionDetails batch={batch} />
      <BatchFeedback batch={batch} />
      <BatchActions batch={batch} standalone={standalone} />
    </div>
  );
}
