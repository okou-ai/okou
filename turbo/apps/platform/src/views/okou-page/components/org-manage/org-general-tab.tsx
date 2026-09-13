// TODO(#8609): split large components to comply with max-lines-per-function (128)
// oxlint-disable max-lines-per-function
import { useLoadable, useGet, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import { Upload } from "lucide-react";
import {
  Input,
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@okouai/ui";
import { toast } from "@okouai/ui/components/ui/sonner";
import type { OrgResponse } from "@okouai/api-contracts/contracts/orgs";
import { org$, isOrgAdmin$ } from "../../../../signals/org.ts";
import { detach, onDomEventFn, Reason } from "../../../../signals/utils.ts";
import { settingsDialogSignal$ } from "../../../../signals/okou-page/settings/settings-dialog.ts";
import {
  clearPendingLogo$,
  profileName$,
  setProfileName$,
  profileLogoUrl$,
  pendingLogoFile$,
  pendingLogoPreview$,
  setPendingLogo$,
  fileInputEl$,
  setFileInputEl$,
  logoLoaded$,
  setLogoLoaded$,
  deleteConfirm$,
  setDeleteConfirm$,
  resetDeleteConfirm$,
  loadOrgLogo$,
  saveOrgProfile$,
  leaveOrg$,
  deleteOrg$,
  WORKSPACE_DELETE_CONFIRMATION,
} from "../../../../signals/okou-page/settings/workspace-settings-state.ts";
import { readImageDimensions } from "./read-image-dimensions.ts";

const sectionCardStyle = {
  border: "var(--border-width-surface) solid hsl(var(--gray-400))",
} as const;

const MIN_LOGO_DIMENSION = 100;
const MAX_LOGO_DIMENSION = 4096;

function ProfileSection({
  org,
  isAdmin,
}: {
  org: OrgResponse;
  isAdmin: boolean;
}) {
  const { t } = useTranslation();
  const name = useGet(profileName$);
  const setName = useSet(setProfileName$);

  const [saveLoadable, saveProfile] = useLoadableSet(saveOrgProfile$);
  const saving = saveLoadable.state === "loading";

  const logoUrl = useGet(profileLogoUrl$);

  const pendingLogoFile = useGet(pendingLogoFile$);
  const pendingLogoPreview = useGet(pendingLogoPreview$);
  const setPendingLogo = useSet(setPendingLogo$);
  const clearPendingLogo = useSet(clearPendingLogo$);

  const fileInputEl = useGet(fileInputEl$);
  const setFileInputEl = useSet(setFileInputEl$);

  const modalSignal = useGet(settingsDialogSignal$);

  const logoLoaded = useGet(logoLoaded$);
  const setLogoLoaded = useSet(setLogoLoaded$);
  const loadOrgLogo = useSet(loadOrgLogo$);
  const hasNameChange = name !== (org.name ?? "");
  const hasChanges = hasNameChange || !!pendingLogoFile;

  const handleFileSelect = async (file: File) => {
    if (!modalSignal) {
      return;
    }
    const dimensions = await readImageDimensions(file, modalSignal);
    modalSignal.throwIfAborted();
    if (!dimensions) {
      toast.error(
        t(($) => {
          return $.settings.workspace.validation.imageUnreadable;
        }),
      );
      return;
    }
    const { width, height } = dimensions;
    if (width < MIN_LOGO_DIMENSION || height < MIN_LOGO_DIMENSION) {
      toast.error(
        t(
          ($) => {
            return $.settings.workspace.validation.logoTooSmall;
          },
          {
            width,
            height,
            minimum: MIN_LOGO_DIMENSION,
          },
        ),
      );
      return;
    }
    if (width > MAX_LOGO_DIMENSION || height > MAX_LOGO_DIMENSION) {
      toast.error(
        t(
          ($) => {
            return $.settings.workspace.validation.logoTooLarge;
          },
          {
            width,
            height,
            maximum: MAX_LOGO_DIMENSION,
          },
        ),
      );
      return;
    }
    setPendingLogo(file, modalSignal);
  };

  const handleDiscard = () => {
    setName(org.name ?? "");
    clearPendingLogo();
  };

  const handleSave = async () => {
    if (!hasChanges || saving || !modalSignal) {
      return;
    }
    await saveProfile(
      {
        name,
        logoFile: pendingLogoFile,
      },
      modalSignal,
    );
  };

  const handleLogoLoad = () => {
    if (logoLoaded || !modalSignal) {
      return;
    }
    setLogoLoaded(true);
    detach(loadOrgLogo(modalSignal), Reason.DomCallback);
  };

  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-sm font-medium text-foreground">
        {t(($) => {
          return $.settings.workspace.profile.sectionTitle;
        })}
      </h3>
      <div
        className="overflow-hidden rounded-xl bg-card"
        style={sectionCardStyle}
      >
        {/* Logo row */}
        <div className="flex items-center justify-between gap-4 px-5 py-4">
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">
              {t(($) => {
                return $.settings.workspace.profile.logo.title;
              })}
            </p>
            <p className="text-[13px] text-muted-foreground mt-0.5">
              {t(($) => {
                return $.settings.workspace.profile.logo.description;
              })}
            </p>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            {isAdmin && (
              <input
                ref={setFileInputEl}
                type="file"
                aria-label={t(($) => {
                  return $.settings.workspace.profile.logo.upload;
                })}
                accept="image/png,image/jpeg,image/gif,image/webp"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) {
                    detach(handleFileSelect(file), Reason.DomCallback);
                  }
                  e.target.value = "";
                }}
              />
            )}
            <button
              type="button"
              ref={(el) => {
                if (el) {
                  handleLogoLoad();
                }
              }}
              className="group relative h-9 w-9 shrink-0 rounded-lg overflow-hidden"
              disabled={!isAdmin}
              onClick={() => {
                if (isAdmin) {
                  fileInputEl?.click();
                }
              }}
            >
              {(pendingLogoPreview ?? logoUrl) ? (
                <img
                  src={(pendingLogoPreview ?? logoUrl)!}
                  alt={
                    org.name ||
                    t(($) => {
                      return $.settings.workspace.profile.logo.fallbackAlt;
                    })
                  }
                  className="h-full w-full object-cover"
                />
              ) : (
                <div className="h-full w-full bg-muted/50 animate-pulse" />
              )}
              {isAdmin && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity">
                  <Upload size={14} className="text-white" />
                </div>
              )}
            </button>
          </div>
        </div>
        <div className="h-0 border-t border-t-gray-400 mx-5" />
        {/* Name row */}
        <div className="flex items-center justify-between gap-4 px-5 py-4">
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">
              {t(($) => {
                return $.settings.workspace.profile.name.title;
              })}
            </p>
            <p className="text-[13px] text-muted-foreground mt-0.5">
              {t(($) => {
                return $.settings.workspace.profile.name.description;
              })}
            </p>
          </div>
          {isAdmin ? (
            <Input
              id="org-name"
              value={name}
              onChange={(e) => {
                return setName(e.target.value);
              }}
              placeholder={t(($) => {
                return $.settings.workspace.profile.name.placeholder;
              })}
              className="w-[220px] shrink-0"
            />
          ) : (
            <span className="text-sm text-foreground shrink-0">
              {org.name ?? ""}
            </span>
          )}
        </div>
      </div>

      {hasChanges && isAdmin && (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              className="rounded-lg"
              onClick={onDomEventFn(handleSave)}
              disabled={saving}
            >
              {saving
                ? t(($) => {
                    return $.settings.shared.saving;
                  })
                : t(($) => {
                    return $.settings.shared.saveChanges;
                  })}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="rounded-lg text-muted-foreground"
              onClick={handleDiscard}
              disabled={saving}
            >
              {t(($) => {
                return $.settings.shared.discard;
              })}
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

function DangerZoneSection({ isAdmin }: { isAdmin: boolean }) {
  const { t } = useTranslation();
  const canLeave = !isAdmin;
  const modalSignal = useGet(settingsDialogSignal$);
  const [leaveLoadable, leave] = useLoadableSet(leaveOrg$);
  const [deleteLoadable, deleteWorkspace] = useLoadableSet(deleteOrg$);
  const leaving = leaveLoadable.state === "loading";
  const deleting = deleteLoadable.state === "loading";

  const deleteConfirm = useGet(deleteConfirm$);
  const setDeleteConfirm = useSet(setDeleteConfirm$);
  const resetDeleteConfirm = useSet(resetDeleteConfirm$);

  const handleLeave = async () => {
    if (leaving || !modalSignal) {
      return;
    }
    await leave(modalSignal);
  };

  const handleDelete = async () => {
    if (
      deleting ||
      deleteConfirm !== WORKSPACE_DELETE_CONFIRMATION ||
      !modalSignal
    ) {
      return;
    }
    await deleteWorkspace(modalSignal);
  };

  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-sm font-medium text-foreground">
        {t(($) => {
          return $.settings.workspace.danger.sectionTitle;
        })}
      </h3>
      <div
        className="overflow-hidden rounded-xl bg-card"
        style={sectionCardStyle}
      >
        {canLeave && (
          <>
            {/* Leave workspace */}
            <div className="flex items-center justify-between gap-4 px-5 py-4">
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">
                  {t(($) => {
                    return $.settings.workspace.danger.leave.title;
                  })}
                </p>
                <p className="text-[13px] text-muted-foreground mt-0.5">
                  {t(($) => {
                    return $.settings.workspace.danger.leave.description;
                  })}
                </p>
              </div>
              <Dialog>
                <DialogTrigger asChild>
                  <Button
                    variant="destructive"
                    size="sm"
                    className="shrink-0 gap-1.5"
                  >
                    {t(($) => {
                      return $.settings.workspace.danger.leave.title;
                    })}
                  </Button>
                </DialogTrigger>
                <DialogContent
                  closeLabel={t(($) => {
                    return $.settings.shared.close;
                  })}
                >
                  <DialogHeader>
                    <DialogTitle>
                      {t(($) => {
                        return $.settings.workspace.danger.leave.titleQuestion;
                      })}
                    </DialogTitle>
                    <DialogDescription>
                      {t(($) => {
                        return $.settings.workspace.danger.leave
                          .confirmDescription;
                      })}
                    </DialogDescription>
                  </DialogHeader>
                  <DialogFooter>
                    <DialogClose asChild>
                      <Button variant="outline" size="sm">
                        {t(($) => {
                          return $.settings.shared.cancel;
                        })}
                      </Button>
                    </DialogClose>
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={onDomEventFn(handleLeave)}
                      disabled={leaving}
                    >
                      {leaving
                        ? t(($) => {
                            return $.settings.workspace.danger.leave.progress;
                          })
                        : t(($) => {
                            return $.settings.workspace.danger.leave.title;
                          })}
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </div>
          </>
        )}
        {isAdmin && (
          <>
            {canLeave && (
              <div className="h-0 border-t border-t-gray-400 mx-5" />
            )}
            {/* Delete workspace */}
            <div className="flex items-center justify-between gap-4 px-5 py-4">
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">
                  {t(($) => {
                    return $.settings.workspace.danger.delete.title;
                  })}
                </p>
                <p className="text-[13px] text-muted-foreground mt-0.5">
                  {t(($) => {
                    return $.settings.workspace.danger.delete.description;
                  })}
                </p>
              </div>
              <Dialog
                onOpenChange={() => {
                  // Opening also resets after an org refresh unmounts the dialog.
                  resetDeleteConfirm();
                }}
              >
                <DialogTrigger asChild>
                  <Button
                    variant="destructive"
                    size="sm"
                    className="shrink-0 gap-1.5"
                  >
                    {t(($) => {
                      return $.settings.shared.delete;
                    })}
                  </Button>
                </DialogTrigger>
                <DialogContent
                  closeLabel={t(($) => {
                    return $.settings.shared.close;
                  })}
                >
                  <DialogHeader>
                    <DialogTitle>
                      {t(($) => {
                        return $.settings.workspace.danger.delete.titleQuestion;
                      })}
                    </DialogTitle>
                    <DialogDescription>
                      {t(($) => {
                        return $.settings.workspace.danger.delete
                          .confirmDescription;
                      })}
                    </DialogDescription>
                  </DialogHeader>
                  <p className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-[13px] text-foreground">
                    {t(($) => {
                      return $.settings.workspace.danger.delete
                        .billingDescription;
                    })}
                  </p>
                  <Input
                    placeholder={WORKSPACE_DELETE_CONFIRMATION}
                    value={deleteConfirm}
                    onChange={(e) => {
                      return setDeleteConfirm(e.target.value);
                    }}
                  />
                  <DialogFooter>
                    <DialogClose asChild>
                      <Button variant="outline" size="sm">
                        {t(($) => {
                          return $.settings.shared.cancel;
                        })}
                      </Button>
                    </DialogClose>
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={onDomEventFn(handleDelete)}
                      disabled={
                        deleting ||
                        deleteConfirm !== WORKSPACE_DELETE_CONFIRMATION
                      }
                    >
                      {deleting
                        ? t(($) => {
                            return $.settings.workspace.danger.delete.progress;
                          })
                        : t(($) => {
                            return $.settings.workspace.danger.delete.button;
                          })}
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </div>
          </>
        )}
      </div>
    </section>
  );
}

export function OrgGeneralTab() {
  const orgLoadable = useLoadable(org$);
  const org = orgLoadable.state === "hasData" ? orgLoadable.data : undefined;
  const isLoading = orgLoadable.state === "loading";
  const isAdminLoadable = useLoadable(isOrgAdmin$);
  const isAdmin =
    isAdminLoadable.state === "hasData" ? isAdminLoadable.data : false;

  if (isLoading || !org) {
    return <GeneralTabSkeleton />;
  }

  return (
    <div className="flex flex-col gap-8">
      <ProfileSection org={org} isAdmin={isAdmin} />
      <DangerZoneSection isAdmin={isAdmin} />
    </div>
  );
}

function GeneralTabSkeleton() {
  const { t } = useTranslation();
  return (
    <div
      className="flex flex-col gap-8"
      role="status"
      aria-label={t(($) => {
        return $.settings.shared.loading;
      })}
    >
      {/* Profile section skeleton */}
      <section className="flex flex-col gap-3">
        <div className="h-4 w-12 rounded bg-muted/50 animate-pulse" />
        <div
          className="overflow-hidden rounded-xl bg-card"
          style={sectionCardStyle}
        >
          {/* Logo row */}
          <div className="flex items-center justify-between gap-4 px-5 py-4">
            <div className="min-w-0">
              <div className="h-4 w-8 rounded bg-muted/50 animate-pulse" />
              <div className="h-3 w-48 rounded bg-muted/30 animate-pulse mt-1.5" />
            </div>
            <div className="h-9 w-9 shrink-0 rounded-lg bg-muted/50 animate-pulse" />
          </div>
          <div className="h-0 border-t border-t-gray-400 mx-5" />
          {/* Name row */}
          <div className="flex items-center justify-between gap-4 px-5 py-4">
            <div className="min-w-0">
              <div className="h-4 w-10 rounded bg-muted/50 animate-pulse" />
              <div className="h-3 w-40 rounded bg-muted/30 animate-pulse mt-1.5" />
            </div>
            <div className="h-9 w-[220px] shrink-0 rounded-lg bg-muted/30 animate-pulse" />
          </div>
        </div>
      </section>
      {/* Danger zone skeleton */}
      <section className="flex flex-col gap-3">
        <div className="h-4 w-20 rounded bg-muted/50 animate-pulse" />
        <div
          className="overflow-hidden rounded-xl bg-card"
          style={sectionCardStyle}
        >
          <div className="flex items-center justify-between gap-4 px-5 py-4">
            <div className="min-w-0">
              <div className="h-4 w-28 rounded bg-muted/50 animate-pulse" />
              <div className="h-3 w-64 rounded bg-muted/30 animate-pulse mt-1.5" />
            </div>
            <div className="h-8 w-16 shrink-0 rounded-md bg-muted/30 animate-pulse" />
          </div>
        </div>
      </section>
    </div>
  );
}
