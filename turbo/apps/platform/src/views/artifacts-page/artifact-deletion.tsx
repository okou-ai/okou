import { useGet, useSet } from "ccstate-react";
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
  deleteCatalogArtifact$,
  setArtifactDeleteTarget$,
} from "../../signals/artifacts-page/artifact-deletion.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
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
  const { t } = useTranslation();
  const target = useGet(artifactDeleteTarget$);
  const finalFocus = useSet(artifactDeletionFinalFocus$);
  const setTarget = useSet(setArtifactDeleteTarget$);
  const [deletion, deleteArtifact] = useLoadableSet(deleteCatalogArtifact$);
  const pageSignal = useGet(pageSignal$);
  const busy = deletion.state === "loading";
  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open, details) => {
        if (busy) {
          details.cancel();
        } else if (!open) {
          setTarget(null);
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
          <Button
            variant="destructive"
            disabled={busy}
            onClick={() => {
              detach(
                deleteArtifact(pageSignal),
                Reason.DomCallback,
                "delete artifact",
              );
            }}
          >
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
