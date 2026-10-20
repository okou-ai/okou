import { RemoteSecretInput } from "./remote-secret-input.tsx";
import {
  RemoteConnectionSummary,
  RemoteConnectionCheckUnavailable,
} from "./remote-connection-summary.tsx";
import { authenticatedSessionKey$ } from "../../signals/auth.ts";
import { useLastResolved, useGet, useLoadable, useSet } from "ccstate-react";
import {
  RemoteLoginPicker,
  RemoteSelectedLogin,
  RemoteLoginConfirmation,
} from "./remote-login-controls.tsx";
import { requestRemoteLoginSave$ } from "../../signals/remote-login.ts";
import {
  sshLoginPatch,
  type SshDialogState,
  type SshConflictReviewState,
  sshCredentials$,
  sshCredentialEditor$,
  chooseSshCredential$,
  chooseSshAuthMethod$,
  replaceSshAuthentication$,
  openSshCredentialDialog$,
  sshConnections$,
  sshConflict$,
  sshConflictReview$,
  acceptSshConflictReview$,
  sshDialog$,
  openSshDialog$,
  closeSshDialog$,
  saveSsh$,
  sshSaveUncertain$,
  sshSaveMessage$,
  cancelSshPrivateKeyFile$,
  importSshPrivateKeyFile$,
  mountSshPrivateKey$,
  mountSshForm$,
  sshPrivateKeyFileResult$,
  sshConnectionModeEditor$,
  chooseSshConnectionMode$,
  usesTailscaleNetwork,
} from "../../signals/ssh.ts";
import {
  remoteSetup$,
  remoteControlGuidedEnabled$,
} from "../../signals/remote-control-setup.ts";
import {
  RemoteEditorFrame,
  RemoteUsernameHelp,
  REMOTE_PAGE_ACTION,
} from "./remote-editor-frame.tsx";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import { buttonVariants } from "@okouai/ui/components/ui/button";
import { cn } from "@okouai/ui/lib/utils";
import { ExternalLink, Plus } from "lucide-react";
import {
  Button,
  DialogBody,
  Input,
  Textarea,
  Checkbox,
  SegmentControl,
  SegmentControlItem,
  surfaceVariants,
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
  type SshConnectionMode,
} from "@okouai/api-contracts/contracts/ssh-connections";
import { SSH_ERROR_CODES } from "@okouai/api-contracts/contracts/ssh-errors";
import { cloudflareAccessConfigs$ } from "../../signals/cloudflare-access.ts";
import { AccessSelection } from "./ssh-cloudflare-access.tsx";
import { TailscaleSelection } from "./ssh-tailscale.tsx";
import {
  tailscaleConfigs$,
  tailscaleEnabled$,
} from "../../signals/tailscale.ts";
import {
  SSH_PASSWORD_MAX_LENGTH,
  type SshCredentialResponse,
} from "@okouai/api-contracts/contracts/ssh-credentials";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { SshLoadError } from "./ssh-load-error.tsx";
import { localizedSshError } from "../../lib/ssh-error.ts";
import { SshAttention, SshHostWarning } from "./ssh-connection-status.tsx";
import { RemoteHostDefaultToggle } from "./remote-access-controls.tsx";

