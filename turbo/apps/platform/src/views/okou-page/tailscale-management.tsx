import { useGet, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react";
import {
  Button,
  Checkbox,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  LoadErrorRow,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  surfaceVariants,
} from "@okouai/ui";
import { TAILSCALE_ERROR_CODES } from "@okouai/api-contracts/contracts/tailscale-errors";
import type {
  TailscaleConfig,
  TailscaleImpactPreview,
} from "@okouai/api-contracts/contracts/tailscale";
import {
  acknowledgeTailscale$,
  chooseTailscaleScope$,
  closeTailscaleDialog$,
  mountTailscaleForm$,
  openTailscaleDialog$,
  refreshTailscaleReview$,
  retryTailscale$,
  reviewTailscale$,
  saveTailscale$,
  tailscaleAcknowledged$,
  tailscaleConfigs$,
  tailscaleDialog$,
  tailscaleEnabled$,
  tailscaleError$,
  tailscaleImpact$,
  tailscaleLatestConfig$,
  tailscaleSaveUncertain$,
  tailscaleScope$,
  type TailscaleOperation,
  type TailscaleDialogState,
} from "../../signals/tailscale.ts";
import { localizedTailscaleError } from "../../lib/tailscale-error.ts";
import { isOrgAdmin$ } from "../../signals/org.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { TailscaleFields } from "./tailscale-fields.tsx";

function useOperationCopy(kind: TailscaleOperation | undefined) {
  const { t } = useTranslation();
  switch (kind) {
    case "edit": {
      return {
        title: t(($) => {
          return $.tailscale.edit;
        }),
        description: undefined,
      };
    }
    case "delete": {
      return {
        title: t(($) => {
          return $.tailscale.delete;
        }),
        description: t(($) => {
          return $.tailscale.deleteHelp;
        }),
      };
    }
    case "promote": {
      return {
        title: t(($) => {
          return $.cloudflareAccess.promote;
        }),
        description: t(($) => {
          return $.tailscale.promoteHelp;
        }),
      };
    }
    case "adopt": {
      return {
        title: t(($) => {
          return $.cloudflareAccess.convert;
        }),
        description: t(($) => {
          return $.tailscale.adoptHelp;
        }),
      };
    }
    default: {
      return {
        title: t(($) => {
          return $.tailscale.add;
        }),
        description: undefined,
      };
    }
  }
}

function TailscaleScope({ disabled }: { readonly disabled: boolean }) {
  const { t } = useTranslation();
  const scope = useGet(tailscaleScope$);
  const choose = useSet(chooseTailscaleScope$);
  const signal = useGet(pageSignal$);
  const items = [
    {
      value: "personal",
      label: t(($) => {
        return $.cloudflareAccess.personal;
      }),
    },
    {
      value: "organization",
      label: t(($) => {
        return $.cloudflareAccess.organization;
      }),
    },
  ];
  return (
    <div className="grid gap-2">
      <span id="tailscale-scope-label">
        {t(($) => {
          return $.cloudflareAccess.scope;
        })}
      </span>
      <Select
        items={items}
        value={scope}
        disabled={disabled}
        onValueChange={(value, details) => {
          if (value !== "personal" && value !== "organization") {
            details.cancel();
            return;
          }
          detach(choose(value, signal), Reason.DomCallback);
        }}
      >
        <SelectTrigger aria-labelledby="tailscale-scope-label">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {items.map((item) => {
            return (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
    </div>
  );
}

function TailscaleHostReferences({
  config,
}: {
  readonly config: TailscaleConfig;
}) {
  const { t } = useTranslation();
  return (
    <div className="grid gap-1 text-sm text-muted-foreground">
      <p>
        {config.sshHosts.length
          ? t(
              ($) => {
                return $.cloudflareAccess.usedBy;
              },
              {
                count: config.sshHosts.length,
              },
            )
          : t(($) => {
              return $.cloudflareAccess.unused;
            })}
      </p>
      {config.sshHosts.length > 0 && (
        <ul className="list-inside list-disc">
          {config.sshHosts.map((host) => {
            return <li key={host.id}>{host.displayName}</li>;
          })}
        </ul>
      )}
    </div>
  );
}

function TailscaleImpact({
  preview,
  disabled,
}: {
  readonly preview: TailscaleImpactPreview;
  readonly disabled: boolean;
}) {
  const { t } = useTranslation();
  const acknowledged = useGet(tailscaleAcknowledged$);
  const acknowledge = useSet(acknowledgeTailscale$);
  if (preview.otherHostCount === 0) {
    return null;
  }
  return (
    <div className="grid gap-3 rounded-lg border p-4 text-sm">
      <p>
        {t(
          ($) => {
            return $.cloudflareAccess.impactSummary;
          },
          {
            members: t(
              ($) => {
                return $.cloudflareAccess.affectedMembers;
              },
              {
                count: preview.affectedOwners.length,
              },
            ),
            hosts: t(
              ($) => {
                return $.cloudflareAccess.hostCount;
              },
              {
                count: preview.otherHostCount,
              },
            ),
          },
        )}
      </p>
      {preview.affectedOwners.length > 0 && (
        <ul className="list-inside list-disc">
          {preview.affectedOwners.map((owner) => {
            return (
              <li key={owner.userId}>
                {owner.displayName ??
                  t(($) => {
                    return $.cloudflareAccess.nameUnavailable;
                  })}
                {t(
                  ($) => {
                    return $.cloudflareAccess.memberIdentifier;
                  },
                  {
                    identifier: owner.userId,
                  },
                )}
              </li>
            );
          })}
        </ul>
      )}
      <label className="flex items-start gap-2">
        <Checkbox
          disabled={disabled}
          checked={acknowledged === preview.impactSnapshot}
          onCheckedChange={(checked) => {
            return acknowledge(checked ? preview.impactSnapshot : null);
          }}
        />
        {t(($) => {
          return $.cloudflareAccess.impactConfirm;
        })}
      </label>
    </div>
  );
}

function TailscaleReview({ isSaving }: { readonly isSaving: boolean }) {
  const { t } = useTranslation();
  const error = useGet(tailscaleError$);
  const uncertain = useGet(tailscaleSaveUncertain$);
  const latest = useLoadable(tailscaleLatestConfig$);
  const review = useSet(reviewTailscale$);
  const refresh = useSet(refreshTailscaleReview$);
  const signal = useGet(pageSignal$);
  if (isSaving || (!error && !uncertain)) {
    return null;
  }
  const config = latest.state === "hasData" ? latest.data : null;
  return (
    <div className="grid gap-3 text-sm">
      <p role="alert">
        {uncertain
          ? t(($) => {
              return $.tailscale.uncertain;
            })
          : (localizedTailscaleError(error ?? "") ??
            t(($) => {
              return $.tailscale.failed;
            }))}
      </p>
      {config && (
        <div className="grid gap-2 rounded-lg border p-4">
          <h3 className="font-semibold">
            {t(($) => {
              return $.cloudflareAccess.latest;
            })}
          </h3>
          <p>{config.name}</p>
          <p>{config.tags.join(", ")}</p>
          <TailscaleHostReferences config={config} />
          <p>
            {t(($) => {
              return $.cloudflareAccess.reviewHelp;
            })}
          </p>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              return detach(review(config, signal), Reason.DomCallback);
            }}
          >
            {t(($) => {
              return $.cloudflareAccess.keepChanges;
            })}
          </Button>
        </div>
      )}
      {!config &&
        (latest.state === "hasError" ||
          error === TAILSCALE_ERROR_CODES.IMPACT_CONFLICT) && (
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              return refresh(signal);
            }}
          >
            {t(($) => {
              return $.cloudflareAccess.reviewLatest;
            })}
          </Button>
        )}
    </div>
  );
}

function TailscaleOperationBody({
  config,
  kind,
  disabled,
}: {
  readonly config: TailscaleConfig;
  readonly kind: TailscaleOperation;
  readonly disabled: boolean;
}) {
  const { t } = useTranslation();
  const impact = useLoadable(tailscaleImpact$);
  const acknowledged = useGet(tailscaleAcknowledged$);
  const acknowledge = useSet(acknowledgeTailscale$);
  const refresh = useSet(refreshTailscaleReview$);
  const signal = useGet(pageSignal$);
  return (
    <div className="grid gap-3">
      <p className="font-medium">{config.name}</p>
      <TailscaleHostReferences config={config} />
      {kind === "promote" && (
        <label className="flex items-start gap-2 text-sm">
          <Checkbox
            disabled={disabled}
            checked={acknowledged === "promote"}
            onCheckedChange={(checked) => {
              return acknowledge(checked ? "promote" : null);
            }}
          />
          {t(($) => {
            return $.tailscale.promoteConfirm;
          })}
        </label>
      )}
      {config.scope === "organization" &&
        (kind === "delete" || kind === "adopt") && (
          <>
            {impact.state === "loading" && (
              <p role="status">
                {t(($) => {
                  return $.tailscale.loading;
                })}
              </p>
            )}
            {impact.state === "hasError" && (
              <LoadErrorRow
                message={t(($) => {
                  return $.tailscale.loadFailed;
                })}
                retryLabel={t(($) => {
                  return $.global.actions.tryAgain;
                })}
                onRetry={() => {
                  return refresh(signal);
                }}
              />
            )}
            {impact.state === "hasData" && impact.data && (
              <TailscaleImpact preview={impact.data} disabled={disabled} />
            )}
          </>
        )}
      {kind === "delete" &&
        (config.sshHosts.length > 0 ||
          (impact.state === "hasData" &&
            (impact.data?.ownHostCount ?? 0) > 0)) && (
          <p role="alert" className="text-sm">
            {t(($) => {
              return $.tailscale.inUse;
            })}
          </p>
        )}
    </div>
  );
}

function useOperationBlocked(
  kind: TailscaleOperation | undefined,
  config: TailscaleConfig | null,
) {
  const impact = useLoadable(tailscaleImpact$);
  const acknowledged = useGet(tailscaleAcknowledged$);
  const error = useGet(tailscaleError$);
  if (error && error !== "invalid" && error !== "INVALID_INPUT") {
    return true;
  }
  if (kind === "promote") {
    return acknowledged !== "promote";
  }
  if (kind === "delete" && config?.scope === "personal") {
    return config.sshHosts.length > 0;
  }
  if (
    config?.scope === "organization" &&
    (kind === "delete" || kind === "adopt")
  ) {
    return (
      impact.state !== "hasData" ||
      !impact.data ||
      (impact.data.otherHostCount > 0 &&
        acknowledged !== impact.data.impactSnapshot) ||
      (kind === "delete" && impact.data.ownHostCount > 0)
    );
  }
  return false;
}

function TailscaleFormFields({
  dialog,
  disabled,
}: {
  readonly dialog: TailscaleDialogState;
  readonly disabled: boolean;
}) {
  const admin = useLoadable(isOrgAdmin$);
  const edit = dialog.kind === "create" || dialog.kind === "edit";
  return (
    <>
      {dialog.kind === "create" && admin.state === "hasData" && admin.data && (
        <TailscaleScope disabled={disabled} />
      )}
      {edit ? (
        <fieldset disabled={disabled} className="grid min-w-0 gap-4">
          <TailscaleFields config={dialog.config} disabled={disabled} />
        </fieldset>
      ) : (
        dialog.config && (
          <TailscaleOperationBody
            kind={dialog.kind}
            config={dialog.config}
            disabled={disabled}
          />
        )
      )}
    </>
  );
}

function TailscaleSubmitLabel({
  busy,
  uncertain,
  edit,
  title,
}: {
  readonly busy: boolean;
  readonly uncertain: boolean;
  readonly edit: boolean;
  readonly title: string;
}) {
  const { t } = useTranslation();
  if (busy) {
    return t(($) => {
      return $.connectors.actions.saving;
    });
  }
  if (uncertain) {
    return t(($) => {
      return $.cloudflareAccess.retry;
    });
  }
  return edit
    ? t(($) => {
        return $.cloudflareAccess.save;
      })
    : title;
}

export function TailscaleDialog() {
  const { t } = useTranslation();
  const state = useLoadable(tailscaleDialog$);
  const dialog = state.state === "hasData" ? state.data : null;
  const uncertain = useGet(tailscaleSaveUncertain$);
  const close = useSet(closeTailscaleDialog$);
  const mount = useSet(mountTailscaleForm$);
  const [saving, save] = useLoadableSet(saveTailscale$);
  const signal = useGet(pageSignal$);
  const { title, description } = useOperationCopy(dialog?.kind);
  const blocked = useOperationBlocked(dialog?.kind, dialog?.config ?? null);
  if (!dialog) {
    return null;
  }
  const busy = saving.state === "loading";
  const edit = dialog.kind === "create" || dialog.kind === "edit";
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          close();
        }
      }}
    >
      <DialogContent
        contentClassName="flex flex-col"
        key={`${dialog.identity}:${dialog.kind}:${dialog.config?.id ?? "new"}`}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <form
          ref={mount}
          autoComplete="off"
          className="flex min-h-0 min-w-0 flex-col gap-4"
          aria-busy={busy}
          onSubmit={(event) => {
            event.preventDefault();
            if (!busy && (uncertain || !blocked)) {
              detach(save(event.currentTarget, signal), Reason.DomCallback);
            }
          }}
        >
          <DialogBody className="grid gap-4">
            <TailscaleFormFields dialog={dialog} disabled={busy || uncertain} />
            <TailscaleReview isSaving={busy} />
          </DialogBody>
          <div className="flex shrink-0 justify-end gap-2">
            <Button type="button" variant="outline" onClick={close}>
              {t(($) => {
                return $.cloudflareAccess.cancel;
              })}
            </Button>
            <Button
              type="submit"
              disabled={busy || (!uncertain && blocked)}
              variant={dialog.kind === "delete" ? "destructive" : "default"}
            >
              <TailscaleSubmitLabel
                busy={busy}
                uncertain={uncertain}
                edit={edit}
                title={title}
              />
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function TailscaleSection({
  scope,
  configs,
  admin,
}: {
  readonly scope: "personal" | "organization";
  readonly configs: readonly TailscaleConfig[];
  readonly admin: boolean;
}) {
  const { t } = useTranslation();
  const open = useSet(openTailscaleDialog$);
  const signal = useGet(pageSignal$);
  const canManage = scope === "personal" || admin;
  return (
    <section
      className="grid gap-3"
      aria-label={
        scope === "personal"
          ? t(($) => {
              return $.cloudflareAccess.personal;
            })
          : t(($) => {
              return $.cloudflareAccess.organization;
            })
      }
    >
      <h3 className="text-base font-semibold">
        {scope === "personal"
          ? t(($) => {
              return $.cloudflareAccess.personal;
            })
          : t(($) => {
              return $.cloudflareAccess.organization;
            })}
      </h3>
      {configs.length === 0 && (
        <p className="rounded-xl border border-dashed p-6 text-sm text-muted-foreground">
          {t(($) => {
            return $.cloudflareAccess.sectionEmpty;
          })}
        </p>
      )}
      {configs.map((config) => {
        return (
          <article
            key={config.id}
            className={surfaceVariants({ className: "grid gap-3 p-5" })}
          >
            <h4 className="font-semibold">{config.name}</h4>
            <p className="text-sm text-muted-foreground">
              {config.tags.join(", ")}
            </p>
            <TailscaleHostReferences config={config} />
            {canManage && (
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    return detach(
                      open("edit", config, signal),
                      Reason.DomCallback,
                    );
                  }}
                >
                  {t(($) => {
                    return $.tailscale.edit;
                  })}
                </Button>
                {admin && (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      return detach(
                        open(
                          scope === "personal" ? "promote" : "adopt",
                          config,
                          signal,
                        ),
                        Reason.DomCallback,
                      );
                    }}
                  >
                    {scope === "personal"
                      ? t(($) => {
                          return $.cloudflareAccess.promote;
                        })
                      : t(($) => {
                          return $.cloudflareAccess.convert;
                        })}
                  </Button>
                )}
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    return detach(
                      open("delete", config, signal),
                      Reason.DomCallback,
                    );
                  }}
                >
                  {t(($) => {
                    return $.tailscale.delete;
                  })}
                </Button>
              </div>
            )}
          </article>
        );
      })}
    </section>
  );
}

