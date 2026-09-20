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
  type VncCredentialResponse,
} from "@okouai/api-contracts/contracts/vnc-credentials";
import {
  chooseVncCredential$,
  chooseVncTrust$,
  replaceVncPassword$,
  vncEditor$,
  vncCredentials$,
  invalidateVnc$,
  mountVncSecret$,
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

export function VncTrustFields({
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
  return (
    <div className="grid gap-3">
      <p className="text-sm font-medium">
        {t(($) => {
          return $.vnc.security.profile;
        })}
      </p>
      <p className="text-sm text-muted-foreground">
        {t(($) => {
          return $.vnc.security.help;
        })}
      </p>
      <label htmlFor="vnc-trust" className="text-sm">
        {t(($) => {
          return $.vnc.security.title;
        })}
      </label>
      <Select value={editor.trust} onValueChange={choose} disabled={disabled}>
        <SelectTrigger id="vnc-trust">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="system">
            {t(($) => {
              return $.vnc.security.system;
            })}
          </SelectItem>
          <SelectItem value="custom_ca">
            {t(($) => {
              return $.vnc.security.custom;
            })}
          </SelectItem>
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

export function VncCredentialFields({
  credential,
  disabled,
}: {
  readonly credential: VncCredentialResponse | null;
  readonly disabled: boolean;
}) {
  const { t } = useTranslation();
  const editor = useGet(vncEditor$);
  const replace = useSet(replaceVncPassword$);
  const mountSecret = useSet(mountVncSecret$);
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
      {credential && (
        <div className="grid gap-2">
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={editor.replace}
              disabled={disabled}
              onCheckedChange={(checked) => {
                replace(checked === true);
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
      )}
      {(!credential || editor.replace) && (
        <div className="grid gap-2 text-sm">
          <label htmlFor="vnc-password">
            {t(($) => {
              return $.vnc.credential.password;
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
            pattern="[ -~]{1,8}"
            placeholder={t(($) => {
              return $.vnc.credential.passwordHint;
            })}
          />
          <p id="vnc-password-help" className="text-muted-foreground">
            {t(($) => {
              return $.vnc.credential.passwordHelp;
            })}
          </p>
        </div>
      )}
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
  const retry = useSet(invalidateVnc$);
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
            value={editor.selection}
            onValueChange={choose}
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
              {credentials.data.map((credential) => {
                return (
                  <SelectItem
                    key={credential.id}
                    value={credential.id}
                    className="break-all"
                  >
                    {credential.name}
                  </SelectItem>
                );
              })}
              <SelectItem value="new">
                {t(($) => {
                  return $.vnc.credential.createNew;
                })}
              </SelectItem>
            </SelectContent>
          </Select>
        )}
      </div>
      {editor.selection === "new" && (
        <div className="grid gap-4 rounded-lg border bg-muted/30 p-4">
          <VncCredentialFields credential={null} disabled={disabled} />
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