function SshConnectionType({ disabled }: { readonly disabled: boolean }) {
  const { t } = useTranslation();
  const editor = useGet(sshConnectionModeEditor$);
  const choose = useSet(chooseSshConnectionMode$);
  const tailscaleEnabled = useGet(tailscaleEnabled$);
  const items = [
    {
      value: "direct",
      label: t(($) => {
        return $.ssh.cloudflare.direct;
      }),
    },
    {
      value: "cloudflare_access",
      label: t(($) => {
        return $.ssh.cloudflare.title;
      }),
    },
    ...(tailscaleEnabled
      ? [
          {
            value: "tailscale" as const,
            label: t(($) => {
              return $.tailscale.title;
            }),
          },
          {
            value: "tailscale_ssh" as const,
            label: t(($) => {
              return $.ssh.tailscale.sshTitle;
            }),
          },
        ]
      : []),
  ] satisfies { value: SshConnectionMode; label: string }[];
  return (
    <div className="grid gap-2">
      <span id="ssh-connection-mode">
        {t(($) => {
          return $.ssh.cloudflare.mode;
        })}
      </span>
      <Select
        items={items}
        value={editor.mode}
        onValueChange={(value, details) => {
          if (value === null) {
            details.cancel();
            return;
          }
          choose(value);
        }}
        disabled={disabled}
      >
        <SelectTrigger aria-labelledby="ssh-connection-mode">
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

function SshConnectionName({
  connection,
}: {
  readonly connection: SshConnectionResponse | null;
}) {
  const { t } = useTranslation();
  const guided = useGet(remoteControlGuidedEnabled$);
  return (
    <label className="grid gap-2">
      {t(($) => {
        return guided ? $.remoteControlSetup.name : $.ssh.displayName;
      })}
      <Input
        name="displayName"
        placeholder={t(($) => {
          return $.ssh.placeholders.displayName;
        })}
        required
        pattern=".*\S.*"
        maxLength={SSH_DISPLAY_NAME_MAX_LENGTH}
        defaultValue={connection?.displayName}
      />
      {guided && (
        <span className="text-sm text-muted-foreground">
          {t(($) => {
            return $.remoteControlSetup.nameHelp;
          })}
        </span>
      )}
    </label>
  );
}

function GuidedSshEndpointFields({
  initialHost,
}: {
  readonly initialHost?: string;
}) {
  const { t } = useTranslation();
  const editor = useGet(sshConnectionModeEditor$);
  return (
    <div className="grid gap-4">
      <label className="grid gap-2">
        {t(($) => {
          return $.remoteControlSetup.address;
        })}
        <Input
          name="host"
          defaultValue={initialHost}
          required
          pattern=".*\S.*"
          maxLength={SSH_HOST_MAX_LENGTH}
        />
      </label>
      {editor.mode === "direct" && (
        <p className="text-sm text-muted-foreground">
          {t(($) => {
            return $.remoteControlSetup.directHelp;
          })}
        </p>
      )}
    </div>
  );
}

function GuidedSshAdvancedFields({
  initialPort,
  disabled,
}: {
  readonly initialPort?: string;
  readonly disabled: boolean;
}) {
  const { t } = useTranslation();
  const editor = useGet(sshConnectionModeEditor$);
  const fixedPort =
    editor.mode === "cloudflare_access" || editor.mode === "tailscale_ssh";
  return (
    <details className="border-t border-divider pt-3">
      <summary className="cursor-pointer rounded-md p-2 text-sm hover:bg-gray-50">
        {t(($) => {
          return $.remoteControlSetup.more;
        })}
      </summary>
      <div className="mt-4 grid gap-4">
        <SshConnectionType disabled={disabled} />
        <label className="grid gap-2">
          {t(($) => {
            return $.ssh.port;
          })}
          <Input
            name="port"
            type="number"
            min={1}
            max={65_535}
            required
            disabled={fixedPort}
            defaultValue={initialPort ?? "22"}
          />
        </label>
      </div>
    </details>
  );
}

function EndpointFields({
  connection,
  disabled,
  initialHost,
  initialPort,
  hideName = false,
}: {
  readonly connection: SshConnectionResponse | null;
  readonly disabled: boolean;
  readonly initialHost?: string;
  readonly initialPort?: string;
  readonly hideName?: boolean;
}) {
  const { t } = useTranslation();
  const editor = useGet(sshConnectionModeEditor$);
  const protectedHost = editor.mode === "cloudflare_access";
  return (
    <fieldset className="grid min-w-0 gap-4">
      <legend hidden={hideName} className="mb-3 text-sm font-semibold">
        {t(($) => {
          return $.ssh.hostSection;
        })}
      </legend>
      {!hideName && <SshConnectionName connection={connection} />}
      <SshConnectionType disabled={disabled} />
      <div
        className={
          protectedHost
            ? "grid gap-4"
            : "grid gap-4 sm:grid-cols-[minmax(0,1fr)_6rem]"
        }
      >
        <label className="grid gap-2">
          {t(($) => {
            return protectedHost
              ? $.ssh.cloudflare.publishedHost
              : editor.mode === "tailscale" || editor.mode === "tailscale_ssh"
                ? $.tailscale.peer
                : $.ssh.host;
          })}
          <Input
            name="host"
            placeholder={t(($) => {
              return $.ssh.placeholders.host;
            })}
            required
            pattern=".*\S.*"
            maxLength={SSH_HOST_MAX_LENGTH}
            defaultValue={connection?.host ?? initialHost}
          />
        </label>
        <label
          hidden={protectedHost || editor.mode === "tailscale_ssh"}
          className={
            protectedHost || editor.mode === "tailscale_ssh"
              ? "hidden"
              : "grid gap-2"
          }
        >
          {t(($) => {
            return $.ssh.port;
          })}
          <Input
            name="port"
            disabled={protectedHost || editor.mode === "tailscale_ssh"}
            type="number"
            className="[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
            required
            min={1}
            max={65_535}
            defaultValue={
              connection &&
              (!("transport" in connection) ||
                connection.transport.type === "tailscale")
                ? connection.port
                : (initialPort ?? 22)
            }
          />
        </label>
        {editor.mode === "tailscale_ssh" && (
          <label className="grid gap-2">
            {t(($) => {
              return $.ssh.port;
            })}
            <Input value="22" disabled />
          </label>
        )}
      </div>
    </fieldset>
  );
}

function PrivateKeyFields({
  optional = false,
}: { readonly optional?: boolean } = {}) {
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
          <label
            className={cn(
              buttonVariants({ variant: "outline", size: "sm" }),
              "has-[:disabled]:pointer-events-none has-[:disabled]:opacity-50 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring has-[:focus-visible]:ring-offset-2",
            )}
          >
            {t(($) => {
              return $.ssh.chooseFile;
            })}
            <input
              id="ssh-private-key-file"
              type="file"
              className="sr-only"
              aria-label={t(($) => {
                return $.ssh.choosePrivateKeyFile;
              })}
              onChange={(event) => {
                detach(
                  importFile(event.currentTarget, signal),
                  Reason.DomCallback,
                );
              }}
            />
          </label>
        </div>
        <Textarea
          id="ssh-private-key"
          ref={mountPrivateKey}
          name="privateKey"
          placeholder={t(($) => {
            return $.ssh.placeholders.privateKey;
          })}
          required={!optional}
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
      <div className="grid gap-2">
        <label htmlFor="ssh-passphrase">
          {t(($) => {
            return $.ssh.passphrase;
          })}
        </label>
        <RemoteSecretInput
          id="ssh-passphrase"
          name="passphrase"
          placeholder={t(($) => {
            return $.ssh.placeholders.passphrase;
          })}
          maxLength={SSH_PASSPHRASE_MAX_LENGTH}
          autoComplete="new-password"
        />
      </div>
    </>
  );
}

function SshAuthenticationFields({
  credential,
  disabled,
  connectionLogin,
  guided,
}: {
  readonly credential: SshCredentialResponse | null;
  readonly disabled: boolean;
  readonly connectionLogin: boolean;
  readonly guided: boolean;
}) {
  const { t } = useTranslation();
  const editor = useGet(sshCredentialEditor$);
  const chooseMethod = useSet(chooseSshAuthMethod$);
  return (
    <>
      <div hidden={guided} className="grid gap-2">
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
        <div key="password" className="grid gap-2">
          <label htmlFor="ssh-password">
            {t(($) => {
              return $.ssh.credential.password;
            })}
          </label>
          <RemoteSecretInput
            id="ssh-password"
            name="password"
            placeholder={
              connectionLogin && credential
                ? t(($) => {
                    return $.remoteControlSetup.keepSavedSecret;
                  })
                : t(($) => {
                    return $.ssh.placeholders.password;
                  })
            }
            required={
              !credential ||
              !connectionLogin ||
              editor.method !== credential.authMethod
            }
            maxLength={SSH_PASSWORD_MAX_LENGTH}
            autoComplete="new-password"
          />
        </div>
      ) : (
        <PrivateKeyFields
          key="private-key"
          optional={
            !!credential &&
            connectionLogin &&
            editor.method === credential.authMethod
          }
        />
      )}
      {guided && (
        <Button
          type="button"
          variant="quiet"
          className="h-auto justify-self-start px-0 text-xs"
          disabled={disabled}
          onClick={() => {
            chooseMethod(
              editor.method === "password" ? "private_key" : "password",
            );
          }}
        >
          {t(($) => {
            return editor.method === "password"
              ? $.remoteControlSetup.useSshKey
              : $.remoteControlSetup.usePassword;
          })}
        </Button>
      )}
    </>
  );
}