export function TailscaleManagement() {
  const { t } = useTranslation();
  const enabled = useGet(tailscaleEnabled$);
  const configs = useLoadable(tailscaleConfigs$);
  const admin = useLoadable(isOrgAdmin$);
  const open = useSet(openTailscaleDialog$);
  const retry = useSet(retryTailscale$);
  const signal = useGet(pageSignal$);
  if (!enabled) {
    return null;
  }
  return (
    <section
      className="grid gap-4"
      aria-label={t(($) => {
        return $.tailscale.title;
      })}
    >
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-medium">
          {t(($) => {
            return $.tailscale.title;
          })}
        </h2>
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            return detach(open("create", null, signal), Reason.DomCallback);
          }}
        >
          <Plus size={16} aria-hidden="true" />
          {t(($) => {
            return $.tailscale.add;
          })}
        </Button>
      </div>
      {configs.state === "loading" && (
        <p role="status">
          {t(($) => {
            return $.tailscale.loading;
          })}
        </p>
      )}
      {configs.state === "hasError" && (
        <LoadErrorRow
          message={t(($) => {
            return $.tailscale.loadFailed;
          })}
          retryLabel={t(($) => {
            return $.global.actions.tryAgain;
          })}
          onRetry={() => {
            return retry(signal);
          }}
        />
      )}
      {configs.state === "hasData" && configs.data && (
        <>
          <TailscaleSection
            scope="personal"
            configs={configs.data.filter((config) => {
              return config.scope === "personal";
            })}
            admin={admin.state === "hasData" && admin.data}
          />
          <TailscaleSection
            scope="organization"
            configs={configs.data.filter((config) => {
              return config.scope === "organization";
            })}
            admin={admin.state === "hasData" && admin.data}
          />
        </>
      )}
      <TailscaleDialog />
    </section>
  );
}
