import { useGet, useLoadable, useSet } from "ccstate-react";
import { Check, Copy, Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  Button,
  IconButton,
  Input,
} from "@okouai/ui";
import { useTranslation } from "react-i18next";
import type { HostedSiteShareSession } from "../../signals/hosted-site-sharing.ts";
import { detach, Reason } from "../../signals/utils.ts";

import type { infer as zInfer } from "zod";
import type { hostedDomainSettingsSchema } from "@okouai/api-contracts/contracts/hosted-site-domains";
export interface HostedSiteDomainOperations {
  readonly creating: boolean;
  readonly verifying: boolean;
  readonly removing: boolean;
  readonly saving: boolean;
  readonly saveFailed: boolean;
  readonly create: () => void;
  readonly verify: () => void;
  readonly remove: () => void;
  readonly save: () => void;
}
type DomainSettings = zInfer<typeof hostedDomainSettingsSchema>;
type Domain = DomainSettings["domains"][number];
interface DomainPanelProps {
  readonly session: HostedSiteShareSession;
  readonly operations: HostedSiteDomainOperations;
}
function domainBusy(operations: HostedSiteDomainOperations) {
  return (
    operations.creating ||
    operations.verifying ||
    operations.removing ||
    operations.saving
  );
}
function NewDomainForm({ session, operations }: DomainPanelProps) {
  const { t } = useTranslation();
  const busy = domainBusy(operations);
  const hostname = useGet(session.domains.hostname$);
  const notice = useGet(session.domains.notice$);
  const edit = useSet(session.domains.editHostname$);
  const create = operations.create;
  const cancel = useSet(session.domains.back$);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        create();
      }}
    >
      <label
        className="mb-2 block text-sm"
        htmlFor={`${session.inputId}-hostname`}
      >
        {t(($) => {
          return $.artifacts.customDomain.domain;
        })}
      </label>
      <Input
        id={`${session.inputId}-hostname`}
        autoFocus
        value={hostname}
        placeholder={t(($) => {
          return $.artifacts.customDomain.hostnameExample;
        })}
        autoCapitalize="none"
        autoComplete="off"
        spellCheck={false}
        disabled={busy}
        onChange={(event) => {
          return edit(event.target.value);
        }}
        onKeyDown={(event) => {
          if (
            event.key === "Enter" &&
            (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)
          ) {
            event.preventDefault();
          }
        }}
      />
      <p className="mt-2 text-xs text-muted-foreground">
        {t(($) => {
          return $.artifacts.customDomain.ownDomain;
        })}
      </p>
      <p role="status" className="mt-3 min-h-10 text-xs text-destructive">
        {notice}
      </p>
      <div className="mt-4 flex justify-between">
        <Button
          type="button"
          variant="quiet"
          disabled={busy}
          onClick={() => {
            cancel();
          }}
        >
          {t(($) => {
            return $.artifacts.siteUrl.cancel;
          })}
        </Button>
        <Button type="submit" disabled={busy || !hostname.trim()}>
          {operations.creating && (
            <Loader2 size={14} className="animate-spin" />
          )}
          {t(($) => {
            return $.artifacts.customDomain.continue;
          })}
        </Button>
      </div>
    </form>
  );
}
function DomainRecords({
  session,
  domain,
}: {
  readonly session: HostedSiteShareSession;
  readonly domain: Domain;
}) {
  const { t } = useTranslation();
  const copy = useSet(session.domains.copy$);
  const signal = useGet(session.signal$);
  if (!signal) {
    return null;
  }
  return (
    <>
      {" "}
      <div className="overflow-hidden rounded-xl border border-border">
        {domain.records.map((record) => {
          return (
            <div
              key={`${record.type}-${record.name}-${record.value}`}
              className="grid grid-cols-[3rem_minmax(0,1fr)_2rem] items-center gap-2 border-b border-border p-3 last:border-b-0"
            >
              <span className="row-span-2 text-xs font-medium">
                {record.type}
              </span>
              <code className="min-w-0 break-all text-xs">{record.name}</code>
              <IconButton
                className="row-span-2"
                aria-label={t(
                  ($) => {
                    return $.artifacts.customDomain.copyRecord;
                  },
                  {
                    type: record.type,
                  },
                )}
                onClick={() => {
                  detach(copy(record.value, signal), Reason.DomCallback);
                }}
              >
                <Copy size={14} />
              </IconButton>
              <code className="col-start-2 min-w-0 break-all text-xs text-muted-foreground">
                {record.value}
              </code>
            </div>
          );
        })}
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        {t(($) => {
          return $.artifacts.customDomain.dnsHelp;
        })}
      </p>
    </>
  );
}
function DomainStatus({
  domain,
  notice,
}: {
  readonly domain: Domain;
  readonly notice: string | null;
}) {
  const { t } = useTranslation();
  const labels = {
    ownership: t(($) => {
      return $.artifacts.customDomain.checks.ownership;
    }),
    dns: t(($) => {
      return $.artifacts.customDomain.checks.dns;
    }),
    certificate: t(($) => {
      return $.artifacts.customDomain.checks.certificate;
    }),
  };
  return (
    <>
      {" "}
      <div className="mt-3 flex flex-wrap gap-x-3 gap-y-2 text-xs text-muted-foreground">
        {(["ownership", "dns", "certificate"] as const).map((check) => {
          return (
            <span key={check} className="flex items-center gap-1">
              {domain.verification?.checks[check].status === "passed" ? (
                <Check size={12} className="text-green-600" />
              ) : (
                <span aria-hidden="true">○</span>
              )}
              {labels[check]}
            </span>
          );
        })}
      </div>
      <p className="mt-3 min-h-10 text-xs text-muted-foreground" role="status">
        {notice ??
          (domain.removing
            ? t(($) => {
                return $.artifacts.customDomain.removing;
              })
            : domain.verification?.status === "unavailable"
              ? Object.values(domain.verification.checks).find((check) => {
                  return check.status === "unavailable";
                })?.message
              : domain.ready
                ? t(($) => {
                    return $.artifacts.customDomain.verified;
                  })
                : domain.verification
                  ? Object.values(domain.verification.checks).find((check) => {
                      return (
                        check.status !== "passed" &&
                        check.status !== "not_checked"
                      );
                    })?.message
                  : t(($) => {
                      return $.artifacts.customDomain.notChecked;
                    }))}
      </p>
      <p className="min-h-5 text-xs text-muted-foreground">
        {domain.verification
          ? t(
              ($) => {
                return $.artifacts.customDomain.lastChecked;
              },
              {
                time: new Date(
                  domain.verification.checkedAt,
                ).toLocaleTimeString(),
              },
            )
          : null}
      </p>
    </>
  );
}
function DomainActions({
  session,
  operations,
  domain,
  configuration,
}: DomainPanelProps & {
  readonly domain: Domain;
  readonly configuration: DomainSettings;
}) {
  const { t } = useTranslation();
  const busy = domainBusy(operations);
  const cancel = useSet(session.domains.back$);
  const choose = useSet(session.domains.choose$);
  return (
    <div className="mt-4 flex items-center justify-between gap-2">
      <Button
        variant="quiet"
        disabled={busy}
        onClick={() => {
          cancel();
        }}
      >
        {t(($) => {
          return $.artifacts.siteUrl.cancel;
        })}
      </Button>
      <Button
        className="min-w-24"
        disabled={busy || domain.removing || !configuration.allowed}
        onClick={() => {
          if (domain.ready) {
            choose(domain.id);
            operations.save();
          } else {
            operations.verify();
          }
        }}
      >
        {(operations.verifying || operations.saving) && (
          <Loader2 size={14} className="animate-spin" />
        )}
        {domain.ready
          ? t(($) => {
              return $.artifacts.siteUrl.save;
            })
          : t(($) => {
              return $.artifacts.customDomain.verify;
            })}
      </Button>
    </div>
  );
}
export function HostedSiteDomainRemoveDialog({
  session,
  operations,
  configuration,
}: DomainPanelProps & { readonly configuration: DomainSettings }) {
  const { t } = useTranslation();
  const busy = domainBusy(operations);
  const removalConfirmation = useGet(session.domains.removalConfirmation$);
  const confirmRemoval = useSet(session.domains.confirmRemoval$);
  const remove = operations.remove;
  const managedId = useGet(session.domains.managedDomainId$);
  return (
    <Dialog
      open={removalConfirmation}
      onOpenChange={(open) => {
        if (!busy) {
          confirmRemoval(open);
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t(($) => {
              return $.artifacts.customDomain.removeTitle;
            })}
          </DialogTitle>
          <DialogDescription>
            {managedId === configuration.selectedDomainId
              ? t(
                  ($) => {
                    return $.artifacts.customDomain.removeConfirm;
                  },
                  { url: configuration.defaultUrl },
                )
              : t(($) => {
                  return $.artifacts.customDomain.disconnectConfirm;
                })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => {
              return confirmRemoval(false);
            }}
          >
            {t(($) => {
              return $.artifacts.siteUrl.cancel;
            })}
          </Button>
          <Button
            disabled={busy}
            onClick={() => {
              remove();
            }}
          >
            {t(($) => {
              return $.artifacts.customDomain.remove;
            })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
export function HostedSiteDomains({ session, operations }: DomainPanelProps) {
  const { t } = useTranslation();
  const settings = useLoadable(session.domains.settings$);
  const id = useGet(session.domains.managedDomainId$);
  const notice = useGet(session.domains.notice$);
  const signal = useGet(session.signal$);
  if (!signal || settings.state !== "hasData" || !settings.data) {
    return null;
  }
  const configuration = settings.data;
  const domain = configuration.domains.find((item) => {
    return item.id === id;
  });
  return (
    <section
      aria-label={t(($) => {
        return $.artifacts.customDomain.title;
      })}
    >
      <div className="mb-4 flex items-center gap-2">
        <h3 className="min-w-0 break-all text-sm font-medium">
          {domain?.hostname ??
            t(($) => {
              return $.artifacts.customDomain.connect;
            })}
        </h3>
      </div>

      {domain ? (
        <>
          <DomainRecords session={session} domain={domain} />
          <DomainStatus
            domain={domain}
            notice={
              operations.saveFailed
                ? t(($) => {
                    return $.artifacts.siteUrl.saveFailed;
                  })
                : notice
            }
          />
          <DomainActions
            session={session}
            operations={operations}
            domain={domain}
            configuration={configuration}
          />
        </>
      ) : (
        <NewDomainForm session={session} operations={operations} />
      )}
    </section>
  );
}
