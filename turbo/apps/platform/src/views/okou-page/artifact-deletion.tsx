import { useGet, useLoadable, useSet } from "ccstate-react";
import type { ArtifactSummary } from "@okouai/api-contracts/contracts/artifact-catalog";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { useLoadableSet } from "ccstate-react/experimental";
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@okouai/ui";
import { Loader2, MoreHorizontal, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import {
  artifactDeleteTarget$,
  artifactDeletionFinalFocus$,
  artifactPreviewDeletionScope,
  deleteCatalogArtifact$,
  setArtifactDeleteTarget$,
  type PreviewArtifactDeletion,
  type ArtifactDeletionSourceKind,
} from "../../signals/artifact-deletion.ts";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detachedNavigateTo$ } from "../../signals/route.ts";
import { detach, Reason } from "../../signals/utils.ts";
import type { CatalogArtifact } from "../../signals/artifacts-page/create-artifact-catalog-signals.ts";

export function ArtifactDeleteMenu({
  artifact,
}: {
  readonly artifact: CatalogArtifact;
}) {
  const { t } = useTranslation();
  const triggerRef = useSet(artifact.deletion.triggerRef$);
  const requestDeletion = useSet(artifact.deletion.request$);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        ref={triggerRef}
        aria-label={t(
          ($) => {
            return $.artifacts.deletion.menu;
          },
          {
            title: artifact.title,
          },
        )}
        render={
          <Button
            type="button"
            variant="quiet"
            size="icon-sm"
            className="bg-background/90"
          />
        }
      >
        <MoreHorizontal size={16} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          className="text-destructive"
          onClick={requestDeletion}
        >
          <Trash2 size={14} />
          {t(($) => {
            return $.artifacts.deletion.delete;
          })}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function ArtifactDeleteDialog() {
  const target = useGet(artifactDeleteTarget$);
  const finalFocus = useSet(artifactDeletionFinalFocus$);
  const setTarget = useSet(setArtifactDeleteTarget$);
  const [deletion, deleteArtifact] = useLoadableSet(deleteCatalogArtifact$);
  const pageSignal = useGet(pageSignal$);
  return (
    <ArtifactDeleteConfirmation
      target={target}
      busy={deletion.state === "loading"}
      finalFocus={finalFocus}
      onCancel={() => {
        setTarget(null);
      }}
      onConfirm={() => {
        detach(
          deleteArtifact(pageSignal),
          Reason.DomCallback,
          "delete artifact",
        );
      }}
    />
  );
}

export function ArtifactPageDeleteButton({
  artifactId,
  sourceKind,
}: {
  readonly artifactId: string;
  readonly sourceKind: ArtifactDeletionSourceKind;
}) {
  const navigate = useSet(detachedNavigateTo$);
  return (
    <ArtifactDeleteButton
      artifactId={artifactId}
      sourceKind={sourceKind}
      surface="page"
      iconSize={18}
      onDeleted={() => {
        navigate("/artifacts");
      }}
    />
  );
}

/** The toolbar entry stays mounted independently of the owner lookup. */
export function ArtifactPreviewMoreMenu({
  artifactId,
  surface,
  onDeleted,
  iconSize = 16,
}: {
  readonly artifactId?: string;
  readonly surface: "dialog" | "sidebar";
  readonly onDeleted: () => void;
  readonly iconSize?: number;
}) {
  const { t } = useTranslation();
  const enabled = useGet(featureSwitch$)[FeatureSwitchKey.ArtifactDeletion];
  const scope = artifactPreviewDeletionScope(surface);
  const mountRef = useSet(scope.mountRef$);
  const session = useGet(scope.session$);
  const triggerRef = useSet(scope.menuTriggerRef$);
  const menuTrigger = useGet(scope.menuTrigger$);
  const label = t(($) => {
    return $.artifacts.actions.more;
  });
  if (!enabled) {
    return null;
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        ref={triggerRef}
        aria-label={label}
        render={
          <Button
            showTooltip
            aria-label={label}
            variant="quiet"
            size="icon-sm"
          />
        }
      >
        <MoreHorizontal size={iconSize} />
      </DropdownMenuTrigger>
      <span
        key={`mount:${artifactId ?? ""}`}
        ref={mountRef}
        data-artifact-id={artifactId}
        className="contents"
      />
      {artifactId && session?.artifactId === artifactId ? (
        <PreviewArtifactDeleteAction
          key={artifactId}
          session={session}
          onDeleted={onDeleted}
          iconSize={iconSize}
          menuTrigger={menuTrigger}
        />
      ) : (
        <DropdownMenuContent align="end">
          <ArtifactActionStatus
            message={
              artifactId
                ? t(($) => {
                    return $.artifacts.deletion.checking;
                  })
                : t(($) => {
                    return $.artifacts.deletion.noActions;
                  })
            }
          />
        </DropdownMenuContent>
      )}
    </DropdownMenu>
  );
}

function ArtifactActionStatus({ message }: { readonly message: string }) {
  return (
    <div role="status" className="px-2 py-1.5 text-sm text-muted-foreground">
      {message}
    </div>
  );
}

/** Standalone pages retain their owner-only delete button. */
function ArtifactDeleteButton({
  artifactId,
  sourceKind,
  surface,
  onDeleted,
  iconSize = 16,
}: {
  readonly artifactId?: string;
  readonly sourceKind?: ArtifactDeletionSourceKind;
  readonly surface: "dialog" | "sidebar" | "page";
  readonly onDeleted: () => void;
  readonly iconSize?: number;
}) {
  const enabled = useGet(featureSwitch$)[FeatureSwitchKey.ArtifactDeletion];
  const scope = artifactPreviewDeletionScope(surface);
  const mountRef = useSet(scope.mountRef$);
  const session = useGet(scope.session$);
  if (!enabled || !artifactId) {
    return null;
  }
  return (
    <span
      key={artifactId}
      ref={mountRef}
      data-artifact-id={artifactId}
      data-source-kind={sourceKind}
      className="inline-flex"
    >
      {session?.artifactId === artifactId &&
        session.sourceKind === sourceKind && (
          <PreviewArtifactDeleteAction
            key={artifactId}
            session={session}
            onDeleted={onDeleted}
            iconSize={iconSize}
          />
        )}
    </span>
  );
}

function PreviewArtifactDeleteAction({
  session,
  onDeleted,
  iconSize,
  menuTrigger,
}: {
  readonly session: PreviewArtifactDeletion;
  readonly onDeleted: () => void;
  readonly iconSize: number;
  readonly menuTrigger?: HTMLElement | null;
}) {
  const { t } = useTranslation();
  const pageSignal = useGet(pageSignal$);
  const detail = useLoadable(session.detail$);
  const target = useGet(session.target$);
  const requestDeletion = useSet(session.request$);
  const close = useSet(session.close$);
  const finalFocus = useSet(session.finalFocus$);
  const [deletion, confirm] = useLoadableSet(session.confirm$);
  return (
    <>
      {menuTrigger !== undefined ? (
        <DropdownMenuContent align="end">
          {detail.state === "hasData" && detail.data ? (
            <DropdownMenuItem
              className="text-destructive"
              onClick={() => {
                // The menu item unmounts on selection. Return focus to the
                // persistent More trigger when the confirmation is dismissed.
                if (menuTrigger) {
                  detach(
                    requestDeletion(menuTrigger, pageSignal),
                    Reason.DomCallback,
                    "confirm artifact deletion",
                  );
                }
              }}
            >
              <Trash2 size={iconSize} />
              {t(($) => {
                return $.artifacts.deletion.delete;
              })}
            </DropdownMenuItem>
          ) : (
            <ArtifactActionStatus
              message={
                detail.state === "loading"
                  ? t(($) => {
                      return $.artifacts.deletion.checking;
                    })
                  : detail.state === "hasError"
                    ? t(($) => {
                        return $.artifacts.deletion.loadFailed;
                      })
                    : t(($) => {
                        return $.artifacts.deletion.noActions;
                      })
              }
            />
          )}
        </DropdownMenuContent>
      ) : detail.state === "hasData" && detail.data ? (
        <Button
          showTooltip
          type="button"
          variant="quiet"
          size="icon-sm"
          className="shrink-0 text-muted-foreground hover:text-destructive"
          aria-label={t(($) => {
            return $.artifacts.deletion.delete;
          })}
          onClick={(event) => {
            detach(
              requestDeletion(event.currentTarget, pageSignal),
              Reason.DomCallback,
              "confirm artifact deletion",
            );
          }}
        >
          <Trash2 size={iconSize} />
        </Button>
      ) : null}
      <ArtifactDeleteConfirmation
        target={target}
        busy={deletion.state === "loading"}
        finalFocus={finalFocus}
        onCancel={close}
        onConfirm={() => {
          detach(
            confirm(onDeleted, pageSignal),
            Reason.DomCallback,
            "delete preview artifact",
          );
        }}
      />
    </>
  );
}

function ArtifactDeleteConfirmation({
  target,
  busy,
  finalFocus,
  onCancel,
  onConfirm,
}: {
  readonly target: ArtifactSummary | null;
  readonly busy: boolean;
  readonly finalFocus: () => HTMLElement | boolean | null;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open, details) => {
        if (busy) {
          details.cancel();
        } else if (!open) {
          onCancel();
        }
      }}
    >
      <DialogContent
        showCloseButton={!busy}
        closeLabel={t(($) => {
          return $.artifacts.actions.close;
        })}
        finalFocus={finalFocus}
      >
        <DialogHeader>
          <DialogTitle>
            {t(
              ($) => {
                return $.artifacts.deletion.title;
              },
              {
                title: target?.title ?? "",
              },
            )}
          </DialogTitle>
          <DialogDescription>
            {target?.kind === "shared-thread"
              ? t(($) => {
                  return $.artifacts.deletion.sharedDescription;
                })
              : target?.kind === "hosted-site" ||
                  target?.kind === "presentation"
                ? t(($) => {
                    return $.artifacts.deletion.hostedDescription;
                  })
                : t(($) => {
                    return $.artifacts.deletion.description;
                  })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" disabled={busy} />}>
            {t(($) => {
              return $.artifacts.deletion.cancel;
            })}
          </DialogClose>
          <Button variant="destructive" disabled={busy} onClick={onConfirm}>
            {busy && <Loader2 size={14} className="animate-spin" />}
            {busy
              ? t(($) => {
                  return $.artifacts.deletion.deleting;
                })
              : t(($) => {
                  return $.artifacts.deletion.delete;
                })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
