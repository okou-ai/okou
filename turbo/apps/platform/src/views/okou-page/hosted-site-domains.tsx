import { useGet, useLoadable, useSet } from "ccstate-react";
import { ArrowLeft, Check, Copy, Loader2 } from "lucide-react";
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
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
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
  readonly create: () => void;
  readonly verify: () => void;
  readonly remove: () => void;
}
type DomainSettings = zInfer<typeof hostedDomainSettingsSchema>;
type Domain = DomainSettings["domains"][number];
interface DomainPanelProps {
  readonly session: HostedSiteShareSession;
  readonly operations: HostedSiteDomainOperations;
}
function domainBusy(operations: HostedSiteDomainOperations) {
  return operations.creating || operations.verifying || operations.removing;
}
function DomainPicker({
  session,
  operations,
  configuration,
}: { readonly configuration: DomainSettings } & DomainPanelProps) {
  const { t } = useTranslation();
  const busy = domainBusy(operations);
  const id = useGet(session.domains.managedDomainId$);
  const manage = useSet(session.domains.manage$);
  return (
    <div className="mb-4">
      <label
        className="mb-2 block text-sm"
        htmlFor={`${session.inputId}-domain`}
      >
        {t(($) => {
          return $.artifacts.customDomain.yourDomains;
        })}
      </label>
      <Select
        value={id ?? "new"}
        onValueChange={(value) => {
          return manage(value === "new" ? null : value);
        }}
        disabled={busy}
      >
        <SelectTrigger autoFocus id={`${session.inputId}-domain`}>
          <SelectValue>
            {configuration.domains.find((domain) => {
              return domain.id === id;
            })?.hostname ??
              t(($) => {
                return $.artifacts.customDomain.addAnother;
              })}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {configuration.domains.map((item) => {
            return (
              <SelectItem key={item.id} value={item.id}>
                {item.hostname}
              </SelectItem>
            );
          })}
          <SelectItem value="new">
            {t(($) => {
              return $.artifacts.customDomain.addAnother;
            })}
          </SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}
function NewDomainForm({ session, operations }: DomainPanelProps) {
  const { t } = useTranslation();
  const busy = domainBusy(operations);
  const hostname = useGet(session.domains.hostname$);
  const notice = useGet(session.domains.notice$);
  const edit = useSet(session.domains.editHostname$);
  const create = operations.create;
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
      <div className="mt-4 flex justify-end">
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
  const confirmRemoval = useSet(session.domains.confirmRemoval$);
  const back = useSet(session.domains.back$);
  const { remove, verify } = operations;
  return (
    <div className="mt-4 flex flex-wrap justify-end gap-1">
      <Button
        variant="quiet"
        className="mr-auto"
        disabled={busy}
        onClick={() => {
          if (configuration.selectedDomainId === domain.id) {
            confirmRemoval(true);
            return;
          }
          remove();
        }}
      >
        {t(($) => {
          return $.artifacts.customDomain.remove;
        })}
      </Button>
      <Button
        variant="quiet"
        disabled={busy}
        onClick={() => {
          return back();
        }}
      >
        {t(($) => {
          return $.artifacts.customDomain.back;
        })}
      </Button>
      <Button
        className="min-w-24"
        disabled={busy || domain.removing}
        onClick={() => {
          verify();
        }}
      >
        {operations.verifying && <Loader2 size={14} className="animate-spin" />}
        {t(($) => {
          return $.artifacts.customDomain.verify;
        })}
      </Button>
    </div>
  );
}
function DomainRemoveDialog({
  session,
  operations,
  configuration,
}: DomainPanelProps & { readonly configuration: DomainSettings }) {
  const { t } = useTranslation();
  const busy = domainBusy(operations);
  const removalConfirmation = useGet(session.domains.removalConfirmation$);
  const confirmRemoval = useSet(session.domains.confirmRemoval$);
  const remove = operations.remove;
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
            {t(
              ($) => {
                return $.artifacts.customDomain.removeConfirm;
              },
              {
                url: configuration.defaultUrl,
              },
            )}
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
  const busy = domainBusy(operations);
  const settings = useLoadable(session.domains.settings$);
  const id = useGet(session.domains.managedDomainId$);
  const notice = useGet(session.domains.notice$);
  const signal = useGet(session.signal$);
  const back = useSet(session.domains.back$);
  if (!signal || settings.state !== "hasData" || !settings.data) {
    return null;
  }
  const configuration = settings.data;
  const domain = configuration.domains.find((item) => {
    return item.id === id;
  });
  return (
    <section
      className="mt-4"
      aria-label={t(($) => {
        return $.artifacts.customDomain.title;
      })}
    >
      <div className="mb-4 flex items-center gap-2">
        <IconButton
          aria-label={t(($) => {
            return $.artifacts.customDomain.back;
          })}
          disabled={busy}
          onClick={() => {
            return back();
          }}
        >
          <ArrowLeft size={16} />
        </IconButton>
        <h3 className="text-sm font-medium">
          {t(($) => {
            return $.artifacts.customDomain.title;
          })}
        </h3>
      </div>

      {configuration.domains.length > 0 && (
        <DomainPicker
          session={session}
          operations={operations}
          configuration={configuration}
        />
      )}
      {domain ? (
        <>
          <DomainRecords session={session} domain={domain} />
          <DomainStatus domain={domain} notice={notice} />
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
      <DomainRemoveDialog
        session={session}
        operations={operations}
        configuration={configuration}
      />
    </section>
  );
}
