import type { ClipboardEvent } from "react";
import { useGet, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react";
import {
  Button,
  Input,
  Checkbox,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@okouai/ui";
import {
  CLOUDFLARE_ACCESS_TOKEN_MAX_LENGTH,
  type CloudflareAccessConfig,
  type ScopedCloudflareAccessConfig,
} from "@okouai/api-contracts/contracts/cloudflare-access";
import {
  acceptCloudflareAccessConflictReview$,
  chooseCloudflareAccessScope$,
  closeCloudflareAccessDialog$,
  cloudflareAccessConfigs$,
  cloudflareAccessConflict$,
  cloudflareAccessConflictReview$,
  cloudflareAccessCreateScope$,
  cloudflareAccessDialog$,
  cloudflareAccessReplaceToken$,
  cloudflareAccessSaveMessage$,
  cloudflareAccessSaveUncertain$,
  mountCloudflareAccessForm$,
  openCloudflareAccessDialog$,
  replaceCloudflareAccessToken$,
  retryCloudflareAccess$,
  saveCloudflareAccess$,
  type CloudflareAccessDialogState,
} from "../../signals/cloudflare-access.ts";
import { localizedCloudflareAccessError } from "../../lib/cloudflare-access-error.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { isOrgAdmin$ } from "../../signals/org.ts";

export function CloudflareAccessConflictReview() {
  const { t } = useTranslation();
  const conflict = useGet(cloudflareAccessConflict$);
  const review = useLoadable(cloudflareAccessConflictReview$);
  const acceptReview = useSet(acceptCloudflareAccessConflictReview$);
  const signal = useGet(pageSignal$);
  if (!conflict) {
    return null;
  }
  const current = review.state === "hasData" ? review.data : null;
  return (
    <div className="grid gap-3 rounded-lg border p-4 text-sm">
      <p role="alert">
        {localizedCloudflareAccessError(conflict) ??
          t(($) => {
            return $.cloudflareAccess.failed;
          })}
      </p>
      {review.state === "hasError" && <CloudflareAccessLoadError />}
      {review.state === "loading" && (
        <p role="status">
          {t(($) => {
            return $.cloudflareAccess.loading;
          })}
        </p>
      )}
      {current && (
        <>
          <h3 className="font-semibold">
            {t(($) => {
              return $.cloudflareAccess.latest;
            })}
          </h3>
          {current.config && (
            <>
              <p>{current.config.name}</p>
              <AccessImpact config={current.config} />
            </>
          )}
          <p>
            {t(($) => {
              return $.cloudflareAccess.reviewHelp;
            })}
          </p>
          <Button
            type="button"
            variant="outline"
            disabled={
              current.kind === "delete" &&
              (current.config?.sshHosts.length ?? 0) > 0
            }
            onClick={() => {
              return detach(acceptReview(current, signal), Reason.DomCallback);
            }}
          >
            {t(($) => {
              return $.cloudflareAccess.keepChanges;
            })}
          </Button>
        </>
      )}
    </div>
  );
}

export function CloudflareAccessLoadError() {
  const { t } = useTranslation();
  const retry = useSet(retryCloudflareAccess$);
  const signal = useGet(pageSignal$);
  return (
    <div
      role="alert"
      className="flex items-center justify-between gap-3 text-sm"
    >
      <p>
        {t(($) => {
          return $.cloudflareAccess.loadFailed;
        })}
      </p>
      <Button
        type="button"
        variant="outline"
        onClick={() => {
          return detach(retry(signal), Reason.DomCallback);
        }}
      >
        {t(($) => {
          return $.cloudflareAccess.retry;
        })}
      </Button>
    </div>
  );
}

export function AccessImpact({
  config,
}: {
  readonly config: Pick<CloudflareAccessConfig, "sshHosts">;
}) {
  const { t } = useTranslation();
  return (
    <div className="grid gap-1 text-sm text-muted-foreground">
      <p>
        {config.sshHosts.length === 0
          ? t(($) => {
              return $.cloudflareAccess.unused;
            })
          : t(
              ($) => {
                return $.cloudflareAccess.usedBy;
              },
              { count: config.sshHosts.length },
            )}
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

interface AccessCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
}

function accessCredentialField(
  headerName: string,
): keyof AccessCredentials | null {
  switch (headerName.toLowerCase()) {
    case "cf-access-client-id": {
      return "clientId";
    }
    case "cf-access-client-secret": {
      return "clientSecret";
    }
    default: {
      return null;
    }
  }
}

function validAccessCredential(value: string): boolean {
  return (
    value.length <= CLOUDFLARE_ACCESS_TOKEN_MAX_LENGTH &&
    /^[\x21-\x7e]+$/u.test(value)
  );
}

function accessCredentialsFromClipboard(
  clipboard: string,
): AccessCredentials | null {
  const lines = clipboard.split(/\r\n|\n/u);
  if (lines.at(-1) === "") {
    lines.pop();
  }
  if (lines.length !== 2) {
    return null;
  }
  let clientId: string | undefined;
  let clientSecret: string | undefined;
  for (const line of lines) {
    const separator = line.indexOf(":");
    if (separator === -1) {
      return null;
    }
    const field = accessCredentialField(line.slice(0, separator));
    const value = line.slice(separator + 1).replace(/^[\t ]*/u, "");
    if (!field || !validAccessCredential(value)) {
      return null;
    }
    if (field === "clientId") {
      if (clientId !== undefined) {
        return null;
      }
      clientId = value;
    } else {
      if (clientSecret !== undefined) {
        return null;
      }
      clientSecret = value;
    }
  }
  if (clientId === undefined || clientSecret === undefined) {
    return null;
  }
  return {
    clientId,
    clientSecret,
  };
}

function accessCredentialInput(
  form: HTMLFormElement,
  name: keyof AccessCredentials,
): HTMLInputElement | null {
  const input = form.elements.namedItem(name);
  return input instanceof HTMLInputElement && input.type === "password"
    ? input
    : null;
}

function pasteAccessCredentials(event: ClipboardEvent<HTMLInputElement>) {
  const credentials = accessCredentialsFromClipboard(
    event.clipboardData.getData("text/plain"),
  );
  const form = event.currentTarget.form;
  if (!credentials || !form) {
    return;
  }
  const clientId = accessCredentialInput(form, "clientId");
  const clientSecret = accessCredentialInput(form, "clientSecret");
  if (!clientId || !clientSecret) {
    return;
  }
  event.preventDefault();
  clientId.value = credentials.clientId;
  clientSecret.value = credentials.clientSecret;
}

export function AccessFields({
  config,
}: {
  readonly config: CloudflareAccessConfig | null;
}) {
  const { t } = useTranslation();
  const replace = useGet(cloudflareAccessReplaceToken$);
  const setReplace = useSet(replaceCloudflareAccessToken$);
  return (
    <>
      <label className="grid gap-2">
        {t(($) => {
          return $.cloudflareAccess.name;
        })}
        <Input
          name="accessName"
          placeholder={t(($) => {
            return $.cloudflareAccess.namePlaceholder;
          })}
          required
          pattern=".*\S.*"
          maxLength={128}
          defaultValue={config?.name}
        />
      </label>
      {config && (
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            name="replaceToken"
            checked={replace}
            onCheckedChange={(checked) => {
              return setReplace(checked);
            }}
          />
          {t(($) => {
            return $.cloudflareAccess.replace;
          })}
        </label>
      )}
      {(!config || replace) && (
        <>
          <p className="text-sm text-muted-foreground">
            {t(($) => {
              return $.cloudflareAccess.tokenHelp;
            })}
          </p>
          <label className="grid gap-2">
            {t(($) => {
              return $.cloudflareAccess.clientId;
            })}
            <Input
              name="clientId"
              placeholder={t(($) => {
                return $.cloudflareAccess.clientIdPlaceholder;
              })}
              required
              type="password"
              pattern="[!-~]+"
              maxLength={CLOUDFLARE_ACCESS_TOKEN_MAX_LENGTH}
              autoComplete="new-password"
              spellCheck={false}
              onPaste={pasteAccessCredentials}
            />
          </label>
          <label className="grid gap-2">
            {t(($) => {
              return $.cloudflareAccess.clientSecret;
            })}
            <Input
              name="clientSecret"
              placeholder={t(($) => {
                return $.cloudflareAccess.clientSecretPlaceholder;
              })}
              required
              type="password"
              pattern="[!-~]+"
              maxLength={CLOUDFLARE_ACCESS_TOKEN_MAX_LENGTH}
              autoComplete="new-password"
              spellCheck={false}
              onPaste={pasteAccessCredentials}
            />
          </label>
        </>
      )}
    </>
  );
}

function useCloudflareAccessDialogCopy(
  kind: CloudflareAccessDialogState["kind"] | undefined,
) {
  const { t } = useTranslation();
  switch (kind) {
    case "create": {
      return {
        title: t(($) => {
          return $.cloudflareAccess.add;
        }),
        description: null,
      };
    }
    case "edit": {
      return {
        title: t(($) => {
          return $.cloudflareAccess.edit;
        }),
        description: null,
      };
    }
    case "delete": {
      return {
        title: t(($) => {
          return $.cloudflareAccess.delete;
        }),
        description: t(($) => {
          return $.cloudflareAccess.deleteHelp;
        }),
      };
    }
    case undefined: {
      return { title: "", description: null };
    }
  }
}

function CloudflareAccessSaveNotice({
  isSaving,
}: {
  readonly isSaving: boolean;
}) {
  const { t } = useTranslation();
  const uncertain = useGet(cloudflareAccessSaveUncertain$);
  const message = useGet(cloudflareAccessSaveMessage$);
  if (isSaving || (!uncertain && !message)) {
    return null;
  }
  return (
    <p role="alert" className="text-sm text-muted-foreground">
      {uncertain
        ? t(($) => {
            return $.cloudflareAccess.saveUncertain;
          })
        : (localizedCloudflareAccessError(message ?? "") ??
          t(($) => {
            return $.cloudflareAccess.invalidInput;
          }))}
    </p>
  );
}

function CloudflareAccessFormActions({
  isSaving,
  blocked,
  destructive,
  title,
}: {
  readonly isSaving: boolean;
  readonly blocked: boolean;
  readonly destructive: boolean;
  readonly title: string;
}) {
  const { t } = useTranslation();
  const close = useSet(closeCloudflareAccessDialog$);
  const uncertain = useGet(cloudflareAccessSaveUncertain$);
  return (
    <div className="flex shrink-0 justify-end gap-2">
      <Button
        type="button"
        variant="outline"
        disabled={isSaving}
        onClick={close}
      >
        {t(($) => {
          return $.cloudflareAccess.cancel;
        })}
      </Button>
      <Button
        type="submit"
        disabled={isSaving || (!uncertain && blocked)}
        variant={destructive ? "destructive" : "default"}
      >
        {isSaving
          ? t(($) => {
              return $.connectors.actions.saving;
            })
          : uncertain
            ? t(($) => {
                return $.cloudflareAccess.retry;
              })
            : destructive
              ? title
              : t(($) => {
                  return $.cloudflareAccess.save;
                })}
      </Button>
    </div>
  );
}

export function CloudflareAccessDialog() {
  const { t } = useTranslation();
  const data = useLoadable(cloudflareAccessDialog$);
  const close = useSet(closeCloudflareAccessDialog$);
  const [saving, save] = useLoadableSet(saveCloudflareAccess$);
  const mount = useSet(mountCloudflareAccessForm$);
  const signal = useGet(pageSignal$);
  const conflict = useGet(cloudflareAccessConflict$);
  const uncertain = useGet(cloudflareAccessSaveUncertain$);
  const admin = useLoadable(isOrgAdmin$);
  const chooseScope = useSet(chooseCloudflareAccessScope$);
  const createScope = useGet(cloudflareAccessCreateScope$);
  const dialog = data.state === "hasData" ? data.data : null;
  const { title, description } = useCloudflareAccessDialogCopy(dialog?.kind);
  const isSaving = saving.state === "loading";
  if (!dialog) {
    return null;
  }
  const destructive = dialog.kind === "delete";
  const scope = dialog.kind === "create" ? createScope : dialog.scope;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !isSaving) {
          close();
        }
      }}
    >
      <DialogContent
        contentClassName="flex flex-col"
        key={`${dialog.identity}:${dialog.kind}:${dialog.config?.id ?? "new"}`}
      >
        <DialogHeader className="shrink-0">
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <form
          ref={mount}
          className="flex min-h-0 min-w-0 flex-col gap-4"
          autoComplete="off"
          aria-busy={isSaving}
          onSubmit={(event) => {
            event.preventDefault();
            if (!isSaving && (uncertain || !conflict)) {
              detach(save(event.currentTarget, signal), Reason.DomCallback);
            }
          }}
        >
          <DialogBody className="grid gap-4">
            {dialog.kind === "create" &&
              admin.state === "hasData" &&
              admin.data && (
                <div className="grid gap-2">
                  <span id="cloudflare-access-scope-label">
                    {t(($) => {
                      return $.cloudflareAccess.scope;
                    })}
                  </span>
                  <Select
                    items={[
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
                    ]}
                    value={scope}
                    disabled={isSaving || uncertain}
                    onValueChange={(value, details) => {
                      if (value !== "personal" && value !== "organization") {
                        details.cancel();
                        return;
                      }
                      detach(chooseScope(value, signal), Reason.DomCallback);
                    }}
                  >
                    <SelectTrigger aria-labelledby="cloudflare-access-scope-label">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="personal">
                        {t(($) => {
                          return $.cloudflareAccess.personal;
                        })}
                      </SelectItem>
                      <SelectItem value="organization">
                        {t(($) => {
                          return $.cloudflareAccess.organization;
                        })}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}
            {scope === "organization" && (
              <p className="text-sm text-muted-foreground">
                {t(($) => {
                  return $.cloudflareAccess.organizationHelp;
                })}
              </p>
            )}
            {!destructive && (
              <fieldset
                disabled={isSaving || uncertain}
                className="grid min-w-0 gap-4"
              >
                <AccessFields config={dialog.config} />
              </fieldset>
            )}
            {dialog.config && <AccessImpact config={dialog.config} />}
            <CloudflareAccessConflictReview />
            <CloudflareAccessSaveNotice isSaving={isSaving} />
          </DialogBody>
          <CloudflareAccessFormActions
            isSaving={isSaving}
            blocked={isSaving || !!conflict}
            destructive={destructive}
            title={title}
          />
        </form>
      </DialogContent>
    </Dialog>
  );
}

