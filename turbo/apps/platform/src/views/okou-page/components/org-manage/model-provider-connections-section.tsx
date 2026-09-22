import { useGet, useLastResolved, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import { Cable, EllipsisVertical, Pencil, Plus, Trash } from "lucide-react";
import {
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Input,
  Textarea,
} from "@okouai/ui";
import type {
  ModelProviderConnectionResponse,
  ModelProviderSurfaceProtocol,
} from "@okouai/api-contracts/contracts/model-provider-gateways";

import {
  deleteModelProviderConnection$,
  modelProviderConnections$,
} from "../../../../signals/external/model-provider-connections.ts";
import {
  closeDeleteModelProviderConnection$,
  closeModelProviderConnection$,
  completeModelProviderConnectionClose$,
  modelProviderConnectionDialogSignal$,
  modelProviderConnectionDraft$,
  openCreateModelProviderConnection$,
  openDeleteModelProviderConnection$,
  openEditModelProviderConnection$,
  pendingDeleteModelProviderConnection$,
  saveModelProviderConnection$,
  toggleModelProviderSurface$,
  updateModelProviderConnectionField$,
  updateModelProviderSurfaceField$,
  type ModelProviderConnectionTemplate,
} from "../../../../signals/okou-page/settings/model-provider-connections.ts";
import { settingsDialogSignal$ } from "../../../../signals/okou-page/settings/settings-dialog.ts";
import { pageSignal$ } from "../../../../signals/page-signal.ts";
import { detach, Reason } from "../../../../signals/utils.ts";
import { CustomConnectorIcon } from "../settings/custom-connector-icon.tsx";
import { SettingsSectionHeading } from "../settings/settings-section-heading.tsx";

const ZERO_BORDER = {
  border: "var(--border-width-surface) solid hsl(var(--gray-400))",
} as const;

function AddConnectionMenu() {
  const { t } = useTranslation();
  const openCreate = useSet(openCreateModelProviderConnection$);
  const settingsDialogSignal = useGet(settingsDialogSignal$);
  const templateLabels: Record<ModelProviderConnectionTemplate, string> = {
    custom: t(($) => {
      return $.settings.models.gateways.presets.custom;
    }),
    fireworks: t(($) => {
      return $.settings.models.gateways.presets.fireworks;
    }),
    openrouter: t(($) => {
      return $.settings.models.gateways.presets.openrouter;
    }),
    vercel: t(($) => {
      return $.settings.models.gateways.presets.vercel;
    }),
  };
  const templates: ModelProviderConnectionTemplate[] = [
    "custom",
    "vercel",
    "openrouter",
    "fireworks",
  ];
  if (!settingsDialogSignal) {
    return null;
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="neutral"
            size="sm"
            className="h-9 gap-2 rounded-lg"
          />
        }
      >
        <Plus size={14} />
        {t(($) => {
          return $.settings.models.gateways.add;
        })}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {templates.map((template) => {
          return (
            <DropdownMenuItem
              key={template}
              onClick={() => {
                openCreate(template, settingsDialogSignal);
              }}
            >
              {templateLabels[template]}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ConnectionRow({
  connection,
}: {
  connection: ModelProviderConnectionResponse;
}) {
  const { t } = useTranslation();
  const openEdit = useSet(openEditModelProviderConnection$);
  const openDelete = useSet(openDeleteModelProviderConnection$);
  const settingsDialogSignal = useGet(settingsDialogSignal$);
  if (!settingsDialogSignal) {
    return null;
  }
  const protocols = connection.surfaces
    .map((surface) => {
      return surface.protocol === "anthropic-messages"
        ? t(($) => {
            return $.settings.models.gateways.protocols.anthropicMessages;
          })
        : t(($) => {
            return $.settings.models.gateways.protocols.openaiResponses;
          });
    })
    .join(" · ");
  return (
    <div
      data-testid={`model-provider-connection-row-${connection.id}`}
      className="relative grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 rounded-lg px-3 py-3.5 transition-colors after:pointer-events-none after:absolute after:bottom-0 after:left-[3.75rem] after:right-3 after:h-px after:bg-divider/50 after:content-[''] last:after:hidden hover:bg-gray-50 dark:hover:bg-gray-100 lg:grid-cols-[minmax(0,1fr)_236px_96px_36px]"
    >
      <div className="col-start-1 row-start-1 flex min-w-0 items-center gap-2">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-gray-50 dark:bg-gray-100">
          <CustomConnectorIcon
            id={connection.id}
            displayName={connection.displayName}
            size={22}
          />
        </span>
        <p className="min-w-0 truncate text-sm font-medium text-foreground">
          {connection.displayName}
        </p>
      </div>
      <div className="col-start-2 row-start-1 flex items-center justify-end lg:col-start-4">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                showTooltip
                type="button"
                variant="quiet"
                size="icon-sm"
                className="shrink-0 rounded-lg"
                aria-label={t(($) => {
                  return $.settings.models.gateways.actions;
                })}
              />
            }
          >
            <EllipsisVertical size={15} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              onClick={() => {
                openEdit(connection, settingsDialogSignal);
              }}
            >
              <Pencil size={14} />
              {t(($) => {
                return $.settings.shared.edit;
              })}
            </DropdownMenuItem>
            <DropdownMenuItem
              className="text-destructive focus:text-destructive"
              onClick={() => {
                openDelete(connection);
              }}
            >
              <Trash size={14} />
              {t(($) => {
                return $.settings.shared.delete;
              })}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="col-start-1 row-start-2 flex min-w-0 items-center lg:col-start-2 lg:row-start-1">
        <div className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
          <span className="flex size-7 shrink-0 items-center justify-center">
            <Cable size={16} />
          </span>
          <span className="min-w-0 truncate">{protocols}</span>
        </div>
      </div>
    </div>
  );
}

function DeleteConnectionDialog() {
  const { t } = useTranslation();
  const connection = useGet(pendingDeleteModelProviderConnection$);
  const close = useSet(closeDeleteModelProviderConnection$);
  const pageSignal = useGet(pageSignal$);
  const [deleteLoadable, deleteConnection] = useLoadableSet(
    deleteModelProviderConnection$,
  );
  const deleting = deleteLoadable.state === "loading";
  const onConfirm = () => {
    if (!connection) {
      return;
    }
    detach(
      (async () => {
        await deleteConnection(connection.id, pageSignal);
        pageSignal.throwIfAborted();
        close();
      })(),
      Reason.DomCallback,
    );
  };
  return (
    <Dialog
      open={connection !== null}
      onOpenChange={(open) => {
        if (!open && !deleting) {
          close();
        }
      }}
    >
      <DialogContent maxWidth="md">
        <DialogHeader>
          <DialogTitle>
            {t(($) => {
              return $.settings.shared.delete;
            })}{" "}
            {connection?.displayName}?
          </DialogTitle>
          <DialogDescription>
            {t(($) => {
              return $.settings.models.gateways.deleteConfirm;
            })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={close} disabled={deleting}>
            {t(($) => {
              return $.settings.shared.cancel;
            })}
          </Button>
          <Button variant="destructive" onClick={onConfirm} disabled={deleting}>
            {t(($) => {
              return $.settings.shared.delete;
            })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function requestEndpoint(
  base: string,
  protocol: ModelProviderSurfaceProtocol,
): string {
  if (!base.trim()) {
    return "";
  }
  return `${base.replace(/\/+$/, "")}${
    protocol === "anthropic-messages" ? "/v1/messages" : "/responses"
  }`;
}

function SurfaceEditor({
  protocol,
}: {
  protocol: ModelProviderSurfaceProtocol;
}) {
  const { t } = useTranslation();
  const draft = useGet(modelProviderConnectionDraft$);
  const toggle = useSet(toggleModelProviderSurface$);
  const update = useSet(updateModelProviderSurfaceField$);
  const surface =
    protocol === "anthropic-messages" ? draft.messages : draft.responses;
  const label =
    protocol === "anthropic-messages"
      ? t(($) => {
          return $.settings.models.gateways.protocols.anthropicMessages;
        })
      : t(($) => {
          return $.settings.models.gateways.protocols.openaiResponses;
        });
  return (
    <div className="rounded-xl bg-muted/20 p-4" style={ZERO_BORDER}>
      <label className="flex items-center gap-2">
        <Checkbox
          checked={surface.enabled}
          onCheckedChange={() => {
            toggle(protocol);
          }}
        />
        <span className="text-sm font-medium text-foreground">{label}</span>
      </label>
      {surface.enabled && (
        <div className="mt-4 grid gap-4">
          <label className="grid gap-1.5 text-sm font-medium text-foreground">
            {t(($) => {
              return $.settings.models.gateways.apiBaseUrl;
            })}
            <Input
              value={surface.apiBaseUrl}
              placeholder={t(($) => {
                return $.settings.models.gateways.apiBaseUrlPlaceholder;
              })}
              onChange={(event) => {
                update({
                  protocol,
                  field: "apiBaseUrl",
                  value: event.target.value,
                });
              }}
            />
            {surface.apiBaseUrl && (
              <span className="break-all text-xs font-normal text-muted-foreground">
                {t(($) => {
                  return $.settings.models.gateways.requestPreview;
                })}
                : {requestEndpoint(surface.apiBaseUrl, protocol)}
              </span>
            )}
          </label>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="grid gap-1.5 text-sm font-medium text-foreground">
              {t(($) => {
                return $.settings.models.gateways.headerName;
              })}
              <Input
                value={surface.authHeaderName}
                onChange={(event) => {
                  update({
                    protocol,
                    field: "authHeaderName",
                    value: event.target.value,
                  });
                }}
              />
            </label>
            <label className="grid gap-1.5 text-sm font-medium text-foreground">
              {t(($) => {
                return $.settings.models.gateways.headerValue;
              })}
              <Input
                value={surface.authHeaderTemplate}
                onChange={(event) => {
                  update({
                    protocol,
                    field: "authHeaderTemplate",
                    value: event.target.value,
                  });
                }}
              />
            </label>
          </div>
          <label className="grid gap-1.5 text-sm font-medium text-foreground">
            {t(($) => {
              return $.settings.models.gateways.modelMappings;
            })}
            <Textarea
              value={surface.modelMappings}
              spellCheck={false}
              rows={5}
              className="min-h-28 font-mono text-xs"
              onChange={(event) => {
                update({
                  protocol,
                  field: "modelMappings",
                  value: event.target.value,
                });
              }}
            />
          </label>
        </div>
      )}
    </div>
  );
}

function ConnectionDialogFields({ error }: { error: string | null }) {
  const { t } = useTranslation();
  const draft = useGet(modelProviderConnectionDraft$);
  const update = useSet(updateModelProviderConnectionField$);
  return (
    <div className="grid gap-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="grid gap-1.5 text-sm font-medium text-foreground">
          {t(($) => {
            return $.settings.models.gateways.name;
          })}
          <Input
            value={draft.displayName}
            onChange={(event) => {
              update({ field: "displayName", value: event.target.value });
            }}
          />
        </label>
        <label className="grid gap-1.5 text-sm font-medium text-foreground">
          {t(($) => {
            return $.settings.models.gateways.apiKey;
          })}
          <Input
            type="password"
            autoComplete="off"
            value={draft.secret}
            placeholder={
              draft.editingId
                ? t(($) => {
                    return $.settings.models.gateways.keepKey;
                  })
                : undefined
            }
            onChange={(event) => {
              update({ field: "secret", value: event.target.value });
            }}
          />
        </label>
      </div>
      <SurfaceEditor protocol="anthropic-messages" />
      <SurfaceEditor protocol="openai-responses" />
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}

function ConnectionDialog() {
  const { t } = useTranslation();
  const draft = useGet(modelProviderConnectionDraft$);
  const dialogSignal = useGet(modelProviderConnectionDialogSignal$);
  const close = useSet(closeModelProviderConnection$);
  const completeClose = useSet(completeModelProviderConnectionClose$);
  const [saveLoadable, save] = useLoadableSet(saveModelProviderConnection$);
  const saving = saveLoadable.state === "loading";
  const errorKey = draft.error;
  const error =
    errorKey === "invalidMappings"
      ? t(($) => {
          return $.settings.models.gateways.errors.invalidMappings;
        })
      : errorKey === "missingProtocol"
        ? t(($) => {
            return $.settings.models.gateways.errors.missingProtocol;
          })
        : errorKey === "missingSecret"
          ? t(($) => {
              return $.settings.models.gateways.errors.missingSecret;
            })
          : null;
  return (
    <Dialog
      open={draft.open}
      onOpenChange={(open) => {
        if (!open && !saving) {
          close();
        }
      }}
      onOpenChangeComplete={(open) => {
        if (!open) {
          completeClose();
        }
      }}
    >
      <DialogContent maxWidth="3xl" contentClassName="overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {draft.editingId
              ? t(($) => {
                  return $.settings.models.gateways.editTitle;
                })
              : t(($) => {
                  return $.settings.models.gateways.addTitle;
                })}
          </DialogTitle>
          <DialogDescription>
            {t(($) => {
              return $.settings.models.gateways.dialogDescription;
            })}
          </DialogDescription>
        </DialogHeader>
        <ConnectionDialogFields error={error} />
        <DialogFooter>
          <Button variant="outline" disabled={saving} onClick={close}>
            {t(($) => {
              return $.settings.shared.cancel;
            })}
          </Button>
          <Button
            disabled={saving || !dialogSignal}
            onClick={() => {
              if (dialogSignal) {
                detach(save(dialogSignal), Reason.DomCallback);
              }
            }}
          >
            {t(($) => {
              return $.settings.shared.saveChanges;
            })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ModelProviderConnectionsSection() {
  const { t } = useTranslation();
  const settingsDialogSignal = useGet(settingsDialogSignal$);
  const loadable = useLoadable(modelProviderConnections$);
  const last = useLastResolved(modelProviderConnections$);
  const connections =
    loadable.state === "hasData" ? loadable.data : (last ?? []);
  if (!settingsDialogSignal) {
    return null;
  }
  return (
    <section className="flex flex-col gap-3">
      <SettingsSectionHeading
        title={t(($) => {
          return $.settings.models.gateways.title;
        })}
        description={t(($) => {
          return $.settings.models.gateways.description;
        })}
        action={<AddConnectionMenu />}
      />
      {connections.length === 0 ? (
        <p
          className="rounded-xl bg-card px-4 py-5 text-sm text-muted-foreground"
          style={ZERO_BORDER}
        >
          {t(($) => {
            return $.settings.models.gateways.empty;
          })}
        </p>
      ) : (
        <div
          className="overflow-hidden rounded-xl bg-card"
          style={ZERO_BORDER}
          data-testid="model-provider-connections-list"
        >
          <div className="p-2">
            {connections.map((connection) => {
              return (
                <ConnectionRow key={connection.id} connection={connection} />
              );
            })}
          </div>
        </div>
      )}
      <ConnectionDialog />
      <DeleteConnectionDialog />
    </section>
  );
}
