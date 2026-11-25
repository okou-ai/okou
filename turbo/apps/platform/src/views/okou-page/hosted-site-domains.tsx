import { useGet, useLastResolved, useLoadable, useSet } from "ccstate-react";
import { Collapsible } from "@base-ui/react/collapsible";
import {
  Check,
  Loader2,
  ChevronDown,
  ExternalLink,
  Circle,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  Button,
  buttonVariants,
  cn,
  Input,
} from "@okouai/ui";
import { useTranslation } from "react-i18next";
import type { HostedSiteShareSession } from "../../signals/hosted-site-sharing.ts";
import {
  DomainRecords,
  VerifiedDomainRecords,
} from "./hosted-site-domain-records.tsx";
import type { DomainSetupStage } from "../../lib/hosted-site-domains.ts";

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
function DomainSetup({
  session,
  certificateOnly,
}: {
  readonly session: HostedSiteShareSession;
  readonly certificateOnly: boolean;
}) {
  const { t } = useTranslation();
  const setup = useLoadable(session.domains.setup$);
  return (
    <div className="min-h-36 rounded-xl bg-gray-50 p-3 text-xs sm:min-h-28">
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
            {setup.data.automaticUrl && !certificateOnly && (
              <a
                className={buttonVariants({ size: "sm", variant: "outline" })}
                href={setup.data.automaticUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                {t(($) => {
                  return $.artifacts.customDomain.automaticSetup;
                })}
                <ExternalLink size={12} />
              </a>
            )}
            {setup.data.controlPanelUrl && (
              <a
                className={buttonVariants({ size: "sm", variant: "quiet" })}
                href={setup.data.controlPanelUrl}
                target="_blank"
                rel="noopener noreferrer"
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
              </a>
            )}
          </div>
          <p className="mt-2 text-muted-foreground">
            {setup.data.automaticUrl && !certificateOnly
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
function DomainChecks({ domain }: { readonly domain: Domain }) {
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
      <ul
        className="space-y-3 text-xs text-muted-foreground"
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
              <div className="flex items-start gap-2">
                {check?.status === "passed" ? (
                  <Check
                    size={14}
                    className="mt-0.5 shrink-0 text-green-600"
                    aria-hidden
                  />
                ) : (
                  <Circle size={12} className="mt-0.5 shrink-0" aria-hidden />
                )}
                <span className="min-w-0 flex-1 text-foreground">
                  {labels[name]}
                </span>
                <span className="shrink-0">
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
                  <p className="mt-1 pl-5 leading-5">{check.message}</p>
                )}
            </li>
          );
        })}
      </ul>
      <p className="mt-3 text-xs text-muted-foreground">
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
function DomainVerificationDetails({ domain }: { readonly domain: Domain }) {
  const { t } = useTranslation();
  return (
    <Collapsible.Root className="group/verification">
      <Collapsible.Trigger className="flex w-full items-center gap-2 rounded-lg py-2 text-left text-xs text-muted-foreground hover:bg-gray-50">
        <span className="flex-1">
          {t(($) => {
            return $.artifacts.customDomain.verificationDetails;
          })}
        </span>
        <ChevronDown
          size={14}
          className="shrink-0 group-data-[open]/verification:rotate-180"
          aria-hidden
        />
      </Collapsible.Trigger>
      <Collapsible.Panel className="pt-3">
        <DomainChecks domain={domain} />
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}
function DomainSteps({
  session,
  stage,
  currentStage,
  busy,
}: {
  readonly session: HostedSiteShareSession;
  readonly stage: DomainSetupStage;
  readonly currentStage: DomainSetupStage;
  readonly busy: boolean;
}) {
  const { t } = useTranslation();
  const review = useSet(session.domains.reviewStage$);
  const labels = [
    t(($) => {
      return $.artifacts.customDomain.steps.dns;
    }),
    t(($) => {
      return $.artifacts.customDomain.steps.verify;
    }),
    t(($) => {
      return $.artifacts.customDomain.steps.enable;
    }),
  ];
  return (
    <ol
      className="grid grid-cols-3 gap-2"
      aria-label={t(($) => {
        return $.artifacts.customDomain.setupStages;
      })}
    >
      {([0, 1, 2] as const).map((step) => {
        return (
          <li key={step} className="min-w-0">
            <Button
              variant="quiet"
              className={cn(
                "h-auto min-h-10 w-full justify-start gap-2 whitespace-normal px-2 py-2 text-left text-xs",
                stage === step && "bg-gray-50 font-medium text-foreground",
              )}
              aria-label={labels[step]}
              aria-current={stage === step ? "step" : undefined}
              disabled={busy || step > currentStage}
              onClick={() => {
                review(step);
              }}
            >
              <span
                aria-hidden
                className={cn(
                  "flex size-5 shrink-0 items-center justify-center rounded-full border border-border",
                  step < currentStage && "border-green-600 text-green-600",
                )}
              >
                {step < currentStage ? <Check size={12} /> : step + 1}
              </span>
              {labels[step]}
            </Button>
          </li>
        );
      })}
    </ol>
  );
}
function DomainEnable({ domain }: { readonly domain: Domain }) {
  const { t } = useTranslation();
  return (
    <>
      <div className="space-y-2">
        <h4 className="text-sm font-medium">
          {t(($) => {
            return $.artifacts.customDomain.verified;
          })}
        </h4>
      </div>
      <div className="rounded-xl bg-gray-50 p-4">
        <p className="mb-3 text-xs text-muted-foreground">
          {t(($) => {
            return $.artifacts.customDomain.sharingAddress;
          })}
        </p>
        <code className="break-all text-sm">
          {t(
            ($) => {
              return $.artifacts.customDomain.urlPreview;
            },
            { hostname: domain.hostname },
          )}
        </code>
      </div>
      <p className="text-xs leading-5 text-muted-foreground">
        {t(($) => {
          return $.artifacts.customDomain.saveToEnable;
        })}
      </p>
      <DomainVerificationDetails domain={domain} />
    </>
  );
}
function DomainWizard({
  session,
  operations,
  domain,
}: DomainPanelProps & { readonly domain: Domain }) {
  const { t } = useTranslation();
  const wizard = useLastResolved(session.domains.wizard$);
  if (!wizard) {
    return null;
  }
  const {
    stage,
    currentStage,
    remainingRecords,
    matchedRecords,
    dnsMatched,
    certificateOnly,
  } = wizard;
  return (
    <div className="space-y-5">
      <DomainSteps
        session={session}
        stage={stage}
        currentStage={currentStage}
        busy={domainBusy(operations)}
      />
      {stage === 0 ? (
        <>
          <div className="space-y-2">
            <h4 className="text-sm font-medium">
              {dnsMatched
                ? t(($) => {
                    return $.artifacts.customDomain.dnsConfigured;
                  })
                : currentStage > 0
                  ? t(($) => {
                      return $.artifacts.customDomain.reviewDns;
                    })
                  : t(($) => {
                      return $.artifacts.customDomain.setUpDns;
                    })}
            </h4>
            <p className="text-xs leading-5 text-muted-foreground">
              {dnsMatched
                ? t(($) => {
                    return $.artifacts.customDomain.noDnsChanges;
                  })
                : currentStage > 0
                  ? t(($) => {
                      return $.artifacts.customDomain.checkBeforeEditing;
                    })
                  : t(($) => {
                      return $.artifacts.customDomain.dnsHelp;
                    })}
            </p>
          </div>
          {!dnsMatched && currentStage === 0 && (
            <DomainSetup session={session} certificateOnly={certificateOnly} />
          )}
          <DomainRecords
            session={session}
            domain={domain}
            records={remainingRecords}
          />
          <VerifiedDomainRecords
            session={session}
            domain={domain}
            records={matchedRecords}
          />
          <DomainVerificationDetails domain={domain} />
        </>
      ) : stage === 1 ? (
        <>
          <div className="space-y-2">
            <h4 className="text-sm font-medium">
              {t(($) => {
                return $.artifacts.customDomain.verifyDomain;
              })}
            </h4>
            <p className="text-xs leading-5 text-muted-foreground">
              {currentStage === 2
                ? t(($) => {
                    return $.artifacts.customDomain.verificationComplete;
                  })
                : dnsMatched
                  ? t(($) => {
                      return $.artifacts.customDomain.noDnsChanges;
                    })
                  : t(($) => {
                      return $.artifacts.customDomain.retryVerification;
                    })}
            </p>
          </div>
          <div className="rounded-xl bg-gray-50 p-4">
            <DomainChecks domain={domain} />
          </div>
        </>
      ) : (
        <DomainEnable domain={domain} />
      )}
    </div>
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
  const review = useSet(session.domains.reviewStage$);
  const wizard = useLastResolved(session.domains.wizard$);
  if (!wizard) {
    return null;
  }
  const { stage, currentStage } = wizard;
  const reviewing = stage < currentStage;
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
        pending={operations.verifying || operations.saving}
        onClick={() => {
          if (reviewing) {
            review(stage === 0 ? 1 : 2);
          } else if (domain.ready) {
            choose(domain.id);
            operations.save();
          } else {
            operations.verify();
          }
        }}
      >
        {reviewing
          ? t(($) => {
              return $.artifacts.customDomain.continue;
            })
          : domain.ready
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
          <DomainWizard
            key={`${domain.id}-wizard`}
            session={session}
            operations={operations}
            domain={domain}
          />
          <p
            className="mt-3 min-h-5 text-xs text-muted-foreground"
            role="status"
          >
            {operations.saveFailed
              ? t(($) => {
                  return $.artifacts.siteUrl.saveFailed;
                })
              : (notice ??
                (domain.removing
                  ? t(($) => {
                      return $.artifacts.customDomain.removing;
                    })
                  : !domain.verification && !domain.ready
                    ? t(($) => {
                        return $.artifacts.customDomain.notChecked;
                      })
                    : null))}
          </p>
          <DomainActions
            key={`${domain.id}-actions`}
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