function CloudflareAccessSection({
  scope,
  configs,
  canManage,
}: {
  readonly scope: "personal" | "organization";
  readonly configs: readonly ScopedCloudflareAccessConfig[];
  readonly canManage: boolean;
}) {
  const { t } = useTranslation();
  const open = useSet(openCloudflareAccessDialog$);
  const signal = useGet(pageSignal$);
  return (
    <section
      aria-label={t(($) => {
        return scope === "personal"
          ? $.cloudflareAccess.personal
          : $.cloudflareAccess.organization;
      })}
      className="grid gap-3"
    >
      <h2 className="text-base font-semibold">
        {t(($) => {
          return scope === "personal"
            ? $.cloudflareAccess.personal
            : $.cloudflareAccess.organization;
        })}
      </h2>
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
            className="grid gap-3 rounded-xl border bg-card p-5"
          >
            <h3 className="font-semibold">{config.name}</h3>
            <AccessImpact config={config} />
            {canManage && (
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  onClick={() => {
                    return detach(
                      open("edit", config, signal),
                      Reason.DomCallback,
                    );
                  }}
                >
                  {t(($) => {
                    return $.cloudflareAccess.edit;
                  })}
                </Button>
                <Button
                  variant="outline"
                  disabled={config.sshHosts.length > 0}
                  onClick={() => {
                    return detach(
                      open("delete", config, signal),
                      Reason.DomCallback,
                    );
                  }}
                >
                  {t(($) => {
                    return $.cloudflareAccess.delete;
                  })}
                </Button>
              </div>
            )}
            {canManage && config.sshHosts.length > 0 && (
              <p className="text-sm text-muted-foreground">
                {t(($) => {
                  return $.cloudflareAccess.inUseHelp;
                })}
              </p>
            )}
          </article>
        );
      })}
    </section>
  );
}

