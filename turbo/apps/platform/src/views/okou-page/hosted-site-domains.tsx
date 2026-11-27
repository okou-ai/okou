import type { ReactNode } from "react";
import { Collapsible } from "@base-ui/react/collapsible";
import { useGet, useLastResolved, useLoadable, useSet } from "ccstate-react";
import {
  Check,
  Loader2,
  ChevronDown,
  ExternalLink,
  Circle,
  CircleAlert,
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
  CopyButton,
} from "@okouai/ui";
import { useTranslation } from "react-i18next";
import type { HostedSiteShareSession } from "../../signals/hosted-site-sharing.ts";
import { DomainRecords } from "./hosted-site-domain-records.tsx";
import {
  domainVerificationDeadline,
  domainVerificationTimedOut,
  hostedDomainProgress,
} from "../../lib/hosted-site-domains.ts";

import type { infer as zInfer } from "zod";
import type { hostedDomainSettingsSchema } from "@okouai/api-contracts/contracts/hosted-site-domains";
export interface HostedSiteDomainOperations {
  readonly creating: boolean;
  readonly verifying: boolean;
  readonly verifyFailed: boolean;
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
                {t(
                  ($) => {
                    return $.artifacts.customDomain.configureProvider;
                  },
                  { provider: setup.data.providerName },
                )}
                <ExternalLink size={12} />
              </a>
            )}
            {setup.data.controlPanelUrl &&
              (!setup.data.automaticUrl || certificateOnly) && (
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
type IndicatorState = "active" | "complete" | "waiting" | "attention";

function DomainIndicator({ state }: { readonly state: IndicatorState }) {
  const { t } = useTranslation();
  const label = {
    active: t(($) => {
      return $.artifacts.customDomain.checking;
    }),
    complete: t(($) => {
      return $.artifacts.customDomain.checkPassed;
    }),
    waiting: t(($) => {
      return $.artifacts.customDomain.checkPending;
    }),
    attention: t(($) => {
      return $.artifacts.customDomain.checkFailed;
    }),
  }[state];
  return (
    <span
      role="img"
      aria-label={label}
      className="flex size-5 shrink-0 items-center justify-center"
    >
      {state === "active" ? (
        <Loader2 size={15} className="motion-safe:animate-spin" aria-hidden />
      ) : state === "complete" ? (
        <Check size={15} className="text-green-600" aria-hidden />
      ) : state === "attention" ? (
        <CircleAlert size={15} className="text-destructive" aria-hidden />
      ) : (
        <Circle size={10} className="text-muted-foreground" aria-hidden />
      )}
    </span>
  );
}

function TimelineStep({
  state,
  children,
  last,
}: {
  readonly state: IndicatorState;
  readonly children: ReactNode;
  readonly last?: boolean;
}) {
  return (
    <li className="flex gap-2">
      <div className="flex w-5 shrink-0 flex-col items-center">
        <DomainIndicator state={state} />
        {!last && <span aria-hidden className="my-1 w-px flex-1 bg-border" />}
      </div>
      <div className={cn("min-w-0 flex-1", !last && "pb-4")}>{children}</div>
    </li>
  );
}

function DomainDisclosure({
  label,
  children,
  initiallyOpen = false,
}: {
  readonly label: string;
  readonly children: ReactNode;
  readonly initiallyOpen?: boolean;
}) {
  return (
    <Collapsible.Root defaultOpen={initiallyOpen}>
      <Collapsible.Trigger
        render={<Button variant="quiet" size="sm" />}
        className="group -my-1 -ml-2 flex w-full justify-between gap-2 text-left font-medium"
      >
        {label}
        <ChevronDown
          size={14}
          aria-hidden
          className="shrink-0 text-muted-foreground group-aria-expanded:rotate-180"
        />
      </Collapsible.Trigger>
      <Collapsible.Panel className="pt-3">{children}</Collapsible.Panel>
    </Collapsible.Root>
  );
}

interface DomainStepProps {
  readonly session: HostedSiteShareSession;
  readonly domain: Domain;
}
type TimelineProps = DomainPanelProps &
  DomainStepProps & { readonly configuration: DomainSettings };
function DnsStep({
  session,
  domain,
  verifying,
  dnsConfigured,
  certificateOnly,
}: DomainStepProps & {
  readonly verifying: boolean;
  readonly dnsConfigured: boolean;
  readonly certificateOnly: boolean;
}) {
  const { t } = useTranslation();
  const dnsState: IndicatorState = dnsConfigured
    ? "complete"
    : verifying
      ? "active"
      : domain.verification
        ? "attention"
        : "waiting";
  const records = (
    <DomainRecords session={session} domain={domain} records={domain.records} />
  );
  return (
    <TimelineStep state={dnsState}>
      {dnsConfigured ? (
        <DomainDisclosure
          label={t(($) => {
            return $.artifacts.customDomain.dnsConfigured;
          })}
        >
          {records}
        </DomainDisclosure>
      ) : (
        <>
          <h4 className="font-medium">
            {t(($) => {
              return $.artifacts.customDomain.setUpDns;
            })}
          </h4>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {t(($) => {
              return $.artifacts.customDomain.dnsHelp;
            })}
          </p>
          <div className="mt-3 space-y-3">
            <DomainSetup session={session} certificateOnly={certificateOnly} />
            {records}
          </div>
        </>
      )}
    </TimelineStep>
  );
}
function ConnectionChecks({
  domain,
  background,
}: {
  readonly domain: Domain;
  readonly background: boolean;
}) {
  const { t } = useTranslation();
  const checks = domain.verification?.checks;
  const labels = {
    provider: t(($) => {
      return $.artifacts.customDomain.checks.provider;
    }),
    certificate: t(($) => {
      return $.artifacts.customDomain.checks.certificate;
    }),
    route: t(($) => {
      return $.artifacts.customDomain.checks.route;
    }),
  };
  return (
    <ul
      className="ml-0.5 text-xs"
      aria-label={t(($) => {
        return $.artifacts.customDomain.verificationChecks;
      })}
    >
      {(["provider", "certificate", "route"] as const).map((name) => {
        const status = checks?.[name].status;
        const eligible =
          name !== "route" ||
          (checks?.provider.status === "passed" &&
            checks.certificate.status === "passed");
        const state: IndicatorState =
          domain.ready || status === "passed"
            ? "complete"
            : status === "failed" || status === "unavailable"
              ? "attention"
              : background && eligible && status === "pending"
                ? "active"
                : "waiting";
        return (
          <li
            key={name}
            className="relative flex min-h-7 items-center gap-2 pl-3 before:absolute before:inset-y-0 before:left-0 before:border-l before:border-border after:absolute after:top-1/2 after:left-0 after:w-2 after:border-t after:border-border last:before:bottom-1/2"
          >
            <DomainIndicator state={state} />
            {labels[name]}
          </li>
        );
      })}
    </ul>
  );
}
function ReadyStep({ session, domain }: DomainStepProps) {
  const { t } = useTranslation();
  const copy = useSet(session.domains.copy$);
  const signal = useGet(session.signal$);
  const url = `https://${domain.hostname}`;
  return (
    <TimelineStep state={domain.ready ? "complete" : "waiting"} last>
      <h4
        className={cn("font-medium", !domain.ready && "text-muted-foreground")}
      >
        {t(($) => {
          return $.artifacts.customDomain.ready;
        })}
      </h4>
      {domain.ready && signal && (
        <div className="mt-2 flex items-center gap-2 rounded-lg bg-gray-50 px-3 py-2">
          <code className="min-w-0 flex-1 break-all text-xs">{url}</code>
          <CopyButton
            showTooltip={false}
            copyAction={() => {
              return copy(url, signal);
            }}
          />
        </div>
      )}
    </TimelineStep>
  );
}
function DomainTimelineActions({
  session,
  operations,
  domain,
  configuration,
  background,
}: TimelineProps & { readonly background: boolean }) {
  const { t } = useTranslation();
  const busy = domainBusy(operations);
  const choose = useSet(session.domains.choose$);
  const cancel = useSet(session.domains.back$);
  const close = useSet(session.setOpen$);
  return (
    <div className="mt-4 flex justify-end gap-2">
      {background ? (
        <Button
          variant="outline"
          onClick={() => {
            return close(false);
          }}
        >
          {t(($) => {
            return $.actions.close;
          })}
        </Button>
      ) : (
        <>
          <Button
            variant="quiet"
            disabled={busy}
            onClick={() => {
              return cancel();
            }}
          >
            {t(($) => {
              return $.artifacts.siteUrl.cancel;
            })}
          </Button>
          <Button
            disabled={busy || domain.removing || !configuration.allowed}
            pending={operations.verifying || operations.saving}
            onClick={() => {
              if (domain.ready) {
                choose(domain.id);
                operations.save();
              } else {
                operations.verify();
              }
            }}
          >
            {domain.ready
              ? t(($) => {
                  return $.artifacts.siteUrl.save;
                })
              : domain.verification
                ? t(($) => {
                    return $.artifacts.customDomain.verifyAgain;
                  })
                : t(($) => {
                    return $.artifacts.customDomain.verify;
                  })}
          </Button>
        </>
      )}
    </div>
  );
}
function connectionProgress(
  domain: Domain,
  dnsConfigured: boolean,
  verifying: boolean,
  expiredThrough: number,
) {
  const checks = domain.verification?.checks;
  const automatic = domain.verification?.automatic;
  const timedOut = domainVerificationTimedOut(domain, expiredThrough);
  const background =
    automatic?.status === "checking" && !timedOut && !domain.removing;
  const problem = (
    ["ownership", "dns", "provider", "certificate", "route"] as const
  )
    .map((name) => {
      return checks?.[name];
    })
    .find((check) => {
      return (
        check && (check.status === "failed" || check.status === "unavailable")
      );
    });
  const connectionState: IndicatorState = domain.ready
    ? "complete"
    : background || (verifying && dnsConfigured)
      ? "active"
      : dnsConfigured && (timedOut || problem)
        ? "attention"
        : "waiting";
  return { connectionState, timedOut, background, problem };
}
function DomainTimeline({
  session,
  operations,
  domain,
  configuration,
}: TimelineProps) {
  const { t } = useTranslation();
  const { dnsConfigured, certificateOnly } = hostedDomainProgress(domain);
  const expiredThrough = useGet(session.domains.expiredThrough$);
  const deadline = domainVerificationDeadline(domain);
  const mountDeadline = useSet(session.domains.mountDeadline$);
  const notice = useGet(session.domains.notice$);
  const { connectionState, timedOut, background, problem } = connectionProgress(
    domain,
    dnsConfigured,
    operations.verifying,
    expiredThrough,
  );
  const connectionLabel = timedOut
    ? t(($) => {
        return $.artifacts.customDomain.timedOut;
      })
    : background
      ? t(($) => {
          return $.artifacts.customDomain.connecting;
        })
      : t(($) => {
          return $.artifacts.customDomain.connection;
        });
  const feedback =
    notice ??
    (operations.saveFailed
      ? t(($) => {
          return $.artifacts.siteUrl.saveFailed;
        })
      : operations.verifyFailed
        ? t(($) => {
            return $.artifacts.customDomain.verifyFailed;
          })
        : domain.removing
          ? t(($) => {
              return $.artifacts.customDomain.removing;
            })
          : problem?.message);
  return (
    <>
      <ol
        className="mt-1 text-sm"
        aria-label={t(($) => {
          return $.artifacts.customDomain.setupStages;
        })}
      >
        <DnsStep
          session={session}
          domain={domain}
          verifying={operations.verifying}
          dnsConfigured={dnsConfigured}
          certificateOnly={certificateOnly}
        />
        <TimelineStep state={connectionState}>
          {dnsConfigured ? (
            <DomainDisclosure
              key={domain.ready ? "ready" : "connecting"}
              label={connectionLabel}
              initiallyOpen={!domain.ready}
            >
              <ConnectionChecks domain={domain} background={background} />
            </DomainDisclosure>
          ) : (
            <h4 className="text-muted-foreground">{connectionLabel}</h4>
          )}
          {background && (
            <p className="mt-2 text-xs leading-5 text-muted-foreground">
              {t(($) => {
                return $.artifacts.customDomain.backgroundHint;
              })}
            </p>
          )}
        </TimelineStep>
        <ReadyStep session={session} domain={domain} />
      </ol>
      <div
        key={deadline}
        ref={mountDeadline}
        data-verification-expires-at={deadline}
        role="status"
        aria-live="polite"
        className="text-xs text-muted-foreground"
      >
        <span className="sr-only">
          {domain.ready
            ? t(($) => {
                return $.artifacts.customDomain.ready;
              })
            : connectionLabel}
        </span>
        {feedback && <p className="mt-3">{feedback}</p>}
      </div>
      <DomainTimelineActions
        session={session}
        operations={operations}
        domain={domain}
        configuration={configuration}
        background={background}
      />
    </>
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
  const configuration = useLastResolved(session.domains.settings$);
  const id = useGet(session.domains.managedDomainId$);
  const signal = useGet(session.signal$);
  if (!signal || !configuration) {
    return null;
  }
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
        <DomainTimeline
          key={domain.id}
          session={session}
          operations={operations}
          domain={domain}
          configuration={configuration}
        />
      ) : (
        <NewDomainForm session={session} operations={operations} />
      )}
    </section>
  );
}