function CredentialFields({
  credential,
  disabled,
  connectionLogin = false,
}: {
  readonly credential: SshCredentialResponse | null;
  readonly disabled: boolean;
  readonly connectionLogin?: boolean;
}) {
  const { t } = useTranslation();
  const editor = useGet(sshCredentialEditor$);
  const setup = useGet(remoteSetup$);
  const guided = connectionLogin || setup !== null;
  const replace = useSet(replaceSshAuthentication$);
  return (
    <>
      {guided ? (
        <input
          type="hidden"
          name="credentialName"
          defaultValue={credential?.name ?? ""}
        />
      ) : (
        <label className="grid gap-2">
          {t(($) => {
            return $.ssh.credential.name;
          })}
          <Input
            name="credentialName"
            placeholder={t(($) => {
              return $.ssh.placeholders.credentialName;
            })}
            required
            pattern=".*\S.*"
            maxLength={SSH_DISPLAY_NAME_MAX_LENGTH}
            defaultValue={credential?.name}
          />
        </label>
      )}
      <div className="grid gap-2">
        <div className="flex items-center justify-between gap-2">
          <label htmlFor="ssh-login-username">
            {t(($) => {
              return $.ssh.username;
            })}
          </label>
          <RemoteUsernameHelp />
        </div>
        <Input
          id="ssh-login-username"
          name="username"
          placeholder={t(($) => {
            return $.ssh.placeholders.username;
          })}
          required
          pattern=".*\S.*"
          maxLength={SSH_USERNAME_MAX_LENGTH}
          defaultValue={credential?.username}
        />
      </div>
      {credential && !connectionLogin && (
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            disabled={disabled}
            checked={editor.replace}
            onCheckedChange={(checked) => {
              return replace(checked);
            }}
          />
          {t(($) => {
            return $.ssh.credential.replaceAuthentication;
          })}
        </label>
      )}
      {(!credential || editor.replace || connectionLogin) && (
        <SshAuthenticationFields
          credential={credential}
          disabled={disabled}
          connectionLogin={connectionLogin}
          guided={guided}
        />
      )}
    </>
  );
}

function useSshCredentialSelection() {
  const { t } = useTranslation();
  const credentials = useLoadable(sshCredentials$);
  const editor = useGet(sshCredentialEditor$);
  const guided = useGet(remoteControlGuidedEnabled$);
  const dialog = useLastResolved(sshDialog$);
  const sessionKey = useGet(authenticatedSessionKey$);
  const login =
    guided &&
    dialog?.sessionKey === sessionKey &&
    dialog?.kind === "edit" &&
    dialog.loginCredential?.id === editor.selection
      ? dialog.loginCredential
      : null;
  const choose = useSet(chooseSshCredential$);
  const credentialItems = [
    ...(credentials.state === "hasData" && credentials.data
      ? credentials.data.map((credential) => {
          return {
            value: credential.id,
            label: `${credential.name} · ${credential.username}`,
          };
        })
      : []),
    {
      value: "new",
      label: t(($) => {
        return $.ssh.credential.createNew;
      }),
    },
  ];
  return { credentials, editor, guided, login, choose, credentialItems };
}

function SshSavedLoginPicker({ disabled }: { readonly disabled: boolean }) {
  const { t } = useTranslation();
  const credentials = useLoadable(sshCredentials$);
  const choose = useSet(chooseSshCredential$);
  return (
    <RemoteLoginPicker
      protocol="ssh"
      disabled={disabled}
      choose={(value) => {
        choose(value);
      }}
      items={(credentials.state === "hasData"
        ? (credentials.data ?? [])
        : []
      ).map((credential) => {
        return {
          value: credential.id,
          label:
            credential.hosts
              .map((host) => {
                return host.displayName;
              })
              .join(", ") || credential.name,
          description: `${credential.username} · ${t(($) => {
            return credential.authMethod === "password"
              ? $.ssh.credential.password
              : $.ssh.privateKey;
          })}`,
        };
      })}
    />
  );
}

function missingSshCredential({
  credentials,
  editor,
}: Pick<
  ReturnType<typeof useSshCredentialSelection>,
  "credentials" | "editor"
>) {
  return (
    credentials.state === "hasData" &&
    credentials.data &&
    editor.selection &&
    editor.selection !== "new" &&
    !credentials.data.some((credential) => {
      return credential.id === editor.selection;
    })
  );
}

