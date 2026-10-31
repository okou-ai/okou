import { RemoteSecretInput } from "./remote-secret-input.tsx";
import {
  RemoteCredentialCard,
  RemoteCredentialReplacement,
} from "./remote-credential-card.tsx";
import { RemoteAddressHelp, SshPrivateKeyHelp } from "./remote-field-help.tsx";
import { RemoteConnectionSummary } from "./remote-connection-summary.tsx";
import { authenticatedSessionKey$ } from "../../signals/auth.ts";
import {
  useLastLoadable,
  useLastResolved,
  useGet,
  useLoadable,
  useSet,
} from "ccstate-react";
import { RemoteConnectionEditButton } from "./remote-connection-edit-button.tsx";
import { RemoteFormFooter } from "./remote-form-footer.tsx";
import {
  RemoteLoginPicker,
  RemoteSelectedLogin,
  RemoteLoginConfirmation,
} from "./remote-login-controls.tsx";
import { requestRemoteLoginSave$ } from "../../signals/remote-login.ts";
import {
  sshLoginPatch,
  type SshDialogState,
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
  sshSaveUncertain$,
  sshSaveMessage$,
  importSshPrivateKeyFile$,
  mountSshPrivateKey$,
  mountSshForm$,
  sshConnectionModeEditor$,
  chooseSshConnectionMode$,
  usesTailscaleNetwork,
} from "../../signals/ssh.ts";
import { RemoteConnectionNetwork } from "./remote-connection-network.tsx";
import { ComputerNetworkSummary } from "./remote-computer-setup.tsx";
import {
  remoteSetup$,
  remoteControlGuidedEnabled$,
  updateRemoteSetup$,
} from "../../signals/remote-control-setup.ts";
import {
  RemoteEditorFrame,
  RemoteUsernameHelp,
} from "./remote-editor-frame.tsx";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import { buttonVariants } from "@okouai/ui/components/ui/button";
import { cn } from "@okouai/ui/lib/utils";
import { ExternalLink, KeyRound, LockKeyhole, Plus } from "lucide-react";
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
import { SSH_HOST_MAX_LENGTH } from "@okouai/api-contracts/validators/ssh-connections";
import type {
  SshConnectionResponse,
  SshConnectionMode,
} from "@okouai/api-contracts/contracts/ssh-connections";
import { cloudflareAccessConfigs$ } from "../../signals/cloudflare-access.ts";
import { AccessSelection } from "./ssh-cloudflare-access.tsx";
import { TailscaleSelection } from "./ssh-tailscale.tsx";
import { tailscaleConfigs$ } from "../../signals/tailscale.ts";
import {
  SSH_DISPLAY_NAME_MAX_LENGTH,
  SSH_USERNAME_MAX_LENGTH,
  SSH_PRIVATE_KEY_MAX_LENGTH,
  SSH_PASSPHRASE_MAX_LENGTH,
  SSH_PASSWORD_MAX_LENGTH,
} from "@okouai/api-contracts/validators/ssh-credentials";
import type { SshCredentialResponse } from "@okouai/api-contracts/contracts/ssh-credentials";
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
    {
      value: "tailscale",
      label: t(($) => {
        return $.tailscale.title;
      }),
    },
    {
      value: "tailscale_ssh",
      label: t(($) => {
        return $.ssh.tailscale.sshTitle;
      }),
    },
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
          return guided
            ? $.remoteControlSetup.namePlaceholder
            : $.ssh.placeholders.displayName;
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
  const setup = useGet(remoteSetup$);
  const updateSetup = useSet(updateRemoteSetup$);
  return (
    <div className="grid gap-3">
      <div className="grid gap-2">
        <div className="flex items-center gap-1">
          <label htmlFor="guided-ssh-host">
            {t(($) => {
              return $.remoteControlSetup.address;
            })}
          </label>
          <RemoteAddressHelp route={editor.mode} />
        </div>
        <Input
          id="guided-ssh-host"
          name="host"
          value={setup?.address ?? initialHost ?? ""}
          onChange={(event) => {
            updateSetup({ address: event.currentTarget.value });
          }}
          required
          pattern=".*\S.*"
          maxLength={SSH_HOST_MAX_LENGTH}
        />
      </div>
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

function GuidedSshConnectionName() {
  const { t } = useTranslation();
  const setup = useGet(remoteSetup$);
  return (
    <details className="text-sm">
      <summary className="w-fit cursor-pointer rounded-md py-1 text-muted-foreground hover:text-foreground">
        {t(($) => {
          return $.remoteControlSetup.optionalName;
        })}
      </summary>
      <div className="mt-3 grid gap-2">
        <input type="hidden" name="displayName" />
        <Input
          name="connectionLabel"
          aria-label={t(($) => {
            return $.remoteControlSetup.name;
          })}
          aria-describedby="ssh-connection-name-help"
          placeholder={
            setup?.address ||
            t(($) => {
              return $.remoteControlSetup.namePlaceholder;
            })
          }
          pattern=".*\S.*"
          maxLength={SSH_DISPLAY_NAME_MAX_LENGTH}
        />
        <p id="ssh-connection-name-help" className="text-muted-foreground">
          {t(($) => {
            return $.remoteControlSetup.automaticNameHelp;
          })}
        </p>
      </div>
    </details>
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
    <details>
      <summary className="w-fit cursor-pointer rounded-md py-1 text-sm text-muted-foreground hover:text-foreground">
        {t(($) => {
          return $.remoteControlSetup.more;
        })}
      </summary>
      <div className="mt-4 grid gap-4">
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
            disabled={disabled || fixedPort}
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
  guided = false,
}: { readonly optional?: boolean; readonly guided?: boolean } = {}) {
  const { t } = useTranslation();
  const [result, importFile] = useLoadableSet(importSshPrivateKeyFile$);
  const mountPrivateKey = useSet(mountSshPrivateKey$);
  const signal = useGet(pageSignal$);
  return (
    <>
      <div className="grid gap-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1">
            <label htmlFor="ssh-private-key">
              {t(($) => {
                return $.ssh.privateKey;
              })}
            </label>
            <SshPrivateKeyHelp />
          </div>
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
          aria-describedby="ssh-private-key-help"
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
            detach(importFile(null, signal), Reason.DomCallback);
          }}
        />
        <p id="ssh-private-key-help" className="text-sm text-muted-foreground">
          {t(($) => {
            return guided
              ? $.remoteControlSetup.sshPrivateKeyHelp
              : $.ssh.credentialsHelp;
          })}
        </p>
        {result.state === "loading" && (
          <p role="status" className="text-sm text-muted-foreground">
            {t(($) => {
              return $.ssh.fileReading;
            })}
          </p>
        )}
        {((result.state === "hasData" && result.data !== null) ||
          result.state === "hasError") && (
          <p role="alert" className="text-sm text-destructive">
            {result.state === "hasData" && result.data === "size"
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

function GuidedSshAuthenticationMethod({
  disabled,
}: {
  readonly disabled: boolean;
}) {
  const { t } = useTranslation();
  const editor = useGet(sshCredentialEditor$);
  const chooseMethod = useSet(chooseSshAuthMethod$);
  return (
    <SegmentControl
      aria-label={t(($) => {
        return $.remoteControlSetup.sshLoginMethod;
      })}
      value={editor.method}
      onValueChange={chooseMethod}
      disabled={disabled}
      className="max-w-full justify-self-start"
    >
      <SegmentControlItem value="password">
        <LockKeyhole aria-hidden />
        {t(($) => {
          return $.remoteControlSetup.usePassword;
        })}
      </SegmentControlItem>
      <SegmentControlItem value="private_key">
        <KeyRound aria-hidden />
        {t(($) => {
          return $.remoteControlSetup.useSshKey;
        })}
      </SegmentControlItem>
    </SegmentControl>
  );
}

function SshAuthenticationFields({
  credential,
  disabled,
  connectionLogin,
  guided,
  compact = false,
}: {
  readonly credential: SshCredentialResponse | null;
  readonly disabled: boolean;
  readonly connectionLogin: boolean;
  readonly guided: boolean;
  readonly compact?: boolean;
}) {
  const { t } = useTranslation();
  const editor = useGet(sshCredentialEditor$);
  const chooseMethod = useSet(chooseSshAuthMethod$);
  return (
    <>
      {!guided && (
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
      )}
      {editor.method === "password" ? (
        <div key="password" className="grid gap-2">
          <label
            htmlFor="ssh-password"
            className={guided ? "flex min-h-7 items-center" : undefined}
          >
            {t(($) => {
              return $.ssh.credential.password;
            })}
          </label>
          <RemoteSecretInput
            id="ssh-password"
            name="password"
            placeholder={
              connectionLogin &&
              credential &&
              editor.method === credential.authMethod
                ? t(($) => {
                    return $.remoteControlSetup.keepSavedSecret;
                  })
                : t(($) => {
                    return guided
                      ? $.remoteControlSetup.passwordPlaceholder
                      : $.ssh.placeholders.password;
                  })
            }
            aria-describedby={guided ? "ssh-password-help" : undefined}
            required={
              !credential ||
              !connectionLogin ||
              editor.method !== credential.authMethod
            }
            maxLength={SSH_PASSWORD_MAX_LENGTH}
            autoComplete="new-password"
          />
          {guided && (
            <p
              id="ssh-password-help"
              className="text-sm leading-relaxed text-muted-foreground"
            >
              {t(($) => {
                return $.remoteControlSetup.passwordHelp;
              })}
            </p>
          )}
        </div>
      ) : (
        <PrivateKeyFields
          key="private-key"
          guided={guided || compact}
          optional={
            !!credential &&
            connectionLogin &&
            editor.method === credential.authMethod
          }
        />
      )}
    </>
  );
}

function SshAuthenticationReplacement({
  disabled,
}: {
  readonly disabled: boolean;
}) {
  const { t } = useTranslation();
  const editor = useGet(sshCredentialEditor$);
  const enabled = useGet(remoteControlGuidedEnabled$);
  const replace = useSet(replaceSshAuthentication$);
  if (!enabled) {
    return (
      <label className="flex items-center gap-2 text-sm">
        <Checkbox
          disabled={disabled}
          checked={editor.replace}
          onCheckedChange={replace}
        />
        {t(($) => {
          return $.ssh.credential.replaceAuthentication;
        })}
      </label>
    );
  }
  return (
    <RemoteCredentialReplacement
      checked={editor.replace}
      disabled={disabled}
      onCheckedChange={replace}
    />
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
  const enabled = useGet(remoteControlGuidedEnabled$);
  const guided = connectionLogin || setup !== null;
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
      {guided && !connectionLogin && (!credential || editor.replace) && (
        <GuidedSshAuthenticationMethod disabled={disabled} />
      )}
      <div className="grid gap-2">
        <div className="flex min-h-7 items-center gap-1">
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
        <SshAuthenticationReplacement disabled={disabled} />
      )}
      {(!credential || editor.replace || connectionLogin) && (
        <SshAuthenticationFields
          credential={credential}
          disabled={disabled}
          connectionLogin={connectionLogin}
          guided={guided}
          compact={enabled}
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

function SshSelectedLogin({ disabled }: { readonly disabled: boolean }) {
  const { t } = useTranslation();
  const credentials = useLoadable(sshCredentials$);
  const editor = useGet(sshCredentialEditor$);
  const choose = useSet(chooseSshCredential$);
  const selectedCredential =
    credentials.state === "hasData"
      ? credentials.data?.find((credential) => {
          return credential.id === editor.selection;
        })
      : undefined;
  return (
    <RemoteSelectedLogin
      disabled={disabled}
      label={
        selectedCredential?.hosts
          .map((host) => {
            return host.displayName;
          })
          .join(", ") || selectedCredential?.name
      }
      description={
        selectedCredential &&
        `${selectedCredential.username} · ${t(($) => {
          return selectedCredential.authMethod === "password"
            ? $.ssh.credential.password
            : $.ssh.privateKey;
        })}`
      }
      chooseNew={() => {
        choose("new");
      }}
    />
  );
}

function CredentialSelection({ disabled }: { readonly disabled: boolean }) {
  const { t } = useTranslation();
  const { credentials, editor, guided, login, choose, credentialItems } =
    useSshCredentialSelection();
  return (
    <fieldset
      className="grid min-w-0 gap-5"
      aria-labelledby={guided ? "ssh-login-heading" : undefined}
    >
      <legend hidden={guided} className="mb-3 text-sm font-semibold">
        <label htmlFor="ssh-selected-credential">
          {t(($) => {
            return $.ssh.credential.label;
          })}
        </label>
      </legend>
      {guided && (
        <>
          <h3 id="ssh-login-heading" className="text-base font-semibold">
            {t(($) => {
              return $.remoteControlSetup.loginHeading;
            })}
          </h3>
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            {(login || editor.selection === "new") && (
              <GuidedSshAuthenticationMethod disabled={disabled} />
            )}
            <SshSavedLoginPicker disabled={disabled} />
          </div>
        </>
      )}
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
        <SshSelectedLogin disabled={disabled} />
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
    <div className="grid gap-2 rounded-xl bg-nested-fill p-4 text-sm text-muted-foreground">
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
        <ul className="grid list-disc gap-1 pl-5 leading-6 marker:text-muted-foreground">
          {credential.hosts.map((host) => {
            return <li key={host.id}>{host.displayName}</li>;
          })}
        </ul>
      )}
    </div>
  );
}

function SshConflictNotice() {
  const { t } = useTranslation();
  const conflict = useGet(sshConflict$);
  if (!conflict) {
    return null;
  }
  return (
    <p role="alert" className="text-sm text-destructive">
      {localizedSshError(conflict) ??
        t(($) => {
          return $.ssh.errors.failed;
        })}
    </p>
  );
}

function useCreateDialogCopy() {
  const { t } = useTranslation();
  const editor = useGet(sshConnectionModeEditor$);
  const setup = useGet(remoteSetup$);
  const existingTailscale =
    editor.mode === "tailscale" || editor.mode === "tailscale_ssh";
  return {
    title: t(($) => {
      return editor.mode === "direct" || existingTailscale
        ? $.remoteControlSetup.directTitle
        : $.remoteControlSetup.loginTitle;
    }),
    description: t(($) => {
      return setup?.fromComputer
        ? $.remoteComputerSetup.sshReady
        : existingTailscale
          ? $.remoteControlSetup.tailscaleDescription
          : editor.mode === "direct"
            ? $.remoteControlSetup.directDescription
            : $.remoteControlSetup.loginDescription;
    }),
  };
}

function useDialogCopy(dialog: SshDialogState | null, inline: boolean) {
  const { t } = useTranslation();
  const guided = useGet(remoteControlGuidedEnabled$);
  const createCopy = useCreateDialogCopy();
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
    return createCopy;
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
          return guided ? $.remoteControlSetup.deleteConnection : $.ssh.delete;
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
  readonly saveAction: typeof saveSsh$;
  readonly inline?: boolean;
  readonly onCancel?: () => void;
  readonly initialHost?: string;
  readonly initialPort?: string;
}

function SshSaveNotice() {
  const { t } = useTranslation();
  const uncertain = useGet(sshSaveUncertain$);
  const message = useGet(sshSaveMessage$);
  if (!uncertain && !message) {
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

function hasResourceSelection(
  resources: readonly { readonly id: string }[] | null,
  selection: string | null,
  allowCreate = true,
) {
  return (
    resources !== null &&
    ((allowCreate && selection === "new") ||
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
  const guided = useGet(remoteControlGuidedEnabled$);
  return (
    hostEditor &&
    (mode === "tailscale" || mode === "tailscale_ssh") &&
    (configs.state !== "hasData" ||
      !hasResourceSelection(configs.data, configId, !guided))
  );
}

function useSshHostSaveBlocked(dialog: SshDialogState, isSaving: boolean) {
  const guided = useGet(remoteControlGuidedEnabled$);
  const configs = useLoadable(cloudflareAccessConfigs$);
  const connectionEditor = useGet(sshConnectionModeEditor$);
  const conflict = useGet(sshConflict$);
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
      !hasResourceSelection(configs.data, connectionEditor.configId, !guided));
  const invalidCredential =
    hostEditor &&
    connectionEditor.mode !== "tailscale_ssh" &&
    (credentials.state !== "hasData" ||
      !hasResourceSelection(credentials.data, credentialEditor.selection));
  return (
    isSaving ||
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
function SshSetupNetwork({ disabled }: { readonly disabled: boolean }) {
  const setup = useGet(remoteSetup$);
  return setup?.fromComputer ? (
    <ComputerNetworkSummary />
  ) : (
    <RemoteConnectionNetwork disabled={disabled} />
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
  const tailscale =
    connectionEditor.mode === "tailscale" ||
    connectionEditor.mode === "tailscale_ssh";
  const inlineCreate = inline && dialog.kind === "create";
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
              {tailscale && <TailscaleSelection disabled={fieldsDisabled} />}
            </div>
          </details>
          {connectionEditor.mode === "tailscale_ssh" && (
            <h2 className="text-base font-medium">
              {t(($) => {
                return $.remoteControlSetup.loginHeading;
              })}
            </h2>
          )}
        </>
      ) : (
        <div className="grid min-w-0 gap-5">
          {inlineCreate && (
            <h3 className="text-base font-semibold">
              {t(($) => {
                return $.remoteControlSetup.deviceHeading;
              })}
            </h3>
          )}
          {inlineCreate && <SshSetupNetwork disabled={fieldsDisabled} />}
          {inlineCreate ? (
            <GuidedSshEndpointFields initialHost={initialHost} />
          ) : (
            <EndpointFields
              connection={dialog.connection}
              disabled={fieldsDisabled}
            />
          )}
          {!inlineCreate && connectionEditor.mode === "cloudflare_access" && (
            <AccessSelection disabled={fieldsDisabled} />
          )}
          {tailscale && !inlineCreate && (
            <TailscaleSelection disabled={fieldsDisabled} />
          )}
          {inlineCreate && <GuidedSshConnectionName />}
        </div>
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
      {inlineCreate && (
        <GuidedSshAdvancedFields
          initialPort={initialPort}
          disabled={fieldsDisabled}
        />
      )}
    </>
  );
}

function useSshFormSubmission(
  dialog: SshDialogState,
  saveAction: typeof saveSsh$,
  inline: boolean,
) {
  const { t } = useTranslation();
  const { title } = useDialogCopy(dialog, inline);
  const [saving, save] = useLoadableSet(saveAction);
  const isSaving = saving.state === "loading";
  const uncertain = useGet(sshSaveUncertain$);
  const guided = useGet(remoteControlGuidedEnabled$);
  const credentialEditor = useGet(sshCredentialEditor$);
  const connectionEditor = useGet(sshConnectionModeEditor$);
  const confirmLogin = useSet(requestRemoteLoginSave$);
  const signal = useGet(pageSignal$);
  const blocked = useSshHostSaveBlocked(dialog, isSaving);
  const destructive = ["delete", "reset", "delete-credential"].includes(
    dialog.kind,
  );
  return {
    isSaving,
    uncertain,
    destructive,
    submitDisabled: isSaving || uncertain || blocked,
    submitLabel: isSaving
      ? t(($) => {
          return $.connectors.actions.saving;
        })
      : destructive
        ? title
        : t(($) => {
            return inline && dialog.kind === "create"
              ? $.remoteControlSetup.add
              : $.ssh.save;
          }),
    submit(form: HTMLFormElement) {
      if (isSaving || uncertain || blocked) {
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
            form,
            dialog.loginCredential,
            credentialEditor.method,
          ) !== null,
        )
      ) {
        return;
      }
      // Keep sensitive input only in this form, never in ccstate or caches.
      detach(save(form, signal), Reason.DomCallback);
    },
  };
}

function SshHostForm({
  dialog,
  saveAction,
  inline = false,
  onCancel,
  initialHost,
  initialPort,
}: SshFormProps) {
  const { t } = useTranslation();
  const {
    isSaving,
    uncertain,
    destructive,
    submitDisabled,
    submitLabel,
    submit,
  } = useSshFormSubmission(dialog, saveAction, inline);
  const close = useSet(closeSshDialog$);
  const guided = useGet(remoteControlGuidedEnabled$);
  const fieldsDisabled = isSaving || uncertain;
  const mountForm = useSet(mountSshForm$);
  const { title, description } = useDialogCopy(dialog, inline);
  const hostEditor = dialog.kind === "create" || dialog.kind === "edit";
  return (
    <RemoteEditorFrame
      inline={inline}
      title={title}
      description={description}
      busy={isSaving}
      onClose={onCancel ?? close}
    >
      <form
        ref={mountForm}
        id={guided ? "remote-ssh-edit-form" : undefined}
        className="flex min-h-0 min-w-0 flex-col gap-4"
        autoComplete="off"
        aria-busy={isSaving}
        onSubmit={(event) => {
          event.preventDefault();
          submit(event.currentTarget);
        }}
      >
        <DialogBody className={guided ? "-m-1 grid gap-4 p-1" : "grid gap-4"}>
          {!destructive && (
            <fieldset
              disabled={fieldsDisabled}
              className={
                hostEditor ? "grid min-w-0 gap-6" : "grid min-w-0 gap-5"
              }
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
          <SshConflictNotice />
          {!isSaving && <SshSaveNotice />}
          {dialog.connectionSaved && (
            <p role="alert" className="text-sm text-muted-foreground">
              {t(($) => {
                return $.remoteControlSetup.partialLoginSave;
              })}
            </p>
          )}
        </DialogBody>
        <RemoteFormFooter
          separated={inline || guided}
          onCancel={
            !inline || dialog.kind === "edit" ? (onCancel ?? close) : undefined
          }
          cancelLabel={t(($) => {
            return $.ssh.cancel;
          })}
          cancelDisabled={isSaving}
          submitDisabled={submitDisabled}
          destructive={destructive}
          submitLabel={submitLabel}
        />
        {guided && <RemoteLoginConfirmation protocol="ssh" />}
      </form>
    </RemoteEditorFrame>
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
  const dialog = lastDialog?.sessionKey === sessionKey ? lastDialog : null;
  if (!dialog) {
    return null;
  }
  return (
    <SshHostForm
      key={dialog.instanceId}
      dialog={dialog}
      saveAction={saveAction}
      inline={inline}
      onCancel={onCancel}
      initialHost={initialHost}
      initialPort={initialPort}
    />
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
  const { transport, tailscale, configId, needsRebind, unavailable, config } =
    useSshHostDetails(connection);
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
              ? $.tailscale.rebindAvailable
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
  const { unavailable } = useSshHostDetails(connection);
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
        {detail ? (
          <RemoteConnectionEditButton
            resource={{ kind: "ssh", connection }}
            disabled={unavailable}
          />
        ) : (
          <Button
            variant="outline"
            disabled={unavailable}
            onClick={() => {
              return detach(
                open("edit", connection, signal),
                Reason.DomCallback,
              );
            }}
          >
            {t(($) => {
              return detail ? $.remoteControlSetup.editConnection : $.ssh.edit;
            })}
          </Button>
        )}
        <Button
          variant="outline"
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
          variant="outline"
          disabled={unavailable}
          onClick={() => {
            return detach(
              open("delete", connection, signal),
              Reason.DomCallback,
            );
          }}
        >
          {t(($) => {
            return detail
              ? $.remoteControlSetup.deleteConnection
              : $.ssh.delete;
          })}
        </Button>
      </div>
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
  const guided = useGet(remoteControlGuidedEnabled$);
  const sessionKey = useGet(authenticatedSessionKey$);
  if (!guided) {
    return <OwnerSshCredentials />;
  }
  return sessionKey ? <OwnerSshCredentials key={sessionKey} /> : null;
}

function OwnerSshCredentials() {
  const { t } = useTranslation();
  const guided = useGet(remoteControlGuidedEnabled$);
  const current = useLoadable(sshCredentials$);
  const retained = useLastLoadable(sshCredentials$);
  const credentials = guided ? retained : current;
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
          variant="neutral"
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
          <RemoteCredentialCard
            key={credential.id}
            name={credential.name}
            username={credential.username}
            hosts={credential.hosts}
            method={
              credential.authMethod === "password"
                ? t(($) => {
                    return $.ssh.credential.password;
                  })
                : t(($) => {
                    return $.ssh.privateKey;
                  })
            }
            onEdit={() => {
              detach(
                open("edit-credential", credential, signal),
                Reason.DomCallback,
              );
            }}
            onDelete={() => {
              detach(
                open("delete-credential", credential, signal),
                Reason.DomCallback,
              );
            }}
          />
        );
      })}
    </div>
  );
}
