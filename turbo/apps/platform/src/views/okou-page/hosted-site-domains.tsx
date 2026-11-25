import { useGet, useLoadable, useSet } from "ccstate-react";
import { Collapsible } from "@base-ui/react/collapsible";
import { Check, Copy, Loader2, ChevronDown, ExternalLink } from "lucide-react";
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
function DomainRecord({
  session,
  record,
  domain,
}: {
  readonly session: HostedSiteShareSession;
  readonly record: Domain["records"][number];
  readonly domain: Domain;
}) {
  const { t } = useTranslation();
  const copy = useSet(session.domains.copy$);
  const signal = useGet(session.signal$);
  const checked = domain.verification?.recordChecks?.find((check) => {
    return (
      check.type === record.type &&
      check.name === record.name &&
      check.value === record.value
    );
  });
  const passed = checked?.status === "passed";
  if (!signal) {
    return null;
  }
  return (
    <Collapsible.Root
      defaultOpen={!passed}
      className="border-b border-border last:border-b-0"
    >
      <Collapsible.Trigger className="flex w-full items-center gap-2 p-3 text-left text-xs hover:bg-muted/50">
        {passed ? (
          <Check size={14} className="shrink-0 text-green-600" />
        ) : (
          <span aria-hidden="true">○</span>
        )}
        <span className="font-medium">{record.type}</span>
        <span className="min-w-0 flex-1 break-all">{record.name}</span>
        <span className="shrink-0 text-muted-foreground">
          {passed
            ? t(($) => {
                return $.artifacts.customDomain.recordMatched;
              })
            : t(($) => {
                return $.artifacts.customDomain.recordNeedsCheck;
              })}
        </span>
        <ChevronDown size={12} className="shrink-0" />
      </Collapsible.Trigger>
      <Collapsible.Panel className="space-y-2 px-3 pb-3">
        {(["name", "value"] as const).map((field) => {
          return (
            <div key={field} className="flex items-start gap-2">
              <span className="w-10 shrink-0 pt-1 text-xs text-muted-foreground">
                {field === "name"
                  ? t(($) => {
                      return $.artifacts.customDomain.recordName;
                    })
                  : t(($) => {
                      return $.artifacts.customDomain.recordValue;
                    })}
              </span>
              <code className="min-w-0 flex-1 break-all pt-1 text-xs">
                {record[field]}
              </code>
              <IconButton
                aria-label={
                  field === "name"
                    ? t(
                        ($) => {
                          return $.artifacts.customDomain.copyRecordName;
                        },
                        {
                          type: record.type,
                          name: record.name,
                        },
                      )
                    : t(
                        ($) => {
                          return $.artifacts.customDomain.copyRecordValue;
                        },
                        {
                          type: record.type,
                          name: record.name,
                        },
                      )
                }
                onClick={() => {
                  detach(copy(record[field], signal), Reason.DomCallback);
                }}
              >
                <Copy size={14} />
              </IconButton>
            </div>
          );
        })}
        {checked && !passed && (
          <p className="text-xs text-muted-foreground">{checked.message}</p>
        )}
      </Collapsible.Panel>
    </Collapsible.Root>
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
  return (
    <>
      <div className="max-h-64 overflow-y-auto rounded-xl border border-border">
        {domain.records.map((record) => {
          const passed = domain.verification?.recordChecks?.some((check) => {
            return (
              check.type === record.type &&
              check.name === record.name &&
              check.value === record.value &&
              check.status === "passed"
            );
          });
          return (
            <DomainRecord
              key={`${record.type}-${record.name}-${record.value}-${Boolean(passed)}`}
              session={session}
              domain={domain}
              record={record}
            />
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
function DomainSetup({
  session,
}: {
  readonly session: HostedSiteShareSession;
}) {
  const { t } = useTranslation();
  const setup = useLoadable(session.domains.setup$);
  return (
    <div className="mb-3 min-h-16 text-xs">
      {setup.state === "loading" ? (
        <p className="flex items-center gap-2 text-muted-foreground">
          <Loader2 size={12} className="animate-spin" />
          {t(($) => {
            return $.artifacts.customDomain.findingProvider;
          })}
        </p>
      ) : setup.state === "hasData" && setup.data ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            {setup.data.automaticUrl && (
              <Button
                size="sm"
                nativeButton={false}
                variant="outline"
                render={
                  <a
                    href={setup.data.automaticUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  />
                }
              >
                {t(($) => {
                  return $.artifacts.customDomain.automaticSetup;
                })}
                <ExternalLink size={12} />
              </Button>
            )}
            {setup.data.controlPanelUrl && (
              <Button
                size="sm"
                nativeButton={false}
                variant="quiet"
                render={
                  <a
                    href={setup.data.controlPanelUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  />
                }
              >
                {t(
                  ($) => {
                    return $.artifacts.customDomain.openDns;
                  },
                  {
                    provider: setup.data.providerName,
                  },
                )}
                <ExternalLink size={12} />
              </Button>
            )}
          </div>
          <p className="mt-2 text-muted-foreground">
            {setup.data.automaticUrl
              ? t(($) => {
                  return $.artifacts.customDomain.automaticHint;
                })
              : t(($) => {
                  return $.artifacts.customDomain.manualHint;
                })}
          </p>
        </>
      ) : (
        <p className="text-muted-foreground">
          {t(($) => {
            return $.artifacts.customDomain.manualHint;
          })}
        </p>
      )}
    </div>
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
    provider: t(($) => {
      return $.artifacts.customDomain.checks.provider;
    }),
    route: t(($) => {
      return $.artifacts.customDomain.checks.route;
    }),
    certificate: t(($) => {
      return $.artifacts.customDomain.checks.certificate;
    }),
  };
  return (
    <>
      {" "}
      <ul
        className="mt-3 space-y-2 text-xs text-muted-foreground"
        aria-label={t(($) => {
          return $.artifacts.customDomain.verificationChecks;
        })}
      >
        {(
          ["ownership", "dns", "provider", "certificate", "route"] as const
        ).map((name) => {
          const check = domain.verification?.checks[name];
          return (
            <li key={name}>
              <div className="flex items-center gap-2">
                {check?.status === "passed" ? (
                  <Check size={12} className="text-green-600" />
                ) : (
                  <span aria-hidden="true">○</span>
                )}
                <span>{labels[name]}</span>
                <span className="ml-auto">
                  {check?.status === "passed"
                    ? t(($) => {
                        return $.artifacts.customDomain.checkPassed;
                      })
                    : check?.status === "unavailable"
                      ? t(($) => {
                          return $.artifacts.customDomain.checkUnavailable;
                        })
                      : check?.status === "failed"
                        ? t(($) => {
                            return $.artifacts.customDomain.checkFailed;
                          })
                        : check?.status === "pending"
                          ? t(($) => {
                              return $.artifacts.customDomain.checkPending;
                            })
                          : t(($) => {
                              return $.artifacts.customDomain.checkNotChecked;
                            })}
                </span>
              </div>
              {check &&
                check.status !== "passed" &&
                check.status !== "not_checked" && (
                  <p className="mt-1 pl-5">{check.message}</p>
                )}
            </li>
          );
        })}
      </ul>
      <p className="mt-3 min-h-10 text-xs text-muted-foreground" role="status">
        {notice ??
          (domain.removing
            ? t(($) => {
                return $.artifacts.customDomain.removing;
              })
            : domain.ready
              ? t(($) => {
                  return $.artifacts.customDomain.verified;
                })
              : domain.verification
                ? t(($) => {
                    return $.artifacts.customDomain.verificationPending;
                  })
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
          <DomainSetup session={session} />
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
