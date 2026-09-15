import { Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { CustomConnectorPermissionBundleResponse } from "@okouai/api-contracts/contracts/custom-connectors";
import {
  Button,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@okouai/ui";
import { useLoadableSet } from "ccstate-react/experimental";
import { useGet, useSet } from "ccstate-react";
import { toast } from "@okouai/ui/components/ui/sonner";

import { pageSignal$ } from "../../../../signals/page-signal.ts";
import {
  customConnectorPermissionDraft$,
  saveCustomConnectorPermissions$,
  setCustomConnectorPermissionDraftValue$,
} from "../../../../signals/okou-page/settings/custom-connector-permissions.ts";
import { detach, Reason } from "../../../../signals/utils.ts";
import { CustomConnectorIcon } from "./custom-connector-icon.tsx";
import { PermissionPolicyToggle } from "./permission-policy-toggle.tsx";

function permissionSelectionsEqual(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
): boolean {
  return (
    left.size === right.size &&
    [...left].every((permissionName) => {
      return right.has(permissionName);
    })
  );
}

function LoadedCustomConnectorPermissions({
  agentId,
  connectorId,
  bundle,
  onClose,
}: {
  readonly agentId: string;
  readonly connectorId: string;
  readonly bundle: CustomConnectorPermissionBundleResponse;
  readonly onClose: () => void;
}) {
  const { t } = useTranslation();
  const draft = useGet(customConnectorPermissionDraft$);
  const setDraftPermission = useSet(setCustomConnectorPermissionDraftValue$);
  const [saveLoadable, save] = useLoadableSet(saveCustomConnectorPermissions$);
  const signal = useGet(pageSignal$);
  const permissions = bundle.permissions.filter((permission) => {
    return bundle.defaultPolicies[permission.name] === "deny";
  });
  const activeDraft =
    draft?.agentId === agentId && draft.connectorId === connectorId
      ? draft
      : null;
  const selected = new Set(activeDraft?.permissionNames ?? []);
  const initialSelections = new Set(activeDraft?.initialPermissionNames ?? []);
  const saving = saveLoadable.state === "loading";
  const changed =
    activeDraft !== null &&
    (!activeDraft.initiallyAuthorized ||
      !permissionSelectionsEqual(selected, initialSelections));

  const setPermission = (permissionName: string, allow: boolean) => {
    setDraftPermission({
      agentId,
      connectorId,
      permissionName,
      allow,
    });
  };

  const handleApply = () => {
    if (!activeDraft || saving || !changed) {
      return;
    }
    detach(
      (async () => {
        await save(
          {
            surface: activeDraft.surface,
            agentId,
            connectorId,
            permissionNames: permissions
              .map((permission) => {
                return permission.name;
              })
              .filter((permissionName) => {
                return selected.has(permissionName);
              }),
          },
          signal,
        );
        toast.success(
          t(($) => {
            return $.connectors.access.permissionsUpdated;
          }),
        );
        onClose();
      })(),
      Reason.DomCallback,
    );
  };

  return (
    <>
      <div className="flex flex-1 flex-col overflow-y-auto -mx-6 px-6">
        {permissions.map((permission) => {
          const allowed = selected.has(permission.name);
          return (
            <div
              key={permission.name}
              className="flex items-center gap-3 border-b border-border/50 py-3 last:border-b-0"
            >
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-foreground">
                  {permission.name}
                </div>
                {permission.description ? (
                  <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
                    {permission.description}
                  </p>
                ) : null}
              </div>
              <PermissionPolicyToggle
                policy={allowed ? "allow" : "deny"}
                disabled={saving}
                onAllow={() => {
                  setPermission(permission.name, true);
                }}
                onDeny={() => {
                  setPermission(permission.name, false);
                }}
              />
            </div>
          );
        })}
      </div>
      <SheetFooter>
        <Button variant="outline" onClick={onClose} disabled={saving}>
          {t(($) => {
            return $.connectors.actions.cancel;
          })}
        </Button>
        <Button onClick={handleApply} disabled={saving || !changed}>
          {saving
            ? t(($) => {
                return $.connectors.actions.saving;
              })
            : t(($) => {
                return $.connectors.actions.apply;
              })}
        </Button>
      </SheetFooter>
    </>
  );
}

export function CustomConnectorPermissionsDrawer({
  agentId,
  connectorId,
  connectorName,
  agentName,
  bundle,
  loading,
  loadError,
  onClose,
}: {
  readonly agentId: string;
  readonly connectorId: string;
  readonly connectorName: string;
  readonly agentName: string;
  readonly bundle: CustomConnectorPermissionBundleResponse | null;
  readonly loading: boolean;
  readonly loadError: boolean;
  readonly onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
    >
      <SheetContent side="right">
        <SheetHeader>
          <div className="flex items-center gap-3">
            <CustomConnectorIcon
              id={connectorId}
              displayName={connectorName}
              size={24}
            />
            <SheetTitle className="text-base">
              {t(
                ($) => {
                  return $.connectors.permissions.title;
                },
                { connector: connectorName },
              )}
              <span className="ml-1 text-sm font-normal text-muted-foreground">
                {t(
                  ($) => {
                    return $.connectors.permissions.forTarget;
                  },
                  { target: agentName },
                )}
              </span>
            </SheetTitle>
          </div>
          <SheetDescription>
            {t(($) => {
              return $.connectors.permissions.descriptionAgent;
            })}
          </SheetDescription>
        </SheetHeader>

        {bundle ? (
          <LoadedCustomConnectorPermissions
            key={connectorId}
            agentId={agentId}
            connectorId={connectorId}
            bundle={bundle}
            onClose={onClose}
          />
        ) : (
          <>
            <div className="flex flex-1 items-center justify-center">
              {loading ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 size={16} className="animate-spin" />
                  {t(($) => {
                    return $.connectors.permissions.loading;
                  })}
                </div>
              ) : (
                <p className="text-sm text-destructive">
                  {loadError
                    ? t(($) => {
                        return $.connectors.permissions.loadError;
                      })
                    : t(
                        ($) => {
                          return $.connectors.permissions.metadataMissing;
                        },
                        { connector: connectorName },
                      )}
                </p>
              )}
            </div>
            <SheetFooter>
              <Button variant="outline" onClick={onClose}>
                {t(($) => {
                  return $.connectors.actions.cancel;
                })}
              </Button>
            </SheetFooter>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
