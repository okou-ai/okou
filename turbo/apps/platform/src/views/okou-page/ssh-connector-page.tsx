import { useGet, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import { Plug, Plus, Terminal } from "lucide-react";
import {
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  Input,
  Textarea,
  Checkbox,
  SegmentControl,
  SegmentControlItem,
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@okouai/ui";
import {
  SSH_DISPLAY_NAME_MAX_LENGTH,
  SSH_HOST_MAX_LENGTH,
  SSH_USERNAME_MAX_LENGTH,
  SSH_PRIVATE_KEY_MAX_LENGTH,
  SSH_PASSPHRASE_MAX_LENGTH,
  type SshConnectionResponse,
} from "@okouai/api-contracts/contracts/ssh-connections";
import {
  sshView$,
  type SshDialogState,
  changeSshView$,
  sshCredentials$,
  sshCredentialEditor$,
  chooseSshCredential$,
  chooseSshAuthMethod$,
  replaceSshAuthentication$,
  openSshCredentialDialog$,
  sshConnections$,
  sshConflict$,
  sshDialog$,
  openSshDialog$,
  closeSshDialog$,
  saveSsh$,
  cancelSshPrivateKeyFile$,
  importSshPrivateKeyFile$,
  mountSshPrivateKey$,
  mountSshForm$,
  sshPrivateKeyFileResult$,
} from "../../signals/ssh.ts";
import {
  SSH_PASSWORD_MAX_LENGTH,
  type SshCredentialResponse,
} from "@okouai/api-contracts/contracts/ssh-credentials";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { ROUTES } from "../../signals/route-paths.ts";
import { Link } from "../router/link.tsx";
import { SshLoadError } from "./ssh-load-error.tsx";
import { SshAttention, SshHostWarning } from "./ssh-connection-status.tsx";
import { localizedSshError } from "../../lib/ssh-error.ts";
import {
  DetailPageBreadcrumbBar,
  DetailPageHeader,
  DetailPageMain,
  DetailPageShell,
} from "../components/detail-page-layout.tsx";

function EndpointFields({
  connection,
}: {
  readonly connection: SshConnectionResponse | null;
}) {
  const { t } = useTranslation();
  return (
    <fieldset className="grid min-w-0 gap-4">
      <legend className="mb-3 text-sm font-semibold">
        {t(($) => {
          return $.ssh.hostSection;
        })}
      </legend>
      <label className="grid gap-2">
        {t(($) => {
          return $.ssh.displayName;
        })}
        <Input
          name="displayName"
          required
          pattern=".*\S.*"
          maxLength={SSH_DISPLAY_NAME_MAX_LENGTH}
          defaultValue={connection?.displayName}
        />
      </label>
      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_6rem]">
        <label className="grid gap-2">
          {t(($) => {
            return $.ssh.host;
          })}
          <Input
            name="host"
            required
            pattern=".*\S.*"
            maxLength={SSH_HOST_MAX_LENGTH}
            defaultValue={connection?.host}
          />
        </label>
        <label className="grid gap-2">
          {t(($) => {
            return $.ssh.port;
          })}
          <Input
            name="port"
            type="number"
            className="[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
            required
            min={1}
            max={65_535}
            defaultValue={connection?.port ?? 22}
          />
        </label>
      </div>
    </fieldset>
  );
}

function PrivateKeyFields() {
  const { t } = useTranslation();
  const importFile = useSet(importSshPrivateKeyFile$);
  const cancelRead = useSet(cancelSshPrivateKeyFile$);
  const mountPrivateKey = useSet(mountSshPrivateKey$);
  const result = useLoadable(sshPrivateKeyFileResult$);
  const signal = useGet(pageSignal$);
  return (
    <>
      <p className="text-sm text-muted-foreground">
        {t(($) => {
          return $.ssh.credentialsHelp;
        })}
      </p>
      <div className="grid gap-2">
        <div className="flex items-center justify-between gap-2">
          <label htmlFor="ssh-private-key">
            {t(($) => {
              return $.ssh.privateKey;
            })}
          </label>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={(event) => {
              const input = event.currentTarget
                .closest("form")
                ?.elements.namedItem("ssh-private-key-file");
              if (!(input instanceof HTMLInputElement)) {
                throw new Error(
                  "SSH credential form is missing its file input",
                );
              }
              input.click();
            }}
          >
            {t(($) => {
              return $.ssh.chooseFile;
            })}
          </Button>
        </div>
        <input
          id="ssh-private-key-file"
          type="file"
          className="hidden"
          aria-label={t(($) => {
            return $.ssh.choosePrivateKeyFile;
          })}
          onChange={(event) => {
            detach(importFile(event.currentTarget, signal), Reason.DomCallback);
          }}
        />
        <Textarea
          id="ssh-private-key"
          ref={mountPrivateKey}
          name="privateKey"
          required
          maxLength={SSH_PRIVATE_KEY_MAX_LENGTH}
          autoComplete="off"
          spellCheck={false}
          onInput={() => {
            cancelRead();
          }}
        />
        {result.state === "loading" && (
          <p role="status" className="text-sm text-muted-foreground">
            {t(($) => {
              return $.ssh.fileReading;
            })}
          </p>
        )}
        {result.state === "hasData" && result.data !== null && (
          <p role="alert" className="text-sm text-destructive">
            {result.data === "size"
              ? t(($) => {
                  return $.ssh.fileSizeError;
                })
              : t(($) => {
                  return $.ssh.fileReadError;
                })}
          </p>
        )}
      </div>
      <label className="grid gap-2">
        {t(($) => {
          return $.ssh.passphrase;
        })}
        <Input
          name="passphrase"
          type="password"
          maxLength={SSH_PASSPHRASE_MAX_LENGTH}
          autoComplete="new-password"
        />
      </label>
    </>
  );
}

function CredentialFields({
  credential,
  disabled,
}: {
  readonly credential: SshCredentialResponse | null;
  readonly disabled: boolean;
}) {
  const { t } = useTranslation();
  const editor = useGet(sshCredentialEditor$);
  const chooseMethod = useSet(chooseSshAuthMethod$);
  const replace = useSet(replaceSshAuthentication$);
  return (
    <>
      <label className="grid gap-2">
        {t(($) => {
          return $.ssh.credential.name;
        })}
        <Input
          name="credentialName"
          required
          pattern=".*\S.*"
          maxLength={SSH_DISPLAY_NAME_MAX_LENGTH}
          defaultValue={credential?.name}
        />
      </label>
      <label className="grid gap-2">
        {t(($) => {
          return $.ssh.username;
        })}
        <Input
          name="username"
          required
          pattern=".*\S.*"
          maxLength={SSH_USERNAME_MAX_LENGTH}
          defaultValue={credential?.username}
        />
      </label>
      {credential && (
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            disabled={disabled}
            checked={editor.replace}
            onCheckedChange={(checked) => {
              return replace(checked === true);
            }}
          />
          {t(($) => {
            return $.ssh.credential.replaceAuthentication;
          })}
        </label>
      )}
      {(!credential || editor.replace) && (
        <>
          <div className="grid gap-2">
            <span id="ssh-auth-method-label">
              {t(($) => {
                return $.ssh.credential.authentication;
              })}
            </span>
            <SegmentControl
              className="justify-self-start"
              disabled={disabled}
              aria-labelledby="ssh-auth-method-label"
              value={editor.method}
              onValueChange={chooseMethod}
            >
              <SegmentControlItem value="private_key">
                {t(($) => {
                  return $.ssh.privateKey;
                })}
              </SegmentControlItem>
              <SegmentControlItem value="password">
                {t(($) => {
                  return $.ssh.credential.password;
                })}
              </SegmentControlItem>
            </SegmentControl>
          </div>
          {editor.method === "password" ? (
            <label key="password" className="grid gap-2">
              {t(($) => {
                return $.ssh.credential.password;
              })}
              <Input
                name="password"
                type="password"
                required
                maxLength={SSH_PASSWORD_MAX_LENGTH}
                autoComplete="new-password"
              />
            </label>
          ) : (
            <PrivateKeyFields key="private-key" />
          )}
        </>
      )}
    </>
  );
}

function CredentialSelection({ disabled }: { readonly disabled: boolean }) {
  const { t } = useTranslation();
  const credentials = useLoadable(sshCredentials$);
  const editor = useGet(sshCredentialEditor$);
  const choose = useSet(chooseSshCredential$);
  return (
    <fieldset className="grid min-w-0 gap-4">
      <legend className="mb-3 text-sm font-semibold">
        <label htmlFor="ssh-selected-credential">
          {t(($) => {
            return $.ssh.credential.label;
          })}
        </label>
      </legend>
      <div className="grid gap-2">
        {credentials.state === "hasError" ? (
          <SshLoadError />
        ) : credentials.state === "loading" ? (
          <p role="status">
            {t(($) => {
              return $.ssh.credential.loading;
            })}
          </p>
        ) : !credentials.data ? (
          <p>
            {t(($) => {
              return $.ssh.unavailable;
            })}
          </p>
        ) : (
          <Select
            disabled={disabled}
            value={editor.selection}
            onValueChange={choose}
          >
            <SelectTrigger id="ssh-selected-credential">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {credentials.data.map((credential) => {
                return (
                  <SelectItem key={credential.id} value={credential.id}>
                    {credential.name} · {credential.username}
                  </SelectItem>
                );
              })}
              <SelectItem value="new">
                {t(($) => {
                  return $.ssh.credential.createNew;
                })}
              </SelectItem>
            </SelectContent>
          </Select>
        )}
      </div>
      {editor.selection === "new" && (
        <div className="grid gap-4 rounded-lg border bg-muted/30 p-4">
          <CredentialFields credential={null} disabled={disabled} />
        </div>
      )}
    </fieldset>
  );
}

function CredentialImpact({
  credential,
}: {
  readonly credential: SshCredentialResponse;
}) {
  const { t } = useTranslation();
  return (
    <div className="grid gap-1 text-sm text-muted-foreground">
      <p>
        {credential.hosts.length === 0
          ? t(($) => {
              return $.ssh.credential.unused;
            })
          : t(
              ($) => {
                return $.ssh.credential.sharedHelp;
              },
              {
                count: credential.hosts.length,
              },
            )}
      </p>
      {credential.hosts.length > 0 && (
        <ul className="list-inside list-disc">
          {credential.hosts.map((host) => {
            return <li key={host.id}>{host.displayName}</li>;
          })}
        </ul>
      )}
    </div>
  );
}

function useDialogCopy(kind: SshDialogState["kind"] | undefined) {
  const { t } = useTranslation();
  switch (kind) {
    case "create": {
      return {
        title: t(($) => {
          return $.ssh.add;
        }),
        description: null,
      };
    }
    case "edit": {
      return {
        title: t(($) => {
          return $.ssh.edit;
        }),
        description: t(($) => {
          return $.ssh.editHelp;
        }),
      };
    }
    case "delete": {
      return {
        title: t(($) => {
          return $.ssh.delete;
        }),
        description: t(($) => {
          return $.ssh.deleteHelp;
        }),
      };
    }
    case "reset": {
      return {
        title: t(($) => {
          return $.ssh.reset;
        }),
        description: t(($) => {
          return $.ssh.resetHelp;
        }),
      };
    }
    case "create-credential": {
      return {
        title: t(($) => {
          return $.ssh.credential.add;
        }),
        description: null,
      };
    }
    case "edit-credential": {
      return {
        title: t(($) => {
          return $.ssh.credential.edit;
        }),
        description: null,
      };
    }
    case "delete-credential": {
      return {
        title: t(($) => {
          return $.ssh.credential.delete;
        }),
        description: t(($) => {
          return $.ssh.credential.deleteHelp;
        }),
      };
    }
    case undefined: {
      return { title: "", description: null };
    }
  }
}

function SshDialog() {
  const { t } = useTranslation();
  const data = useLoadable(sshDialog$);
  const close = useSet(closeSshDialog$);
  const [saving, save] = useLoadableSet(saveSsh$);
  const mountForm = useSet(mountSshForm$);
  const signal = useGet(pageSignal$);
  const fileResult = useLoadable(sshPrivateKeyFileResult$);
  const credentials = useLoadable(sshCredentials$);
  const dialog = data.state === "hasData" ? data.data : null;
  const { title, description } = useDialogCopy(dialog?.kind);
  const isSaving = saving.state === "loading";
  if (!dialog) {
    return null;
  }
  const hostEditor = dialog.kind === "create" || dialog.kind === "edit";
  const destructive = ["delete", "reset", "delete-credential"].includes(
    dialog.kind,
  );
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
        key={`${dialog.identity}:${dialog.kind}:${dialog.connection?.id ?? dialog.credential?.id ?? "new"}`}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <form
          ref={mountForm}
          className="grid gap-4"
          autoComplete="off"
          aria-busy={isSaving}
          onSubmit={(event) => {
            event.preventDefault();
            if (isSaving) {
              return;
            }
            // Keep retryable input only in this form, never in ccstate or caches.
            const values = new FormData(event.currentTarget);
            detach(save(values, signal), Reason.DomCallback);
          }}
        >
          {!destructive && (
            <fieldset disabled={isSaving} className="grid min-w-0 gap-4">
              {hostEditor ? (
                <>
                  <EndpointFields connection={dialog.connection} />
                  <div aria-hidden="true" className="h-px bg-divider" />
                  <CredentialSelection disabled={isSaving} />
                </>
              ) : (
                <CredentialFields
                  credential={dialog.credential}
                  disabled={isSaving}
                />
              )}
            </fieldset>
          )}
          {dialog.credential && (
            <CredentialImpact credential={dialog.credential} />
          )}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={isSaving}
              onClick={() => {
                return close();
              }}
            >
              {t(($) => {
                return $.ssh.cancel;
              })}
            </Button>
            <Button
              type="submit"
              disabled={
                [saving.state, fileResult.state].includes("loading") ||
                (hostEditor &&
                  (credentials.state !== "hasData" ||
                    credentials.data === null))
              }
              variant={destructive ? "destructive" : "default"}
            >
              {isSaving
                ? t(($) => {
                    return $.connectors.actions.saving;
                  })
                : destructive
                  ? title
                  : t(($) => {
                      return $.ssh.save;
                    })}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function HostCard({
  connection,
}: {
  readonly connection: SshConnectionResponse;
}) {
  const { t } = useTranslation();
  const open = useSet(openSshDialog$);
  const signal = useGet(pageSignal$);
  return (
    <article className="grid gap-3 rounded-xl border bg-card p-5">
      <h2 className="font-semibold">{connection.displayName}</h2>
      <SshHostWarning
        connectionId={connection.id}
        generation={connection.generation}
      />
      <p className="text-sm text-muted-foreground">
        {connection.credentialName}
      </p>
      <p className="break-all text-sm">
        {connection.username}@{connection.host}:{connection.port}
      </p>
      <p className="break-all text-sm">
        {connection.learnedHostKey ? (
          <>
            {t(($) => {
              return $.ssh.fingerprint;
            })}
            : {connection.learnedHostKey.algorithm}{" "}
            <code>{connection.learnedHostKey.fingerprint}</code>
          </>
        ) : (
          t(($) => {
            return $.ssh.notLearned;
          })
        )}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          onClick={() => {
            return detach(open("edit", connection, signal), Reason.DomCallback);
          }}
        >
          {t(($) => {
            return $.ssh.edit;
          })}
        </Button>
        <Button
          variant="outline"
          disabled={!connection.learnedHostKey}
          onClick={() => {
            return detach(
              open("reset", connection, signal),
              Reason.DomCallback,
            );
          }}
        >
          {t(($) => {
            return $.ssh.reset;
          })}
        </Button>
        <Button
          variant="outline"
          onClick={() => {
            return detach(
              open("delete", connection, signal),
              Reason.DomCallback,
            );
          }}
        >
          {t(($) => {
            return $.ssh.delete;
          })}
        </Button>
      </div>
    </article>
  );
}

function SshHosts() {
  const { t } = useTranslation();
  const hosts = useLoadable(sshConnections$);
  const conflict = useGet(sshConflict$);
  const open = useSet(openSshDialog$);
  const signal = useGet(pageSignal$);
  if (hosts.state === "loading") {
    return (
      <p className="text-sm text-muted-foreground">
        {t(($) => {
          return $.ssh.loading;
        })}
      </p>
    );
  }
  if (hosts.state === "hasError") {
    return <SshLoadError />;
  }
  if (!hosts.data) {
    return (
      <p className="text-sm text-muted-foreground">
        {t(($) => {
          return $.ssh.unavailable;
        })}
      </p>
    );
  }
  return (
    <div className="grid gap-5">
      {hosts.data.length > 0 ? <SshAttention /> : null}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {t(
            ($) => {
              return $.ssh.summary;
            },
            {
              count: hosts.data.length,
            },
          )}
        </p>
        <Button
          onClick={() => {
            return detach(open("create", null, signal), Reason.DomCallback);
          }}
        >
          <Plus size={16} aria-hidden="true" />
          {t(($) => {
            return $.ssh.add;
          })}
        </Button>
      </div>
      {conflict && (
        <p role="alert" className="text-sm">
          {localizedSshError(conflict) ??
            t(($) => {
              return $.ssh.errors.failed;
            })}
        </p>
      )}
      {hosts.data.length === 0 && (
        <p className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
          {t(($) => {
            return $.ssh.empty;
          })}
        </p>
      )}
      {hosts.data.map((connection) => {
        return <HostCard key={connection.id} connection={connection} />;
      })}
    </div>
  );
}

function Credentials() {
  const { t } = useTranslation();
  const credentials = useLoadable(sshCredentials$);
  const conflict = useGet(sshConflict$);
  const open = useSet(openSshCredentialDialog$);
  const signal = useGet(pageSignal$);
  if (credentials.state === "loading") {
    return (
      <p role="status">
        {t(($) => {
          return $.ssh.credential.loading;
        })}
      </p>
    );
  }
  if (credentials.state === "hasError") {
    return <SshLoadError />;
  }
  if (!credentials.data) {
    return (
      <p>
        {t(($) => {
          return $.ssh.unavailable;
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
              return $.ssh.credential.summary;
            },
            { count: credentials.data.length },
          )}
        </p>
        <Button
          onClick={() => {
            return detach(
              open("create-credential", null, signal),
              Reason.DomCallback,
            );
          }}
        >
          <Plus size={16} aria-hidden="true" />
          {t(($) => {
            return $.ssh.credential.add;
          })}
        </Button>
      </div>
      {conflict && (
        <p role="alert">
          {localizedSshError(conflict) ??
            t(($) => {
              return $.ssh.errors.failed;
            })}
        </p>
      )}
      {credentials.data.length === 0 && (
        <p className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
          {t(($) => {
            return $.ssh.credential.empty;
          })}
        </p>
      )}
      {credentials.data.map((credential) => {
        return (
          <article
            key={credential.id}
            className="grid gap-3 rounded-xl border bg-card p-5"
          >
            <h2 className="font-semibold">{credential.name}</h2>
            <p className="text-sm">
              {credential.username} ·{" "}
              {credential.authMethod === "password"
                ? t(($) => {
                    return $.ssh.credential.password;
                  })
                : t(($) => {
                    return $.ssh.privateKey;
                  })}
            </p>
            <CredentialImpact credential={credential} />
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                onClick={() => {
                  return detach(
                    open("edit-credential", credential, signal),
                    Reason.DomCallback,
                  );
                }}
              >
                {t(($) => {
                  return $.ssh.credential.edit;
                })}
              </Button>
              <Button
                variant="outline"
                disabled={credential.hosts.length > 0}
                onClick={() => {
                  return detach(
                    open("delete-credential", credential, signal),
                    Reason.DomCallback,
                  );
                }}
              >
                {t(($) => {
                  return $.ssh.credential.delete;
                })}
              </Button>
            </div>
            {credential.hosts.length > 0 && (
              <p className="text-sm text-muted-foreground">
                {t(($) => {
                  return $.ssh.credential.inUseHelp;
                })}
              </p>
            )}
          </article>
        );
      })}
    </div>
  );
}

export function SshConnectorPage() {
  const { t } = useTranslation();
  const view = useGet(sshView$);
  const changeView = useSet(changeSshView$);
  return (
    <DetailPageShell>
      <DetailPageBreadcrumbBar>
        <Link
          pathname={ROUTES.connectors}
          className="inline-flex min-w-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-inherit no-underline transition-colors hover:bg-state-hover hover:text-foreground"
        >
          <Plug size={14} className="shrink-0" aria-hidden="true" />
          {t(($) => {
            return $.appShell.sidebar.navigation.connectors;
          })}
        </Link>
        <span className="select-none text-muted-foreground/40">/</span>
        <span
          aria-current="page"
          className="min-w-0 truncate rounded-md px-1.5 py-0.5 font-medium text-foreground"
        >
          {t(($) => {
            return $.ssh.label;
          })}
        </span>
      </DetailPageBreadcrumbBar>
      <DetailPageHeader>
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-gray-100 text-muted-foreground sm:h-16 sm:w-16">
            <Terminal size={28} aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h1 className="text-lg font-semibold tracking-tight text-foreground sm:text-xl">
              {t(($) => {
                return $.ssh.title;
              })}
            </h1>
            <p className="mt-1.5 text-sm text-muted-foreground">
              {t(($) => {
                return $.ssh.description;
              })}
            </p>
          </div>
        </div>
      </DetailPageHeader>
      <DetailPageMain constrainContent>
        <div className="mb-5">
          <SegmentControl
            value={view}
            onValueChange={changeView}
            aria-label={t(($) => {
              return $.ssh.title;
            })}
          >
            <SegmentControlItem value="hosts">
              {t(($) => {
                return $.ssh.hostsTab;
              })}
            </SegmentControlItem>
            <SegmentControlItem value="credentials">
              {t(($) => {
                return $.ssh.credentialsTab;
              })}
            </SegmentControlItem>
          </SegmentControl>
        </div>
        {view === "hosts" ? <SshHosts /> : <Credentials />}
        <SshDialog />
      </DetailPageMain>
    </DetailPageShell>
  );
}
