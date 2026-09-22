import { useGet, useLoadable, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import {
  Button,
  Checkbox,
  Input,
  Textarea,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@okouai/ui";
import {
  VNC_CA_BUNDLE_MAX_LENGTH,
  VNC_HOST_MAX_LENGTH,
  type VncConnectionResponse,
} from "@okouai/api-contracts/contracts/vnc-connections";
import {
  VNC_DISPLAY_NAME_MAX_LENGTH,
  VNC_USERNAME_MAX_BYTES,
  VNC_USERNAME_PASSWORD_MAX_BYTES,
  type VncCredentialResponse,
} from "@okouai/api-contracts/contracts/vnc-credentials";
import {
  chooseVncCredential$,
  chooseVncProfile$,
  chooseVncTrust$,
  replaceVncAuthentication$,
  vncEditor$,
  vncCredentials$,
  invalidateVnc$,
  mountVncSecret$,
  vncAuthMethodForProfile,
  vncCredentialMatchesProfile,
} from "../../signals/vnc.ts";

export function VncEndpointFields({
  connection,
}: {
  readonly connection: VncConnectionResponse | null;
}) {
  const { t } = useTranslation();
  return (
    <div className="grid gap-4">
      <label className="grid gap-2 text-sm">
        <span>
          {t(($) => {
            return $.vnc.displayName;
          })}
        </span>
        <Input
          name="displayName"
          required
          maxLength={VNC_DISPLAY_NAME_MAX_LENGTH}
          defaultValue={connection?.displayName ?? ""}
          placeholder={t(($) => {
            return $.vnc.displayNameHint;
          })}
        />
      </label>
      <label className="grid gap-2 text-sm">
        <span>
          {t(($) => {
            return $.vnc.host;
          })}
        </span>
        <Input
          name="host"
          required
          maxLength={VNC_HOST_MAX_LENGTH}
          defaultValue={connection?.host ?? ""}
          placeholder={t(($) => {
            return $.vnc.hostHint;
          })}
        />
      </label>
      <label className="grid gap-2 text-sm">
        <span>
          {t(($) => {
            return $.vnc.port;
          })}
        </span>
        <Input
          name="port"
          type="number"
          required
          min={1}
          max={65_535}
          defaultValue={connection?.port ?? 5900}
        />
      </label>
    </div>
  );
}

function VncSecurityProfileField({
  profile,
  disabled,
}: {
  readonly profile: "x509_vnc" | "x509_plain";
  readonly disabled: boolean;
}) {
  const { t } = useTranslation();
  const chooseProfile = useSet(chooseVncProfile$);
  const profileItems = [
    {
      value: "x509_vnc",
      label: t(($) => {
        return $.vnc.security.x509Vnc;
      }),
    },
    {
      value: "x509_plain",
      label: t(($) => {
        return $.vnc.security.x509Plain;
      }),
    },
  ];
  return (
    <>
      <label htmlFor="vnc-profile" className="text-sm">
        {t(($) => {
          return $.vnc.security.profileLabel;
        })}
      </label>
      <Select
        items={profileItems}
        value={profile}
        onValueChange={(value, details) => {
          if (value !== "x509_vnc" && value !== "x509_plain") {
            details.cancel();
            return;
          }
          chooseProfile(value);
        }}
        disabled={disabled}
      >
        <SelectTrigger id="vnc-profile">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {profileItems.map((item) => {
            return (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
      <p className="text-sm text-muted-foreground">
        {profile === "x509_vnc"
          ? t(($) => {
              return $.vnc.security.x509VncHelp;
            })
          : t(($) => {
              return $.vnc.security.x509PlainHelp;
            })}
      </p>
    </>
  );
}

export function VncSecurityFields({
  connection,
  disabled,
}: {
  readonly connection: VncConnectionResponse | null;
  readonly disabled: boolean;
}) {
  const { t } = useTranslation();
  const editor = useGet(vncEditor$);
  const choose = useSet(chooseVncTrust$);
  const savedTrust = connection?.security.trust;
  const trustItems = [
    {
      value: "system",
      label: t(($) => {
        return $.vnc.security.system;
      }),
    },
    {
      value: "custom_ca",
      label: t(($) => {
        return $.vnc.security.custom;
      }),
    },
  ];
  return (
    <div className="grid gap-3">
      <VncSecurityProfileField profile={editor.profile} disabled={disabled} />
      <label htmlFor="vnc-trust" className="text-sm">
        {t(($) => {
          return $.vnc.security.title;
        })}
      </label>
      <Select
        items={trustItems}
        value={editor.trust}
        onValueChange={(value, details) => {
          if (value !== "system" && value !== "custom_ca") {
            details.cancel();
            return;
          }
          choose(value);
        }}
        disabled={disabled}
      >
        <SelectTrigger id="vnc-trust">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {trustItems.map((item) => {
            return (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
      {editor.trust === "custom_ca" && (
        <div className="grid gap-2 text-sm">
          <label htmlFor="vnc-ca-bundle">
            {t(($) => {
              return $.vnc.security.caBundle;
            })}
          </label>
          <Textarea
            id="vnc-ca-bundle"
            name="caBundle"
            required
            maxLength={VNC_CA_BUNDLE_MAX_LENGTH}
            aria-describedby="vnc-ca-help"
            defaultValue={
              savedTrust?.mode === "custom_ca" ? savedTrust.caBundle : ""
            }
            placeholder={t(($) => {
              return $.vnc.security.caHint;
            })}
            className="min-h-32 font-mono text-xs"
          />
          <p id="vnc-ca-help" className="text-muted-foreground">
            {t(($) => {
              return $.vnc.security.caHelp;
            })}
          </p>
        </div>
      )}
    </div>
  );
}

function VncAuthenticationMethodSelector({
  disabled,
  profile,
}: {
  readonly disabled: boolean;
  readonly profile: "x509_vnc" | "x509_plain";
}) {
  const { t } = useTranslation();
  const chooseProfile = useSet(chooseVncProfile$);
  const profileItems = [
    {
      value: "x509_vnc",
      label: t(($) => {
        return $.vnc.credential.method;
      }),
    },
    {
      value: "x509_plain",
      label: t(($) => {
        return $.vnc.credential.usernamePasswordMethod;
      }),
    },
  ];
  return (
    <div className="grid gap-2 text-sm">
      <label htmlFor="vnc-auth-method">
        {t(($) => {
          return $.vnc.credential.authentication;
        })}
      </label>
      <Select
        items={profileItems}
        value={profile}
        onValueChange={(value, details) => {
          if (value !== "x509_vnc" && value !== "x509_plain") {
            details.cancel();
            return;
          }
          chooseProfile(value);
        }}
        disabled={disabled}
      >
        <SelectTrigger id="vnc-auth-method">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {profileItems.map((item) => {
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

function VncAuthenticationMethod({
  method,
}: {
  readonly method: VncCredentialResponse["authMethod"];
}) {
  const { t } = useTranslation();
  return (
    <div className="grid gap-1 text-sm">
      <span className="text-muted-foreground">
        {t(($) => {
          return $.vnc.credential.authentication;
        })}
      </span>
      <span>
        {method === "vnc_password"
          ? t(($) => {
              return $.vnc.credential.method;
            })
          : t(($) => {
              return $.vnc.credential.usernamePasswordMethod;
            })}
      </span>
    </div>
  );
}

function VncAuthenticationReplacement({
  disabled,
  replace,
}: {
  readonly disabled: boolean;
  readonly replace: boolean;
}) {
  const { t } = useTranslation();
  const setReplace = useSet(replaceVncAuthentication$);
  return (
    <div className="grid gap-2">
      <label className="flex items-center gap-2 text-sm">
        <Checkbox
          checked={replace}
          disabled={disabled}
          onCheckedChange={(checked) => {
            setReplace(checked === true);
          }}
        />
        {t(($) => {
          return $.vnc.credential.replace;
        })}
      </label>
      <p className="text-sm text-muted-foreground">
        {t(($) => {
          return $.vnc.credential.replaceHelp;
        })}
      </p>
    </div>
  );
}

function VncAuthenticationInputs({
  credential,
  method,
}: {
  readonly credential: VncCredentialResponse | null;
  readonly method: VncCredentialResponse["authMethod"];
}) {
  const { t } = useTranslation();
  const mountSecret = useSet(mountVncSecret$);
  return (
    <div key={method} className="grid gap-4">
      {method === "username_password" && (
        <div className="grid gap-2 text-sm">
          <label htmlFor="vnc-username">
            {t(($) => {
              return $.vnc.credential.username;
            })}
          </label>
          <Input
            id="vnc-username"
            name="username"
            required
            maxLength={VNC_USERNAME_MAX_BYTES}
            defaultValue={
              credential?.authMethod === "username_password"
                ? credential.username
                : ""
            }
            aria-describedby="vnc-username-help"
            placeholder={t(($) => {
              return $.vnc.credential.usernameHint;
            })}
          />
          <p id="vnc-username-help" className="text-muted-foreground">
            {t(($) => {
              return $.vnc.credential.usernameHelp;
            })}
          </p>
        </div>
      )}
      <div className="grid gap-2 text-sm">
        <label htmlFor="vnc-password">
          {method === "vnc_password"
            ? t(($) => {
                return $.vnc.credential.password;
              })
            : t(($) => {
                return $.vnc.credential.usernamePassword;
              })}
        </label>
        <Input
          ref={mountSecret}
          id="vnc-password"
          name="password"
          type="password"
          required
          autoComplete="new-password"
          aria-describedby="vnc-password-help"
          maxLength={
            method === "vnc_password"
              ? undefined
              : VNC_USERNAME_PASSWORD_MAX_BYTES
          }
          pattern={method === "vnc_password" ? "[ -~]{1,8}" : undefined}
          placeholder={
            method === "vnc_password"
              ? t(($) => {
                  return $.vnc.credential.passwordHint;
                })
              : t(($) => {
                  return $.vnc.credential.usernamePasswordHint;
                })
          }
        />
        <p id="vnc-password-help" className="text-muted-foreground">
          {method === "vnc_password"
            ? t(($) => {
                return $.vnc.credential.passwordHelp;
              })
            : t(($) => {
                return $.vnc.credential.usernamePasswordHelp;
              })}
        </p>
      </div>
    </div>
  );
}

export function VncCredentialFields({
  credential,
  disabled,
  showMethodSelection,
}: {
  readonly credential: VncCredentialResponse | null;
  readonly disabled: boolean;
  readonly showMethodSelection: boolean;
}) {
  const { t } = useTranslation();
  const editor = useGet(vncEditor$);
  const method =
    credential?.authMethod ?? vncAuthMethodForProfile(editor.profile);
  return (
    <div className="grid gap-4">
      <label className="grid gap-2 text-sm">
        <span>
          {t(($) => {
            return $.vnc.credential.name;
          })}
        </span>
        <Input
          name="credentialName"
          required
          maxLength={VNC_DISPLAY_NAME_MAX_LENGTH}
          defaultValue={credential?.name ?? ""}
          placeholder={t(($) => {
            return $.vnc.credential.nameHint;
          })}
        />
      </label>
      {showMethodSelection && !credential && (
        <VncAuthenticationMethodSelector
          disabled={disabled}
          profile={editor.profile}
        />
      )}
      {credential && <VncAuthenticationMethod method={method} />}
      {credential && (
        <VncAuthenticationReplacement
          disabled={disabled}
          replace={editor.replace}
        />
      )}
      {(!credential || editor.replace) && (
        <VncAuthenticationInputs credential={credential} method={method} />
      )}
    </div>
  );
}

function VncCredentialLoadError() {
  const { t } = useTranslation();
  const retry = useSet(invalidateVnc$);
  return (
    <div
      role="alert"
      className="flex items-center justify-between gap-3 text-sm"
    >
      <p>
        {t(($) => {
          return $.vnc.loadFailed;
        })}
      </p>
      <Button
        type="button"
        variant="outline"
        onClick={() => {
          retry();
        }}
      >
        {t(($) => {
          return $.vnc.retry;
        })}
      </Button>
    </div>
  );
}

export function VncCredentialSelection({
  disabled,
}: {
  readonly disabled: boolean;
}) {
  const { t } = useTranslation();
  const credentials = useLoadable(vncCredentials$);
  const editor = useGet(vncEditor$);
  const choose = useSet(chooseVncCredential$);
  const compatibleCredentials =
    credentials.state === "hasData" && credentials.data
      ? credentials.data.filter((credential) => {
          return vncCredentialMatchesProfile(credential, editor.profile);
        })
      : [];
  const credentialItems = [
    ...compatibleCredentials.map((credential) => {
      return { value: credential.id, label: credential.name };
    }),
    {
      value: "new",
      label: t(($) => {
        return $.vnc.credential.createNew;
      }),
    },
  ];
  const selectedCredentialUnavailable =
    editor.selection !== "" &&
    editor.selection !== "new" &&
    credentials.state === "hasData" &&
    credentials.data !== null &&
    !compatibleCredentials.some((credential) => {
      return credential.id === editor.selection;
    });
  return (
    <fieldset className="grid min-w-0 gap-4">
      <legend className="mb-3 text-sm font-semibold">
        <label htmlFor="vnc-credential">
          {t(($) => {
            return $.vnc.credential.label;
          })}
        </label>
      </legend>
      <div className="grid gap-2">
        {credentials.state === "hasError" ? (
          <VncCredentialLoadError />
        ) : credentials.state === "loading" ? (
          <p role="status" className="text-sm">
            {t(($) => {
              return $.vnc.loading;
            })}
          </p>
        ) : credentials.data === null ? (
          <p role="alert" className="text-sm">
            {t(($) => {
              return $.vnc.unavailable;
            })}
          </p>
        ) : (
          <Select
            items={credentialItems}
            value={editor.selection}
            onValueChange={(value, details) => {
              if (value === null) {
                details.cancel();
                return;
              }
              choose(value);
            }}
            disabled={disabled}
          >
            <SelectTrigger id="vnc-credential" className="min-w-0">
              <SelectValue
                placeholder={t(($) => {
                  return $.vnc.credential.select;
                })}
              />
            </SelectTrigger>
            <SelectContent className="w-(--anchor-width)">
              {credentialItems.map((item) => {
                return (
                  <SelectItem
                    key={item.value}
                    value={item.value}
                    className={item.value === "new" ? undefined : "break-all"}
                  >
                    {item.label}
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
        )}
      </div>
      {selectedCredentialUnavailable && (
        <p role="alert" className="text-sm text-muted-foreground">
          {t(($) => {
            return $.vnc.errors.credentialUnavailable;
          })}
        </p>
      )}
      {editor.selection === "new" && (
        <div className="grid gap-4 rounded-lg border bg-muted/30 p-4">
          <VncCredentialFields
            credential={null}
            disabled={disabled}
            showMethodSelection={false}
          />
        </div>
      )}
    </fieldset>
  );
}

export function VncCredentialImpact({
  credential,
}: {
  readonly credential: VncCredentialResponse;
}) {
  const { t } = useTranslation();
  return (
    <div className="grid gap-2 text-sm text-muted-foreground">
      <p>
        {credential.hosts.length > 0
          ? t(
              ($) => {
                return $.vnc.credential.sharedHelp;
              },
              { count: credential.hosts.length },
            )
          : t(($) => {
              return $.vnc.credential.unused;
            })}
      </p>
      {credential.hosts.length > 0 && (
        <ul className="list-inside list-disc">
          {credential.hosts.map((host) => {
            return (
              <li key={host.id} className="break-all">
                {host.displayName}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
