import type { ReactNode } from "react";
import { useGet, useLastLoadable, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import { Button } from "@okouai/ui";
import { AlertTriangle, Ban, Check, Loader2 } from "lucide-react";
import type { UserPermissionGrantExpiresIn } from "@okouai/api-contracts/contracts/user-permission-grants";
import { UNKNOWN_PERMISSION_GRANT } from "@okouai/connectors/firewall-contracts";
import type {
  PlatformConnectorPermissionMetadata,
  PlatformUserPermissionGrant,
} from "../../signals/connector-domain.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { user$ } from "../../signals/auth.ts";
import {
  findPermissionInMetadata,
  permissionAllowAction$,
  permissionAllowActionParam$,
  permissionAllowAgent$,
  permissionAllowAgentId$,
  permissionAllowExpiresIn$,
  permissionAllowPermission$,
  permissionAllowConnectorSlug$,
  permissionAllowUserPermissionGrants$,
  permissionAllowFirewallPermissionMetadata$,
  resolveUserPermissionGrantPolicy,
  type Permission,
  applyUserPermissionGrant$,
} from "../../signals/permission-allow/permission-allow-signals.ts";
import {
  DEFAULT_USER_PERMISSION_GRANT_EXPIRES_IN,
  permissionGrantExpiresInByScope$,
  permissionGrantExpiryText,
  setPermissionGrantExpiresIn$,
} from "../../signals/permission-allow/permission-grant-expiration.ts";
import { isActiveUserPermissionGrant } from "../../signals/user-permission-grants.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { ProductBrandMark } from "../components/product-brand-mark.tsx";
import { PermissionGrantDurationSelect } from "../components/permission-grant-duration-select.tsx";
import { ConnectorIcon } from "../okou-page/components/settings/connector-icons.tsx";
import { AvatarFromUrl } from "../okou-page/sidebar-shared.tsx";
import {
  routeChatActionCallback$,
  runChatActionCallback$,
  type ChatActionCallback,
} from "../../signals/chat-page/action-callback.ts";
import { i18n } from "../../i18n/index.ts";

function TargetPill({
  avatarUrl,
  displayName,
}: {
  avatarUrl?: string | null;
  displayName: string;
}) {
  return (
    <div className="w-full rounded-lg border border-border bg-muted/30 pl-2 pr-8 py-3 flex items-center gap-2">
      <AvatarFromUrl
        avatarUrl={avatarUrl ?? null}
        alt=""
        className="h-10 w-10 shrink-0 rounded-full object-cover object-top"
      />
      <span className="text-sm font-medium text-foreground">{displayName}</span>
    </div>
  );
}

type PermissionGrantTarget = {
  id: string;
  displayName: string;
  avatarUrl: string | null;
};

type PermissionAllowAgent = {
  displayName?: string | null;
  avatarUrl?: string | null;
} | null;

function resolvePermissionGrantTarget({
  agentId,
  agent,
}: {
  agentId: string;
  agent: PermissionAllowAgent;
}): { target: PermissionGrantTarget } | { message: string } {
  if (!agent) {
    return {
      message: i18n.t(($) => {
        return $.authorization.permission.errors.agentNotFound;
      }),
    };
  }
  return {
    target: {
      id: agentId,
      displayName: agent.displayName ?? agentId,
      avatarUrl: agent.avatarUrl ?? null,
    },
  };
}

function ConnectorPermissionCard({
  icon,
  connectorLabel,
  permission,
  action,
}: {
  icon: PlatformConnectorPermissionMetadata["icon"];
  connectorLabel: string;
  permission: Permission;
  action: "allow" | "deny";
}) {
  return (
    <div className="w-full rounded-lg border border-border px-4 py-3">
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2 border-b border-border/70 pb-4 pt-1">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] bg-muted/40">
            <ConnectorIcon icon={icon} size={20} />
          </span>
          <div className="min-w-0 flex-1 flex flex-col gap-1.5">
            <p className="text-sm font-medium text-foreground">
              {connectorLabel}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 py-2">
          {action === "allow" ? (
            <Check size={20} className="shrink-0 text-green-600 opacity-70" />
          ) : (
            <Ban size={20} className="shrink-0 text-destructive opacity-70" />
          )}
          <span className="min-w-0 flex-1 text-sm text-foreground truncate">
            {permission.description ?? permission.name}
          </span>
          {permission.name !== UNKNOWN_PERMISSION_GRANT && (
            <code className="shrink-0 rounded border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-xs text-sky-700">
              {permission.name}
            </code>
          )}
        </div>
      </div>
    </div>
  );
}

function LoadingCard() {
  return (
    <div className="fixed inset-0 flex h-viewport flex-col items-center overflow-y-auto pt-safe-offset-8 pr-safe-offset-12 pb-safe-offset-8 pl-safe-offset-12 pointer-events-none">
      <div className="pointer-events-auto my-auto flex w-[500px] max-w-full shrink-0 flex-col items-center gap-10 rounded-[20px] border border-border bg-background px-6 py-12">
        <ProductBrandMark />
        <Loader2 size={20} className="animate-spin text-muted-foreground" />
      </div>
    </div>
  );
}

function ResultCard({
  action,
  alreadyApplied = false,
  expiresAt,
  showExpiry,
}: {
  action: "allow" | "deny";
  alreadyApplied?: boolean;
  expiresAt?: string | null;
  showExpiry: boolean;
}) {
  const { t } = useTranslation();
  const allowed = action === "allow";
  const title = alreadyApplied
    ? allowed
      ? t(($) => {
          return $.authorization.permission.result.alreadyAllowedTitle;
        })
      : t(($) => {
          return $.authorization.permission.result.alreadyDeniedTitle;
        })
    : allowed
      ? t(($) => {
          return $.authorization.permission.result.updatedTitle;
        })
      : t(($) => {
          return $.authorization.permission.result.deniedTitle;
        });
  const description = alreadyApplied
    ? allowed
      ? t(($) => {
          return $.authorization.permission.result.alreadyAllowedDescription;
        })
      : t(($) => {
          return $.authorization.permission.result.alreadyDeniedDescription;
        })
    : allowed
      ? t(($) => {
          return $.authorization.permission.result.updatedDescription;
        })
      : t(($) => {
          return $.authorization.permission.result.deniedDescription;
        });
  const expiryText = showExpiry
    ? permissionGrantExpiryText(expiresAt ?? null)
    : null;
  return (
    <div className="fixed inset-0 flex h-viewport flex-col items-center overflow-y-auto pt-safe-offset-8 pr-safe-offset-12 pb-safe-offset-8 pl-safe-offset-12 pointer-events-none">
      <div className="pointer-events-auto my-auto flex w-[500px] max-w-full shrink-0 flex-col items-center gap-10 rounded-[20px] border border-border bg-background px-[50px] py-12">
        <ProductBrandMark />
        <div className="flex flex-col items-center gap-4">
          {allowed ? (
            <Check size={40} className="text-green-600 opacity-70" />
          ) : (
            <Ban size={40} className="text-destructive opacity-70" />
          )}
          <p className="text-center text-lg font-medium leading-7 text-foreground">
            {title}
          </p>
          <p className="text-center text-sm text-muted-foreground">
            {description}
          </p>
          {expiryText && (
            <p className="text-center text-xs font-medium text-amber-700 dark:text-amber-400">
              {expiryText}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function StatusMessage({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-1 items-center justify-center text-muted-foreground">
      {children}
    </div>
  );
}

function ErrorMessage({ message }: { message: string }) {
  return (
    <StatusMessage>
      <div className="flex flex-col items-center gap-2">
        <AlertTriangle size={24} />
        <p className="text-sm">{message}</p>
      </div>
    </StatusMessage>
  );
}

function resolveUserName(
  user: { firstName?: string | null; username?: string | null } | undefined,
): string {
  if (user?.firstName) {
    return user.firstName;
  }
  if (user?.username) {
    return user.username;
  }
  return i18n.t(($) => {
    return $.authorization.permission.userFallback;
  });
}

function anyLoadableIsLoading(
  loadables: readonly { state: string }[],
): boolean {
  return loadables.some((loadable) => {
    return loadable.state === "loading";
  });
}

function permissionAllowLoadErrorMessage({
  targetState,
  grantsState,
  metadataState,
}: {
  targetState: string;
  grantsState: string;
  metadataState: string;
}): string | null {
  if (targetState === "hasError") {
    return i18n.t(($) => {
      return $.authorization.permission.errors.loadAgent;
    });
  }
  if (grantsState === "hasError") {
    return i18n.t(($) => {
      return $.authorization.permission.errors.loadGrants;
    });
  }
  if (metadataState === "hasError") {
    return i18n.t(($) => {
      return $.authorization.permission.errors.loadMetadata;
    });
  }
  return null;
}

function resolveExistingPermissionGrantResult({
  action,
  connectorSlug,
  focusedPermission,
  grants,
  metadata,
}: {
  action: "allow" | "deny";
  connectorSlug: string;
  focusedPermission: Permission;
  grants: readonly PlatformUserPermissionGrant[];
  metadata: PlatformConnectorPermissionMetadata;
}): { expiresAt?: string | null } | null {
  const effectivePolicy = resolveUserPermissionGrantPolicy(
    grants,
    metadata,
    focusedPermission.name,
  );
  const explicitGrant = grants.find((grant) => {
    return (
      grant.connectorSlug === connectorSlug &&
      grant.permission === focusedPermission.name &&
      grant.action === action
    );
  });

  if (effectivePolicy !== action) {
    return null;
  }
  return {
    expiresAt:
      explicitGrant && isActiveUserPermissionGrant(explicitGrant)
        ? explicitGrant.expiresAt
        : null,
  };
}

interface ConfirmGrantCardProps {
  target: PermissionGrantTarget;
  icon: PlatformConnectorPermissionMetadata["icon"];
  connectorSlug: string;
  connectorLabel: string;
  permission: Permission;
  action: "allow" | "deny";
  initialExpiresIn: UserPermissionGrantExpiresIn | null;
  userName: string;
  grantLoadable: { state: string };
  applyGrant: (
    params: {
      agentId: string;
      connectorSlug: string;
      permission: string;
      action: "allow" | "deny";
      expiresIn?: UserPermissionGrantExpiresIn;
    },
    signal: AbortSignal,
  ) => Promise<PlatformUserPermissionGrant>;
  actionCallback: ChatActionCallback;
}

function GrantDurationField({
  value,
  disabled,
  onChange,
}: {
  value: UserPermissionGrantExpiresIn;
  disabled: boolean;
  onChange: (value: UserPermissionGrantExpiresIn) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex w-full items-center justify-between gap-3 rounded-lg border border-border/70 px-3 py-2">
      <span className="text-sm font-medium text-foreground">
        {t(($) => {
          return $.authorization.permission.duration;
        })}
      </span>
      <PermissionGrantDurationSelect
        value={value}
        onValueChange={onChange}
        disabled={disabled}
        ariaLabel={t(($) => {
          return $.authorization.permission.durationLabel;
        })}
      />
    </div>
  );
}

function ConfirmGrantCard({
  target,
  icon,
  connectorSlug,
  connectorLabel,
  permission,
  action,
  initialExpiresIn,
  userName,
  grantLoadable,
  applyGrant,
  actionCallback,
}: ConfirmGrantCardProps) {
  const { t } = useTranslation();
  const pageSignal = useGet(pageSignal$);
  const durationScope = `agent\u0000${target.id}\u0000${connectorSlug}\u0000${permission.name}\u0000${action}\u0000${initialExpiresIn ?? ""}`;
  const expiresInByScope = useGet(permissionGrantExpiresInByScope$);
  const setExpiresInForScope = useSet(setPermissionGrantExpiresIn$);
  const expiresIn =
    expiresInByScope[durationScope] ??
    initialExpiresIn ??
    DEFAULT_USER_PERMISSION_GRANT_EXPIRES_IN;
  const expirationAvailable = action === "allow";
  const saving = grantLoadable.state === "loading";
  const saveError = grantLoadable.state === "hasError";

  const runCallback = useSet(runChatActionCallback$);
  const handleSave = () => {
    detach(
      (async () => {
        await applyGrant(
          {
            agentId: target.id,
            connectorSlug,
            permission: permission.name,
            action,
            ...(expirationAvailable ? { expiresIn } : {}),
          },
          pageSignal,
        );
        if (actionCallback.callbackPrompt && actionCallback.threadId) {
          await runCallback(
            {
              threadId: actionCallback.threadId,
              agentId: target.id,
              callbackPrompt: actionCallback.callbackPrompt,
            },
            pageSignal,
          );
        }
      })(),
      Reason.DomCallback,
    );
  };

  return (
    <div className="fixed inset-0 flex h-viewport flex-col items-center overflow-y-auto pt-safe-offset-8 pr-safe-offset-6 pb-safe-offset-8 pl-safe-offset-6 pointer-events-none">
      <div className="pointer-events-auto my-auto flex max-w-full shrink-0 flex-col items-center gap-10 rounded-[20px] border border-border bg-background px-6 py-12">
        <ProductBrandMark />

        <div className="flex w-[500px] max-w-full flex-col items-center gap-4 px-[26px]">
          <p className="text-center text-lg font-medium leading-7 text-foreground">
            {t(
              ($) => {
                return $.authorization.permission.greeting;
              },
              { userName, targetName: target.displayName },
            )}
          </p>

          <TargetPill
            avatarUrl={target.avatarUrl}
            displayName={target.displayName}
          />

          <div className="w-full flex flex-col gap-3">
            <p className="text-sm font-medium text-foreground">
              {t(($) => {
                return $.authorization.permission.wouldLike;
              })}
            </p>
            <ConnectorPermissionCard
              icon={icon}
              connectorLabel={connectorLabel}
              permission={permission}
              action={action}
            />
          </div>
          {expirationAvailable && (
            <GrantDurationField
              value={expiresIn}
              disabled={saving}
              onChange={(value) => {
                setExpiresInForScope(durationScope, value);
              }}
            />
          )}
        </div>

        <div className="flex w-[500px] max-w-full flex-col gap-3 px-[26px]">
          {saveError && (
            <div className="flex items-center justify-center gap-2 text-sm font-medium text-destructive">
              <AlertTriangle size={16} />
              <span>
                {t(($) => {
                  return $.authorization.permission.errors.updateFailed;
                })}
              </span>
            </div>
          )}
          <Button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="h-9 w-full rounded-[10px]"
          >
            {saving
              ? t(($) => {
                  return $.authorization.permission.saving;
                })
              : t(($) => {
                  return $.authorization.permission.confirm;
                })}
          </Button>
        </div>
      </div>
    </div>
  );
}

function PermissionAllowDoctorPage({
  agentId,
  connectorSlug,
  permission,
  action,
  initialExpiresIn,
  actionCallback,
}: {
  agentId: string;
  connectorSlug: string;
  permission: string;
  action: "allow" | "deny";
  initialExpiresIn: UserPermissionGrantExpiresIn | null;
  actionCallback: ChatActionCallback;
}) {
  const agentLoadable = useLastLoadable(permissionAllowAgent$);
  const userLoadable = useLastLoadable(user$);
  const grantsLoadable = useLastLoadable(permissionAllowUserPermissionGrants$);
  const metadataLoadable = useLoadable(
    permissionAllowFirewallPermissionMetadata$,
  );
  const [grantLoadable, applyGrant] = useLoadableSet(applyUserPermissionGrant$);
  const grants = grantsLoadable.state === "hasData" ? grantsLoadable.data : [];
  const savedGrant =
    grantLoadable.state === "hasData" ? grantLoadable.data : null;
  if (
    anyLoadableIsLoading([
      agentLoadable,
      userLoadable,
      grantsLoadable,
      metadataLoadable,
    ])
  ) {
    return <LoadingCard />;
  }

  const loadErrorMessage = permissionAllowLoadErrorMessage({
    targetState: agentLoadable.state,
    grantsState: grantsLoadable.state,
    metadataState: metadataLoadable.state,
  });
  if (loadErrorMessage) {
    return <ErrorMessage message={loadErrorMessage} />;
  }

  const agent = agentLoadable.state === "hasData" ? agentLoadable.data : null;
  const targetResult = resolvePermissionGrantTarget({
    agentId,
    agent,
  });
  if ("message" in targetResult) {
    return <ErrorMessage message={targetResult.message} />;
  }

  const metadata =
    metadataLoadable.state === "hasData" ? metadataLoadable.data : null;
  if (!metadata) {
    return (
      <ErrorMessage
        message={i18n.t(
          ($) => {
            return $.authorization.permission.errors.unknownConnector;
          },
          { connector: connectorSlug },
        )}
      />
    );
  }

  const focusedPermission = findPermissionInMetadata(metadata, permission);
  if (!focusedPermission) {
    return (
      <ErrorMessage
        message={i18n.t(
          ($) => {
            return $.authorization.permission.errors.unknownPermission;
          },
          { permission },
        )}
      />
    );
  }

  if (savedGrant && isActiveUserPermissionGrant(savedGrant)) {
    return (
      <ResultCard
        action={action}
        expiresAt={savedGrant.expiresAt}
        showExpiry={action === "allow"}
      />
    );
  }

  const existingGrantResult = resolveExistingPermissionGrantResult({
    action,
    connectorSlug,
    focusedPermission,
    grants,
    metadata,
  });
  if (existingGrantResult) {
    return (
      <ResultCard
        action={action}
        alreadyApplied
        expiresAt={existingGrantResult.expiresAt}
        showExpiry={action === "allow"}
      />
    );
  }

  const currentUser =
    userLoadable.state === "hasData" ? userLoadable.data : undefined;
  return (
    <ConfirmGrantCard
      target={targetResult.target}
      icon={metadata.icon}
      connectorSlug={connectorSlug}
      connectorLabel={metadata.label}
      permission={focusedPermission}
      action={action}
      initialExpiresIn={initialExpiresIn}
      userName={resolveUserName(currentUser)}
      grantLoadable={grantLoadable}
      applyGrant={applyGrant}
      actionCallback={actionCallback}
    />
  );
}

export function PermissionAllowPage() {
  const { t } = useTranslation();
  const agentId = useGet(permissionAllowAgentId$);
  const connectorSlug = useGet(permissionAllowConnectorSlug$);
  const permission = useGet(permissionAllowPermission$);
  const actionParam = useGet(permissionAllowActionParam$);
  const action = useGet(permissionAllowAction$);
  const expiresIn = useGet(permissionAllowExpiresIn$);
  const actionCallback = useGet(routeChatActionCallback$);

  if (!agentId) {
    return (
      <ErrorMessage
        message={t(($) => {
          return $.authorization.permission.errors.missingAgentId;
        })}
      />
    );
  }

  if (!connectorSlug || !permission) {
    return (
      <ErrorMessage
        message={t(($) => {
          return $.authorization.permission.errors.missingPermission;
        })}
      />
    );
  }

  if (actionParam !== null && action === null) {
    return (
      <ErrorMessage
        message={t(
          ($) => {
            return $.authorization.permission.errors.unknownAction;
          },
          { action: actionParam },
        )}
      />
    );
  }

  return (
    <PermissionAllowDoctorPage
      agentId={agentId}
      connectorSlug={connectorSlug}
      permission={permission}
      action={action ?? "allow"}
      initialExpiresIn={expiresIn}
      actionCallback={actionCallback}
    />
  );
}
