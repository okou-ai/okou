import { useGet, useLoadable, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react";
import {
  Button,
  Input,
  Checkbox,
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@okouai/ui";
import {
  CLOUDFLARE_ACCESS_TOKEN_MAX_LENGTH,
  type CloudflareAccessConfig,
} from "@okouai/api-contracts/contracts/cloudflare-access";
import { SSH_ERROR_CODES } from "@okouai/api-contracts/contracts/ssh-errors";
import {
  sshCloudflareConfigs$,
  sshTransportEditor$,
  chooseSshAccessConfig$,
  openSshCloudflareDialog$,
  retrySsh$,
  sshReplaceAccessToken$,
  replaceSshAccessToken$,
  sshConflict$,
  sshConflictReview$,
  acceptSshConflictReview$,
} from "../../signals/ssh.ts";
import { localizedSshError } from "../../lib/ssh-error.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { SshLoadError } from "./ssh-load-error.tsx";

export function SshConflictReview() {
  const { t } = useTranslation();
  const conflict = useGet(sshConflict$);
  const review = useLoadable(sshConflictReview$);
  const acceptReview = useSet(acceptSshConflictReview$);
  const signal = useGet(pageSignal$);
  if (!conflict) {
    return null;
  }
  const current = review.state === "hasData" ? review.data : null;
  const hostConflict = conflict === SSH_ERROR_CODES.GENERATION_CONFLICT;
  const credentialConflict =
    conflict === SSH_ERROR_CODES.CREDENTIAL_REVISION_CONFLICT ||
    conflict === SSH_ERROR_CODES.CREDENTIAL_IN_USE;
  return (
    <div className="grid gap-3 rounded-lg border p-4 text-sm">
      <p role="alert">
        {localizedSshError(conflict) ??
          t(($) => {
            return $.ssh.errors.failed;
          })}
      </p>
      {review.state === "hasError" &&
        (hostConflict || credentialConflict ? (
          <SshLoadError />
        ) : (
          <AccessLoadError />
        ))}
      {review.state === "loading" && (
        <p role="status">
          {t(($) => {
            return hostConflict
              ? $.ssh.loading
              : credentialConflict
                ? $.ssh.credential.loading
                : $.ssh.cloudflare.loading;
          })}
        </p>
      )}
      {current && (
        <>
          <h3 className="font-semibold">
            {t(($) => {
              return $.ssh.cloudflare.latest;
            })}
          </h3>
          {current.config && (
            <>
              <p>{current.config.name}</p>
              <AccessImpact config={current.config} />
            </>
          )}
          {current.credential && (
            <>
              <p>
                {current.credential.name} · {current.credential.username}
              </p>
              <AccessImpact config={current.credential} />
            </>
          )}
          {current.connection && (
            <div className="grid gap-1">
              <p>{current.connection.displayName}</p>
              <p className="break-all">
                {current.connection.username}@{current.connection.host}:
                {current.connection.port}
              </p>
              <p>{current.connection.credentialName}</p>
              <p>
                {"transport" in current.connection
                  ? t(($) => {
                      return $.ssh.cloudflare.title;
                    })
                  : t(($) => {
                      return $.ssh.cloudflare.direct;
                    })}
              </p>
            </div>
          )}
          <p>
            {t(($) => {
              return $.ssh.cloudflare.reviewHelp;
            })}
          </p>
          <Button
            type="button"
            variant="outline"
            disabled={
              (current.kind === "delete-access" ||
                current.kind === "delete-credential") &&
              (current.config?.hosts.length ??
                current.credential?.hosts.length ??
                0) > 0
            }
            onClick={() => {
              return detach(acceptReview(current, signal), Reason.DomCallback);
            }}
          >
            {t(($) => {
              return $.ssh.cloudflare.keepChanges;
            })}
          </Button>
        </>
      )}
    </div>
  );
}

function AccessLoadError() {
  const { t } = useTranslation();
  const retry = useSet(retrySsh$);
  const signal = useGet(pageSignal$);
  return (
    <div
      role="alert"
      className="flex items-center justify-between gap-3 text-sm"
    >
      <p>
        {t(($) => {
          return $.ssh.cloudflare.loadFailed;
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
          return $.ssh.retry;
        })}
      </Button>
    </div>
  );
}

export function AccessImpact({
  config,
}: {
  readonly config: Pick<CloudflareAccessConfig, "hosts">;
}) {
  const { t } = useTranslation();
  return (
    <div className="grid gap-1 text-sm text-muted-foreground">
      <p>
        {config.hosts.length === 0
          ? t(($) => {
              return $.ssh.credential.unused;
            })
          : t(
              ($) => {
                return $.ssh.cloudflare.usedBy;
              },
              { count: config.hosts.length },
            )}
      </p>
      {config.hosts.length > 0 && (
        <ul className="list-inside list-disc">
          {config.hosts.map((host) => {
            return <li key={host.id}>{host.displayName}</li>;
          })}
        </ul>
      )}
    </div>
  );
}

export function AccessFields({
  config,
}: {
  readonly config: CloudflareAccessConfig | null;
}) {
  const { t } = useTranslation();
  const replace = useGet(sshReplaceAccessToken$);
  const setReplace = useSet(replaceSshAccessToken$);
  return (
    <>
      <label className="grid gap-2">
        {t(($) => {
          return $.ssh.cloudflare.name;
        })}
        <Input
          name="accessName"
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
              return setReplace(checked === true);
            }}
          />
          {t(($) => {
            return $.ssh.cloudflare.replace;
          })}
        </label>
      )}
      {(!config || replace) && (
        <>
          <p className="text-sm text-muted-foreground">
            {t(($) => {
              return $.ssh.cloudflare.tokenHelp;
            })}
          </p>
          <label className="grid gap-2">
            {t(($) => {
              return $.ssh.cloudflare.clientId;
            })}
            <Input
              name="clientId"
              required
              type="password"
              pattern="[!-~]+"
              maxLength={CLOUDFLARE_ACCESS_TOKEN_MAX_LENGTH}
              autoComplete="new-password"
              spellCheck={false}
            />
          </label>
          <label className="grid gap-2">
            {t(($) => {
              return $.ssh.cloudflare.clientSecret;
            })}
            <Input
              name="clientSecret"
              required
              type="password"
              pattern="[!-~]+"
              maxLength={CLOUDFLARE_ACCESS_TOKEN_MAX_LENGTH}
              autoComplete="new-password"
              spellCheck={false}
            />
          </label>
        </>
      )}
    </>
  );
}

