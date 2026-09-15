import { useGet, useLoadable, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react";
import {
  Button,
  Input,
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
  sshCloudflareEnabled$,
  sshTransportEditor$,
  chooseSshAccessConfig$,
  openSshAccessStep$,
  openSshCloudflareDialog$,
  mountSshAccessCreateButton$,
  invalidateSsh$,
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
  return (
    <div className="grid gap-3 rounded-lg border p-4 text-sm">
      <p role="alert">
        {localizedSshError(conflict) ??
          t(($) => {
            return $.ssh.errors.failed;
          })}
      </p>
      {review.state === "hasError" &&
        (hostConflict ? <SshLoadError /> : <AccessLoadError />)}
      {review.state === "loading" && (
        <p role="status">
          {t(($) => {
            return hostConflict ? $.ssh.loading : $.ssh.cloudflare.loading;
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
              current.kind === "delete-access" &&
              (current.config?.hosts.length ?? 0) > 0
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
  const retry = useSet(invalidateSsh$);
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
      <Button type="button" variant="outline" onClick={retry}>
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
  readonly config: CloudflareAccessConfig;
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
  replace,
}: {
  readonly config: CloudflareAccessConfig | null;
  readonly replace: boolean;
}) {
  const { t } = useTranslation();
  return (
    <>
      {!replace && (
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

export function AccessSelection({
  disabled,
  active,
}: {
  readonly disabled: boolean;
  readonly active: boolean;
}) {
  const { t } = useTranslation();
  const enabled = useGet(sshCloudflareEnabled$);
  const configs = useLoadable(sshCloudflareConfigs$);
  const editor = useGet(sshTransportEditor$);
  const choose = useSet(chooseSshAccessConfig$);
  const create = useSet(openSshAccessStep$);
  const mountCreate = useSet(mountSshAccessCreateButton$);
  if (!enabled || (configs.state === "hasData" && configs.data === null)) {
    return (
      <p role="alert" className="text-sm text-muted-foreground">
        {t(($) => {
          return $.ssh.cloudflare.unavailable;
        })}
      </p>
    );
  }
  return (
    <div className="grid gap-3">
      <p className="text-sm text-muted-foreground">
        {t(($) => {
          return $.ssh.cloudflare.gatewayHelp;
        })}
      </p>
      {configs.state === "hasError" ? (
        <AccessLoadError />
      ) : configs.state === "loading" ? (
        <p role="status">
          {t(($) => {
            return $.ssh.cloudflare.loading;
          })}
        </p>
      ) : configs.data && configs.data.length > 0 ? (
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
            </SelectContent>
          </Select>
          {editor.configId &&
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
      ) : (
        <p className="text-sm text-muted-foreground">
          {t(($) => {
            return $.ssh.cloudflare.empty;
          })}
        </p>
      )}
      {active && !disabled && configs.state === "hasData" && configs.data && (
        <Button
          ref={mountCreate}
          type="button"
          variant="outline"
          className="justify-self-start"
          onClick={create}
        >
          <Plus size={16} aria-hidden="true" />
          {t(($) => {
            return $.ssh.cloudflare.createNew;
          })}
        </Button>
      )}
    </div>
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
                    open("rename-access", config, signal),
                    Reason.DomCallback,
                  );
                }}
              >
                {t(($) => {
                  return $.ssh.cloudflare.rename;
                })}
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  return detach(
                    open("replace-access", config, signal),
                    Reason.DomCallback,
                  );
                }}
              >
                {t(($) => {
                  return $.ssh.cloudflare.replace;
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