export function CloudflareAccessConfigs() {
  const { t } = useTranslation();
  const configs = useLoadable(cloudflareAccessConfigs$);
  const open = useSet(openCloudflareAccessDialog$);
  const signal = useGet(pageSignal$);
  const admin = useLoadable(isOrgAdmin$);
  if (configs.state === "loading") {
    return (
      <p role="status">
        {t(($) => {
          return $.cloudflareAccess.loading;
        })}
      </p>
    );
  }
  if (configs.state === "hasError") {
    return <CloudflareAccessLoadError />;
  }
  if (!configs.data) {
    return (
      <p>
        {t(($) => {
          return $.cloudflareAccess.unavailable;
        })}
      </p>
    );
  }
  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {t(
            ($) => {
              return $.cloudflareAccess.summary;
            },
            { count: configs.data.length },
          )}
        </p>
        <Button
          onClick={() => {
            return detach(open("create", null, signal), Reason.DomCallback);
          }}
        >
          <Plus size={16} aria-hidden="true" />
          {t(($) => {
            return $.cloudflareAccess.add;
          })}
        </Button>
      </div>
      <CloudflareAccessSection
        scope="personal"
        configs={configs.data.filter((config) => {
          return config.scope === "personal";
        })}
        canManage
      />
      <CloudflareAccessSection
        scope="organization"
        configs={configs.data.filter((config) => {
          return config.scope === "organization";
        })}
        canManage={admin.state === "hasData" && admin.data === true}
      />
    </div>
  );
}