function CredentialSelection({ disabled }: { readonly disabled: boolean }) {
  const { t } = useTranslation();
  const { credentials, editor, guided, login, choose, credentialItems } =
    useSshCredentialSelection();
  return (
    <fieldset className="grid min-w-0 gap-4">
      <legend hidden={guided} className="mb-3 text-sm font-semibold">
        <label htmlFor="ssh-selected-credential">
          {t(($) => {
            return $.ssh.credential.label;
          })}
        </label>
      </legend>
      <div
        hidden={
          guided && credentials.state === "hasData" && credentials.data !== null
        }
        className="grid gap-2"
      >
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
            items={credentialItems}
            disabled={disabled}
            value={editor.selection || null}
            onValueChange={(value, details) => {
              if (value === null) {
                details.cancel();
                return;
              }
              choose(value);
            }}
          >
            <SelectTrigger id="ssh-selected-credential">
              <SelectValue
                placeholder={t(($) => {
                  return $.ssh.credential.select;
                })}
              />
            </SelectTrigger>
            <SelectContent>
              {credentialItems.map((item) => {
                return (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
        )}
      </div>
      {missingSshCredential({ credentials, editor }) && (
        <p role="alert">
          {t(($) => {
            return $.ssh.errors.credentialUnavailable;
          })}
        </p>
      )}
      {guided && login && (
        <CredentialFields
          credential={login}
          disabled={disabled}
          connectionLogin
        />
      )}
      {guided && editor.selection && editor.selection !== "new" && !login && (
        <RemoteSelectedLogin
          disabled={disabled}
          label={
            credentialItems.find((item) => {
              return item.value === editor.selection;
            })?.label
          }
          chooseNew={() => {
            choose("new");
          }}
        />
      )}
      {editor.selection === "new" && (
        <div
          className={
            guided
              ? "grid gap-4"
              : "grid gap-4 rounded-lg border bg-muted/30 p-4"
          }
        >
          <CredentialFields
            credential={null}
            disabled={disabled}
            connectionLogin={guided}
          />
        </div>
      )}
      {guided && <SshSavedLoginPicker disabled={disabled} />}
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

function tailscaleReviewBlocked(
  editing: boolean,
  enabled: boolean,
  mode: SshConnectionMode,
) {
  return (
    editing && (!enabled || (mode !== "tailscale" && mode !== "tailscale_ssh"))
  );
}

function SshConflictDetails({
  current,
}: {
  readonly current: SshConflictReviewState;
}) {
  const { t } = useTranslation();
  const enabled = useGet(tailscaleEnabled$);
  const connectionEditor = useGet(sshConnectionModeEditor$);
  const acceptReview = useSet(acceptSshConflictReview$);
  const signal = useGet(pageSignal$);
  const deleting = current.kind === "delete";
  const editingTailscale =
    current.kind === "edit" && usesTailscaleNetwork(current.connection);
  return (
    <>
      <h3 className="font-semibold">
        {t(($) => {
          return $.ssh.cloudflare.latest;
        })}
      </h3>
      {current.credential && (
        <>
          <p>
            {current.credential.name} · {current.credential.username}
          </p>
          <CredentialImpact credential={current.credential} />
        </>
      )}
      {current.connection && (
        <div className="grid gap-1">
          {deleting && (
            <p>
              {t(
                ($) => {
                  return $.ssh.deleteReview.version;
                },
                { version: current.connection.generation },
              )}
            </p>
          )}
          <p>{current.connection.displayName}</p>
          <p className="break-all">
            {current.connection.username}@{current.connection.host}:
            {current.connection.port}
          </p>
          <p>
            {"credentialName" in current.connection
              ? current.connection.credentialName
              : t(($) => {
                  return $.ssh.tailscale.sshTitle;
                })}
          </p>
          <p>
            {"transport" in current.connection
              ? current.connection.transport.type === "tailscale" ||
                current.connection.transport.type === "tailscale_ssh"
                ? "Tailscale"
                : t(($) => {
                    return $.ssh.cloudflare.title;
                  })
              : t(($) => {
                  return $.ssh.cloudflare.direct;
                })}
          </p>
        </div>
      )}
      <p role={editingTailscale ? "alert" : undefined}>
        {t(($) => {
          return editingTailscale
            ? enabled
              ? $.tailscale.rebindHelp
              : $.ssh.tailscale.editUnavailable
            : deleting
              ? $.ssh.deleteReview.help
              : $.ssh.cloudflare.reviewHelp;
        })}
      </p>
      <Button
        type="button"
        variant="outline"
        disabled={
          tailscaleReviewBlocked(
            editingTailscale,
            enabled,
            connectionEditor.mode,
          ) ||
          (current.kind === "delete-credential" &&
            (current.credential?.hosts.length ?? 0) > 0)
        }
        onClick={() => {
          return detach(acceptReview(current, signal), Reason.DomCallback);
        }}
      >
        {t(($) => {
          return deleting
            ? $.ssh.deleteReview.acknowledge
            : $.ssh.cloudflare.keepChanges;
        })}
      </Button>
    </>
  );
}

function SshConflictReview({ dialog }: { readonly dialog: SshDialogState }) {
  const { t } = useTranslation();
  const conflict = useGet(sshConflict$);
  const review = useLoadable(sshConflictReview$);
  if (!conflict) {
    return null;
  }
  const current = review.state === "hasData" ? review.data : null;
  const deleting = dialog.kind === "delete";
  const hostConflict = conflict === SSH_ERROR_CODES.GENERATION_CONFLICT;
  return (
    <div className="grid gap-3 rounded-lg border p-4 text-sm">
      <p role="alert">
        {deleting && hostConflict
          ? t(($) => {
              return $.ssh.deleteReview.changed;
            })
          : (localizedSshError(conflict) ??
            t(($) => {
              return $.ssh.errors.failed;
            }))}
      </p>
      {review.state === "hasError" && <SshLoadError />}
      {review.state === "loading" && (
        <p role="status">
          {t(($) => {
            return hostConflict ? $.ssh.loading : $.ssh.credential.loading;
          })}
        </p>
      )}
      {deleting &&
        review.state === "hasData" &&
        !current &&
        (hostConflict || conflict === SSH_ERROR_CODES.CONNECTION_NOT_FOUND) && (
          <p>
            {t(($) => {
              return $.ssh.deleteReview.unavailable;
            })}
          </p>
        )}
      {current && <SshConflictDetails current={current} />}
    </div>
  );
}

function useDialogCopy(dialog: SshDialogState | null, inline: boolean) {
  const { t } = useTranslation();
  const editor = useGet(sshConnectionModeEditor$);
  if (inline && dialog?.kind === "edit") {
    return {
      title: t(($) => {
        return $.remoteControlSetup.editConnection;
      }),
      description: `${dialog.connection?.displayName ?? ""} · ${t(($) => {
        return $.ssh.label;
      })}`,
    };
  }
  if (inline && dialog?.kind === "create") {
    return {
      title: t(($) => {
        return editor.mode === "direct"
          ? $.remoteControlSetup.directTitle
          : $.remoteControlSetup.loginTitle;
      }),
      description: t(($) => {
        return editor.mode === "direct"
          ? $.remoteControlSetup.directDescription
          : $.remoteControlSetup.loginDescription;
      }),
    };
  }
  switch (dialog?.kind) {
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
          return dialog.connection && !("credentialId" in dialog.connection)
            ? $.ssh.tailscale.deleteHelp
            : $.ssh.deleteHelp;
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

interface SshFormProps {
  readonly dialog: SshDialogState;
  readonly isSaving: boolean;
  readonly save: (
    form: HTMLFormElement,
    signal: AbortSignal,
  ) => Promise<unknown>;
  readonly inline?: boolean;
  readonly onCancel?: () => void;
  readonly initialHost?: string;
  readonly initialPort?: string;
}

function SshSaveNotice({ isSaving }: { readonly isSaving: boolean }) {
  const { t } = useTranslation();
  const uncertain = useGet(sshSaveUncertain$);
  const message = useGet(sshSaveMessage$);
  if (isSaving || (!uncertain && !message)) {
    return null;
  }
  return (
    <p role="alert" className="text-sm text-muted-foreground">
      {uncertain
        ? t(($) => {
            return $.ssh.saveRecovery.uncertain;
          })
        : (localizedSshError(message ?? "") ??
          t(($) => {
            return $.ssh.errors.invalidInput;
          }))}
    </p>
  );
}

function SshSaveLabel({
  isSaving,
  uncertain,
  destructive,
  title,
  hostEditor,
}: {
  readonly isSaving: boolean;
  readonly uncertain: boolean;
  readonly destructive: boolean;
  readonly title: string;
  readonly hostEditor: boolean;
}) {
  const { t } = useTranslation();
  return isSaving
    ? t(($) => {
        return $.connectors.actions.saving;
      })
    : uncertain
      ? t(($) => {
          return $.ssh.retry;
        })
      : destructive
        ? title
        : t(($) => {
            return hostEditor ? $.remoteControlSetup.saveOnly : $.ssh.save;
          });
}

function SshFormActions({
  isSaving,
  blocked,
  destructive,
  title,
  inline,
  onCancel,
}: {
  readonly isSaving: boolean;
  readonly blocked: boolean;
  readonly destructive: boolean;
  readonly title: string;
  readonly inline?: boolean;
  readonly onCancel?: () => void;
}) {
  const { t } = useTranslation();
  const close = useSet(closeSshDialog$);
  const uncertain = useGet(sshSaveUncertain$);
  const guided = useGet(remoteControlGuidedEnabled$);
  const dialog = useLastResolved(sshDialog$);
  const hostEditor =
    guided && (dialog?.kind === "create" || dialog?.kind === "edit");
  return (
    <div
      className={
        inline
          ? "mt-2 flex shrink-0 justify-end gap-2 border-t border-divider pt-5"
          : "flex shrink-0 justify-end gap-2"
      }
    >
      {(!inline || dialog?.kind === "edit") && (
        <Button
          type="button"
          variant="outline"
          disabled={isSaving}
          onClick={onCancel ?? close}
        >
          {t(($) => {
            return $.ssh.cancel;
          })}
        </Button>
      )}
      <Button
        type="submit"
        className={
          inline && !destructive && !hostEditor ? REMOTE_PAGE_ACTION : undefined
        }
        disabled={isSaving || (!uncertain && blocked)}
        variant={destructive ? "destructive" : hostEditor ? "quiet" : "default"}
      >
        <SshSaveLabel
          isSaving={isSaving}
          uncertain={uncertain}
          destructive={destructive}
          title={title}
          hostEditor={hostEditor}
        />
      </Button>
      {hostEditor && (
        <Button
          disabled
          className={inline ? REMOTE_PAGE_ACTION : undefined}
          title={t(($) => {
            return $.remoteControlSetup.checkUnavailableHelp;
          })}
        >
          {t(($) => {
            return $.remoteControlSetup.saveAndCheck;
          })}
        </Button>
      )}
    </div>
  );
}

function hasResourceSelection(
  resources: readonly { readonly id: string }[] | null,
  selection: string | null,
) {
  return (
    resources !== null &&
    (selection === "new" ||
      resources.some((resource) => {
        return resource.id === selection;
      }))
  );
}

function useTailscaleSelectionBlocked(
  hostEditor: boolean,
  mode: SshConnectionMode,
  configId: string | null,
) {
  const configs = useLoadable(tailscaleConfigs$);
  return (
    hostEditor &&
    (mode === "tailscale" || mode === "tailscale_ssh") &&
    (configs.state !== "hasData" ||
      !hasResourceSelection(configs.data, configId))
  );
}

function useSshHostSaveBlocked(dialog: SshDialogState, isSaving: boolean) {
  const configs = useLoadable(cloudflareAccessConfigs$);
  const connectionEditor = useGet(sshConnectionModeEditor$);
  const conflict = useGet(sshConflict$);
  const fileResult = useLoadable(sshPrivateKeyFileResult$);
  const credentials = useLoadable(sshCredentials$);
  const credentialEditor = useGet(sshCredentialEditor$);
  const hostEditor = dialog.kind === "create" || dialog.kind === "edit";
  const invalidTailscale = useTailscaleSelectionBlocked(
    hostEditor,
    connectionEditor.mode,
    connectionEditor.tailscaleConfigId,
  );
  const unavailableProtectedHost =
    dialog.connection !== null &&
    "transport" in dialog.connection &&
    dialog.connection.transport.type === "cloudflare_access" &&
    "configId" in dialog.connection.transport &&
    configs.state === "hasData" &&
    configs.data === null;
  const invalidAccess =
    hostEditor &&
    connectionEditor.mode === "cloudflare_access" &&
    (configs.state !== "hasData" ||
      !hasResourceSelection(configs.data, connectionEditor.configId));
  const invalidCredential =
    hostEditor &&
    connectionEditor.mode !== "tailscale_ssh" &&
    (credentials.state !== "hasData" ||
      !hasResourceSelection(credentials.data, credentialEditor.selection));
  return (
    isSaving ||
    fileResult.state === "loading" ||
    unavailableProtectedHost ||
    invalidAccess ||
    invalidTailscale ||
    invalidCredential ||
    !!conflict
  );
}

function TailscaleSshLogin({
  connection,
  active,
  disabled,
}: {
  readonly connection: SshConnectionResponse | null;
  readonly active: boolean;
  readonly disabled: boolean;
}) {
  const { t } = useTranslation();
  return (
    <fieldset
      hidden={!active}
      disabled={disabled || !active}
      className={active ? "grid gap-2" : "hidden"}
    >
      <div className="grid gap-2">
        <div className="flex items-center justify-between gap-2">
          <label htmlFor="tailscale-ssh-login-username">
            {t(($) => {
              return $.ssh.tailscale.username;
            })}
          </label>
          <RemoteUsernameHelp />
        </div>
        <Input
          id="tailscale-ssh-login-username"
          name="tailscaleSshUsername"
          disabled={disabled || !active}
          required
          pattern=".*\S.*"
          maxLength={SSH_USERNAME_MAX_LENGTH}
          defaultValue={connection?.username}
          placeholder="ubuntu"
        />
      </div>
      <p className="text-sm text-muted-foreground">
        {t(($) => {
          return $.ssh.tailscale.sshHelp;
        })}
      </p>
      <a
        href="https://tailscale.com/docs/features/tailscale-ssh"
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex w-fit items-center gap-1 text-sm text-link underline underline-offset-4 hover:text-link-hover"
      >
        {t(($) => {
          return $.ssh.tailscale.sshDocs;
        })}
        <ExternalLink size={12} aria-hidden />
      </a>
    </fieldset>
  );
}

function SshRebindNotice({
  connection,
}: {
  readonly connection: SshConnectionResponse | null;
}) {
  const { t } = useTranslation();
  return (
    <>
      {connection &&
        "transport" in connection &&
        "needsRebind" in connection.transport && (
          <p
            role="alert"
            className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
          >
            {t(($) => {
              return connection &&
                "transport" in connection &&
                (connection.transport.type === "tailscale" ||
                  connection.transport.type === "tailscale_ssh")
                ? $.tailscale.rebindHelp
                : $.ssh.cloudflare.rebindHelp;
            })}
          </p>
        )}
    </>
  );
}
function SshHostFields({
  dialog,
  inline,
  initialHost,
  initialPort,
  fieldsDisabled,
}: {
  readonly dialog: SshDialogState;
  readonly inline: boolean;
  readonly initialHost?: string;
  readonly initialPort?: string;
  readonly fieldsDisabled: boolean;
}) {
  const { t } = useTranslation();
  const guided = useGet(remoteControlGuidedEnabled$);
  const connectionEditor = useGet(sshConnectionModeEditor$);
  return (
    <>
      <SshRebindNotice connection={dialog.connection} />
      {guided && dialog.kind === "edit" ? (
        <>
          <SshConnectionName connection={dialog.connection} />
          <details className="border-t border-divider pt-4">
            <summary className="cursor-pointer text-sm font-medium">
              {t(($) => {
                return $.remoteControlSetup.connectionSettings;
              })}
            </summary>
            <div className="mt-4 grid gap-4">
              <EndpointFields
                connection={dialog.connection}
                disabled={fieldsDisabled}
                hideName
              />
              {connectionEditor.mode === "cloudflare_access" && (
                <AccessSelection disabled={fieldsDisabled} />
              )}
              {(connectionEditor.mode === "tailscale" ||
                connectionEditor.mode === "tailscale_ssh") && (
                <TailscaleSelection disabled={fieldsDisabled} />
              )}
            </div>
          </details>
          <h2 className="text-base font-medium">
            {t(($) => {
              return $.remoteControlSetup.loginHeading;
            })}
          </h2>
        </>
      ) : (
        <>
          {inline && dialog.kind === "create" ? (
            <GuidedSshEndpointFields initialHost={initialHost} />
          ) : (
            <EndpointFields
              connection={dialog.connection}
              disabled={fieldsDisabled}
            />
          )}
          {connectionEditor.mode === "cloudflare_access" && (
            <AccessSelection disabled={fieldsDisabled} />
          )}
          {(connectionEditor.mode === "tailscale" ||
            connectionEditor.mode === "tailscale_ssh") && (
            <TailscaleSelection disabled={fieldsDisabled} />
          )}
        </>
      )}
      <TailscaleSshLogin
        connection={dialog.connection}
        active={connectionEditor.mode === "tailscale_ssh"}
        disabled={fieldsDisabled}
      />
      <fieldset
        hidden={connectionEditor.mode === "tailscale_ssh"}
        disabled={connectionEditor.mode === "tailscale_ssh"}
        className={
          connectionEditor.mode === "tailscale_ssh"
            ? "hidden"
            : "grid min-w-0 gap-4"
        }
      >
        <CredentialSelection
          disabled={fieldsDisabled || connectionEditor.mode === "tailscale_ssh"}
        />
      </fieldset>
      {inline && dialog.kind === "create" && (
        <>
          <SshConnectionName connection={null} />
          <GuidedSshAdvancedFields
            initialPort={initialPort}
            disabled={fieldsDisabled}
          />
        </>
      )}
    </>
  );
}

function SshHostForm({
  dialog,
  isSaving,
  save,
  inline = false,
  onCancel,
  initialHost,
  initialPort,
}: SshFormProps) {
  const { t } = useTranslation();
  const uncertain = useGet(sshSaveUncertain$);
  const guided = useGet(remoteControlGuidedEnabled$);
  const credentialEditor = useGet(sshCredentialEditor$);
  const confirmLogin = useSet(requestRemoteLoginSave$);
  const fieldsDisabled = isSaving || uncertain;
  const connectionEditor = useGet(sshConnectionModeEditor$);
  const mountForm = useSet(mountSshForm$);
  const signal = useGet(pageSignal$);
  const blocked = useSshHostSaveBlocked(dialog, isSaving);
  const { title } = useDialogCopy(dialog, inline);
  const hostEditor = dialog.kind === "create" || dialog.kind === "edit";
  const destructive = ["delete", "reset", "delete-credential"].includes(
    dialog.kind,
  );
  return (
    <form
      ref={mountForm}
      id={guided ? "remote-ssh-edit-form" : undefined}
      className="flex min-h-0 min-w-0 flex-col gap-4"
      autoComplete="off"
      aria-busy={isSaving}
      onSubmit={(event) => {
        event.preventDefault();
        if (isSaving || (!uncertain && blocked)) {
          return;
        }
        if (
          guided &&
          dialog.kind === "edit" &&
          dialog.loginCredential &&
          credentialEditor.selection === dialog.loginCredential.id &&
          connectionEditor.mode !== "tailscale_ssh" &&
          !confirmLogin(
            "ssh",
            dialog.loginCredential.hosts,
            sshLoginPatch(
              event.currentTarget,
              dialog.loginCredential,
              credentialEditor.method,
            ) !== null,
          )
        ) {
          return;
        }
        // Keep retryable input only in this form, never in ccstate or caches.
        detach(save(event.currentTarget, signal), Reason.DomCallback);
      }}
    >
      <DialogBody className="grid gap-4">
        {!destructive && (
          <fieldset
            disabled={fieldsDisabled}
            className={hostEditor ? "grid min-w-0 gap-6" : "grid min-w-0 gap-4"}
          >
            {hostEditor ? (
              <SshHostFields
                dialog={dialog}
                inline={inline}
                initialHost={initialHost}
                initialPort={initialPort}
                fieldsDisabled={fieldsDisabled}
              />
            ) : (
              <CredentialFields
                credential={dialog.credential}
                disabled={fieldsDisabled}
              />
            )}
          </fieldset>
        )}
        {dialog.credential && (
          <CredentialImpact credential={dialog.credential} />
        )}
        <SshConflictReview dialog={dialog} />
        <SshSaveNotice isSaving={isSaving} />
        {dialog.connectionSaved && (
          <p role="alert" className="text-sm text-muted-foreground">
            {t(($) => {
              return $.remoteControlSetup.partialLoginSave;
            })}
          </p>
        )}
      </DialogBody>
      <SshFormActions
        isSaving={isSaving}
        blocked={blocked}
        destructive={destructive}
        title={title}
        inline={inline}
        onCancel={onCancel}
      />
      {guided && <RemoteLoginConfirmation protocol="ssh" />}
    </form>
  );
}

export function SshDialog({
  inline = false,
  saveAction = saveSsh$,
  onCancel,
  initialHost,
  initialPort,
}: {
  readonly inline?: boolean;
  readonly saveAction?: typeof saveSsh$;
  readonly onCancel?: () => void;
  readonly initialHost?: string;
  readonly initialPort?: string;
} = {}) {
  const lastDialog = useLastResolved(sshDialog$);
  const sessionKey = useGet(authenticatedSessionKey$);
  const editor = useGet(sshConnectionModeEditor$);
  const tailscaleEnabled = useGet(tailscaleEnabled$);
  const close = useSet(closeSshDialog$);
  const [saving, save] = useLoadableSet(saveAction);
  const dialog = lastDialog?.sessionKey === sessionKey ? lastDialog : null;
  const { title, description } = useDialogCopy(dialog, inline);
  const isSaving = saving.state === "loading";
  if (
    !dialog ||
    ((dialog.kind === "create" || dialog.kind === "edit") &&
      (editor.mode === "tailscale" || editor.mode === "tailscale_ssh") &&
      !tailscaleEnabled)
  ) {
    return null;
  }
  return (
    <RemoteEditorFrame
      key={dialog.instanceId}
      inline={inline}
      title={title}
      description={description}
      busy={isSaving}
      onClose={onCancel ?? close}
    >
      <SshHostForm
        dialog={dialog}
        isSaving={isSaving}
        save={save}
        inline={inline}
        onCancel={onCancel}
        initialHost={initialHost}
        initialPort={initialPort}
      />
    </RemoteEditorFrame>
  );
}

function cloudflareConfigId(connection: SshConnectionResponse): string | null {
  return "transport" in connection &&
    connection.transport.type === "cloudflare_access" &&
    "configId" in connection.transport
    ? connection.transport.configId
    : null;
}

function HostKeyIdentity({
  connection,
}: {
  readonly connection: SshConnectionResponse;
}) {
  const { t } = useTranslation();
  return (
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
  );
}

function TailscaleHostLabel({
  configId,
}: {
  readonly configId: string | null;
}) {
  const { t } = useTranslation();
  const configs = useLoadable(tailscaleConfigs$);
  const config =
    configs.state === "hasData"
      ? configs.data?.find((value) => {
          return value.id === configId;
        })
      : null;
  return (
    <p className="text-sm text-muted-foreground">
      {config
        ? t(
            ($) => {
              return $.tailscale.protectedHost;
            },
            { name: config.name },
          )
        : t(($) => {
            return $.tailscale.title;
          })}
    </p>
  );
}

function useSshHostDetails(connection: SshConnectionResponse) {
  const configs = useLoadable(cloudflareAccessConfigs$);
  const tailscaleEnabled = useGet(tailscaleEnabled$);
  const transport = "transport" in connection ? connection.transport : null;
  const tailscale = usesTailscaleNetwork(connection);
  const configId = cloudflareConfigId(connection);
  const needsRebind =
    "transport" in connection && "needsRebind" in connection.transport;
  const unavailable =
    configId !== null && configs.state === "hasData" && configs.data === null;
  const config =
    configs.state === "hasData"
      ? configs.data?.find((value) => {
          return value.id === configId;
        })
      : null;
  return {
    transport,
    tailscale,
    tailscaleEnabled,
    configId,
    needsRebind,
    unavailable,
    config,
  };
}
function SshHostOverview({
  connection,
  detail,
}: {
  readonly connection: SshConnectionResponse;
  readonly detail: boolean;
}) {
  const { t } = useTranslation();
  const {
    transport,
    tailscale,
    tailscaleEnabled,
    configId,
    needsRebind,
    unavailable,
    config,
  } = useSshHostDetails(connection);
  return (
    <>
      {" "}
      {detail ? (
        <RemoteConnectionSummary
          connection={connection}
          protocol="ssh"
          account={connection.username}
          route={
            tailscale ? (
              <TailscaleHostLabel
                configId={
                  transport && "configId" in transport
                    ? transport.configId
                    : null
                }
              />
            ) : (
              (config?.name ??
              t(($) => {
                return configId
                  ? $.cloudflareAccess.title
                  : $.remoteControlSetup.direct;
              }))
            )
          }
        />
      ) : (
        <h2 className="font-semibold">{connection.displayName}</h2>
      )}
      {needsRebind ? (
        <p
          role="alert"
          className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
        >
          {t(($) => {
            return tailscale
              ? tailscaleEnabled
                ? $.tailscale.rebindAvailable
                : $.ssh.tailscale.needsRebind
              : $.ssh.cloudflare.needsRebind;
          })}
        </p>
      ) : (
        <SshHostWarning
          connectionId={connection.id}
          generation={connection.generation}
          createdAt={connection.createdAt}
          tailscaleSsh={transport?.type === "tailscale_ssh"}
        />
      )}
      {!detail && (
        <>
          <p className="text-sm text-muted-foreground">
            {"credentialName" in connection
              ? connection.credentialName
              : t(($) => {
                  return $.ssh.tailscale.sshTitle;
                })}
          </p>
          <p className="break-all text-sm">
            {connection.username}@{connection.host}:{connection.port}
          </p>
          {tailscale && (
            <TailscaleHostLabel
              configId={
                transport && "configId" in transport ? transport.configId : null
              }
            />
          )}
          {configId && (
            <p className="text-sm text-muted-foreground">
              {unavailable
                ? t(($) => {
                    return $.ssh.cloudflare.unavailable;
                  })
                : config
                  ? t(
                      ($) => {
                        return $.ssh.cloudflare.protectedHost;
                      },
                      { name: config.name },
                    )
                  : t(($) => {
                      return $.ssh.cloudflare.title;
                    })}
            </p>
          )}
        </>
      )}
    </>
  );
}

export function SshHostCard({
  connection,
  detail = false,
}: {
  readonly connection: SshConnectionResponse;
  readonly detail?: boolean;
}) {
  const { t } = useTranslation();
  const open = useSet(openSshDialog$);
  const signal = useGet(pageSignal$);
  const { unavailable, tailscale, tailscaleEnabled } =
    useSshHostDetails(connection);
  return (
    <article
      className={
        detail ? "grid gap-4" : surfaceVariants({ className: "grid gap-3 p-5" })
      }
    >
      <SshHostOverview connection={connection} detail={detail} />
      {detail ? (
        <details className="border-t border-divider pt-4">
          <summary className="cursor-pointer text-sm text-muted-foreground">
            {t(($) => {
              return $.remoteControlSetup.securityAndPermissions;
            })}
          </summary>
          <div className="mt-3 grid gap-3">
            <HostKeyIdentity connection={connection} />
            <RemoteHostDefaultToggle
              protocol="ssh"
              connectionId={connection.id}
            />
          </div>
        </details>
      ) : (
        <>
          <HostKeyIdentity connection={connection} />
          <RemoteHostDefaultToggle
            protocol="ssh"
            connectionId={connection.id}
          />
        </>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          variant={detail ? "quiet" : "outline"}
          disabled={unavailable || (tailscale && !tailscaleEnabled)}
          onClick={() => {
            return detach(open("edit", connection, signal), Reason.DomCallback);
          }}
        >
          {t(($) => {
            return $.ssh.edit;
          })}
        </Button>
        <Button
          variant={detail ? "quiet" : "outline"}
          disabled={unavailable || !connection.learnedHostKey}
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
          variant={detail ? "quiet" : "outline"}
          disabled={unavailable}
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
      {detail && <RemoteConnectionCheckUnavailable />}
    </article>
  );
}

export function SshHosts() {
  const { t } = useTranslation();
  const hosts = useLoadable(sshConnections$);
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
      {hosts.data.length > 0 ? <SshAttention connections={hosts.data} /> : null}
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
      {hosts.data.length === 0 && (
        <p className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
          {t(($) => {
            return $.ssh.empty;
          })}
        </p>
      )}
      {hosts.data.map((connection) => {
        return <SshHostCard key={connection.id} connection={connection} />;
      })}
    </div>
  );
}

export function SshCredentials() {
  const { t } = useTranslation();
  const credentials = useLoadable(sshCredentials$);
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
            className={surfaceVariants({ className: "grid gap-3 p-5" })}
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