export function AccessSelection({ disabled }: { readonly disabled: boolean }) {
  const { t } = useTranslation();
  const configs = useLoadable(sshCloudflareConfigs$);
  const editor = useGet(sshTransportEditor$);
  const choose = useSet(chooseSshAccessConfig$);
  if (configs.state === "hasData" && configs.data === null) {
    return (
      <p role="alert" className="text-sm text-muted-foreground">
        {t(($) => {
          return $.ssh.cloudflare.unavailable;
        })}
      </p>
    );
  }
  return (
    <fieldset className="grid min-w-0 gap-4">
      <legend className="mb-3 text-sm font-semibold">
        {t(($) => {
          return $.ssh.cloudflare.title;
        })}
      </legend>
      {configs.state === "hasError" ? (
        <AccessLoadError />
      ) : configs.state === "loading" ? (
        <p role="status">
          {t(($) => {
            return $.ssh.cloudflare.loading;
          })}
        </p>
      ) : configs.data ? (
        <div className="grid gap-2">
          <label htmlFor="ssh-access-config">
            {t(($) => {
              return $.ssh.cloudflare.configuration;
            })}
          </label>
          <Select
            disabled={disabled}
            value={editor.configId || null}
            onValueChange={choose}
          >
            <SelectTrigger id="ssh-access-config">
              <SelectValue
                placeholder={t(($) => {
                  return $.ssh.cloudflare.select;
                })}
              />
            </SelectTrigger>
            <SelectContent>
              {configs.data.map((config) => {
                return (
                  <SelectItem key={config.id} value={config.id}>
                    {config.name}
                  </SelectItem>
                );
              })}
              <SelectItem value="new">
                {t(($) => {
                  return $.ssh.cloudflare.createNew;
                })}
              </SelectItem>
            </SelectContent>
          </Select>
          {editor.configId &&
            editor.configId !== "new" &&
            !configs.data.some((config) => {
              return config.id === editor.configId;
            }) && (
              <p role="alert">
                {t(($) => {
                  return $.ssh.cloudflare.missing;
                })}
              </p>
            )}
        </div>
      ) : null}
      {editor.configId === "new" && (
        <div className="grid gap-4 rounded-lg border bg-muted/30 p-4">
          <AccessFields config={null} />
        </div>
      )}
    </fieldset>
  );
}

export function CloudflareAccessConfigs() {
  const { t } = useTranslation();
  const configs = useLoadable(sshCloudflareConfigs$);
  const open = useSet(openSshCloudflareDialog$);
  const signal = useGet(pageSignal$);
  if (configs.state === "loading") {
    return (
      <p role="status">
        {t(($) => {
          return $.ssh.cloudflare.loading;
        })}
      </p>
    );
  }
  if (configs.state === "hasError") {
    return <AccessLoadError />;
  }
  if (!configs.data) {
    return (
      <p>
        {t(($) => {
          return $.ssh.cloudflare.unavailable;
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
              return $.ssh.cloudflare.summary;
            },
            { count: configs.data.length },
          )}
        </p>
        <Button
          onClick={() => {
            return detach(
              open("create-access", null, signal),
              Reason.DomCallback,
            );
          }}
        >
          <Plus size={16} aria-hidden="true" />
          {t(($) => {
            return $.ssh.cloudflare.add;
          })}
        </Button>
      </div>
      {configs.data.length === 0 && (
        <p className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
          {t(($) => {
            return $.ssh.cloudflare.empty;
          })}
        </p>
      )}
      {configs.data.map((config) => {
        return (
          <article
            key={config.id}
            className="grid gap-3 rounded-xl border bg-card p-5"
          >
            <h2 className="font-semibold">{config.name}</h2>
            <AccessImpact config={config} />
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                onClick={() => {
                  return detach(
                    open("edit-access", config, signal),
                    Reason.DomCallback,
                  );
                }}
              >
                {t(($) => {
                  return $.ssh.cloudflare.edit;
                })}
              </Button>
              <Button
                variant="outline"
                disabled={config.hosts.length > 0}
                onClick={() => {
                  return detach(
                    open("delete-access", config, signal),
                    Reason.DomCallback,
                  );
                }}
              >
                {t(($) => {
                  return $.ssh.cloudflare.delete;
                })}
              </Button>
            </div>
            {config.hosts.length > 0 && (
              <p className="text-sm text-muted-foreground">
                {t(($) => {
                  return $.ssh.cloudflare.inUseHelp;
                })}
              </p>
            )}
          </article>
        );
      })}
    </div>
  );
}
