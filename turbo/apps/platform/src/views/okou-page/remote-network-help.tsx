import { useGet, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import {
  ArrowRight,
  ChevronRight,
  Cloud,
  ExternalLink,
  CircleHelp,
  Network,
} from "lucide-react";
import {
  Button,
  CopyButton,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogBody,
} from "@okouai/ui";
import { buttonVariants } from "@okouai/ui/components/ui/button";
import { cn } from "@okouai/ui/lib/utils";
import { searchParams$ } from "../../signals/route.ts";
import {
  remoteSetup$,
  returnToRemoteNetworkProvider$,
} from "../../signals/remote-control-setup.ts";
import {
  remoteNetworkGuide$,
  openRemoteNetworkGuide$,
  closeRemoteNetworkGuide$,
  moveRemoteNetworkGuide$,
  REMOTE_NETWORK_GUIDE_STEP_COUNT,
  type NetworkGuideProvider,
} from "../../signals/remote-network-guide.ts";

export function useRemoteNetworkSaveLabel() {
  const { t } = useTranslation();
  const setup = useGet(remoteSetup$);
  return setup?.step === "oauth" || setup?.step === "cf-credentials"
    ? t(($) => {
        return $.remoteNetworkGuide.saveContinue;
      })
    : t(($) => {
        return $.remoteNetworkGuide.saveNetwork;
      });
}
interface GuideStep {
  readonly title: string;
  readonly description?: string;
  readonly actions: readonly string[];
  readonly path?: string;
  readonly href?: string;
  readonly link?: string;
  readonly rows?: readonly {
    readonly label: string;
    readonly value: string;
    readonly copyable?: boolean;
  }[];
  readonly note?: string;
  readonly blockerTitle?: string;
  readonly blocker?: readonly string[];
  readonly blockerHref?: string;
  readonly blockerLink?: string;
}
function useGuideSteps(
  provider: NetworkGuideProvider,
  tags: string,
): readonly GuideStep[] {
  const { t } = useTranslation();
  const saveAction = useRemoteNetworkSaveLabel();
  const values = {
    tags,
    tagNames: tags
      .split(/[,\s]+/u)
      .filter(Boolean)
      .map((tag) => {
        return tag.replace(/^tag:/u, "");
      })
      .join(", "),
    saveAction,
    clientId: t(($) => {
      return $.remoteNetworkGuide.clientId;
    }),
    clientSecret: t(($) => {
      return $.remoteNetworkGuide.clientSecret;
    }),
  };
  const cloudflareStart = useCloudflareStartSteps(values);
  const cloudflareFinish = useCloudflareFinishSteps(values);
  const tailscaleStart = useTailscaleStartSteps(values);
  const tailscaleFinish = useTailscaleFinishSteps(values);
  return provider === "cloudflare"
    ? [...cloudflareStart, ...cloudflareFinish]
    : [...tailscaleStart, ...tailscaleFinish];
}
function useCloudflareStartSteps(values: {
  tags: string;
  tagNames: string;
  saveAction: string;
  clientId: string;
  clientSecret: string;
}): readonly GuideStep[] {
  const { t } = useTranslation();
  return [
    {
      title: t(($) => {
        return $.remoteNetworkGuide.cf2Title;
      }, values),
      description: t(($) => {
        return $.remoteNetworkGuide.cf2a;
      }, values),
      path: t(($) => {
        return $.remoteNetworkGuide.cf1c;
      }),
      href: "https://dash.cloudflare.com/",
      link: t(($) => {
        return $.remoteNetworkGuide.openCloudflare;
      }),
      rows: [
        {
          label: t(($) => {
            return $.remoteNetworkGuide.fieldName;
          }),
          value: t(($) => {
            return $.remoteNetworkGuide.Okou;
          }),
        },
        {
          label: t(($) => {
            return $.remoteNetworkGuide.duration;
          }),
          value: t(($) => {
            return $.remoteNetworkGuide.requiredDuration;
          }),
        },
      ],
      actions: [
        t(($) => {
          return $.remoteNetworkGuide.cf2c;
        }, values),
      ],
    },
  ];
}
function useCloudflareFinishSteps(values: {
  tags: string;
  tagNames: string;
  saveAction: string;
  clientId: string;
  clientSecret: string;
}): readonly GuideStep[] {
  const { t } = useTranslation();
  return [
    {
      title: t(($) => {
        return $.remoteNetworkGuide.cf3Title;
      }, values),
      description: t(($) => {
        return $.remoteNetworkGuide.cf3b;
      }, values),
      path: t(($) => {
        return $.remoteNetworkGuide.cf3a;
      }),
      rows: [
        {
          label: t(($) => {
            return $.remoteNetworkGuide.fieldName;
          }),
          value: t(($) => {
            return $.remoteNetworkGuide.Okou;
          }),
        },
        {
          label: t(($) => {
            return $.remoteNetworkGuide.action;
          }),
          value: t(($) => {
            return $.remoteNetworkGuide.serviceAuth;
          }),
        },
        {
          label: t(($) => {
            return $.remoteNetworkGuide.selector;
          }),
          value: t(($) => {
            return $.remoteNetworkGuide.serviceToken;
          }),
        },
        {
          label: t(($) => {
            return $.remoteNetworkGuide.value;
          }),
          value: t(($) => {
            return $.remoteNetworkGuide.createdToken;
          }),
        },
      ],
      actions: [],
      note: t(($) => {
        return $.remoteNetworkGuide.cf3d;
      }, values),
      href: "https://dash.cloudflare.com/",
      blockerTitle: t(($) => {
        return $.remoteNetworkGuide.cfBlockerTitle;
      }, values),
      blocker: [
        t(($) => {
          return $.remoteNetworkGuide.cfBlocker;
        }, values),
      ],
    },
    {
      title: t(($) => {
        return $.remoteNetworkGuide.cf4Title;
      }, values),
      actions: [
        t(($) => {
          return $.remoteNetworkGuide.cf4a;
        }, values),
        t(($) => {
          return $.remoteNetworkGuide.cf4b;
        }, values),
      ],
      note: t(($) => {
        return $.remoteNetworkGuide.cf4c;
      }, values),
    },
  ];
}
function useTailscaleStartSteps(values: {
  tags: string;
  tagNames: string;
  saveAction: string;
  clientId: string;
  clientSecret: string;
}): readonly GuideStep[] {
  const { t } = useTranslation();
  return [
    {
      title: t(($) => {
        return $.remoteNetworkGuide.ts2Title;
      }, values),
      description: t(($) => {
        return $.remoteNetworkGuide.ts2a;
      }, values),
      actions: [],
      href: "https://console.tailscale.com/admin/settings/trust-credentials",
      link: t(($) => {
        return $.remoteNetworkGuide.openTailscale;
      }, values),
      blockerTitle: t(($) => {
        return $.remoteNetworkGuide.tsBlockerTitle;
      }, values),
      blocker: [
        t(($) => {
          return $.remoteNetworkGuide.tsBlocker;
        }, values),
      ],
    },
  ];
}
function useTailscaleFinishSteps(values: {
  tags: string;
  tagNames: string;
  saveAction: string;
  clientId: string;
  clientSecret: string;
}): readonly GuideStep[] {
  const { t } = useTranslation();
  return [
    {
      title: t(($) => {
        return $.remoteNetworkGuide.ts3Title;
      }, values),
      description: t(($) => {
        return $.remoteNetworkGuide.ts3a;
      }, values),
      rows: [
        {
          label: t(($) => {
            return $.remoteNetworkGuide.authKeys;
          }),
          value: t(($) => {
            return $.remoteNetworkGuide.write;
          }),
          copyable: true,
        },
        {
          label: t(($) => {
            return $.remoteNetworkGuide.tags;
          }),
          value: values.tags,
          copyable: Boolean(values.tags),
        },
      ],
      actions: values.tags
        ? []
        : [
            t(($) => {
              return $.remoteNetworkGuide.missingTags;
            }, values),
          ],
      note: t(($) => {
        return $.remoteNetworkGuide.ts3c;
      }, values),
      blockerHref: "https://console.tailscale.com/admin/acls",
      blockerLink: t(($) => {
        return $.remoteNetworkGuide.openPolicy;
      }, values),
      blockerTitle: t(($) => {
        return $.remoteNetworkGuide.tsTagTitle;
      }, values),
      blocker: [
        t(($) => {
          return $.remoteNetworkGuide.tsTag1;
        }, values),
        t(($) => {
          return $.remoteNetworkGuide.tsTag2;
        }, values),
        t(($) => {
          return $.remoteNetworkGuide.tsTag3;
        }, values),
      ],
    },
    {
      title: t(($) => {
        return $.remoteNetworkGuide.ts4Title;
      }, values),
      actions: [
        t(($) => {
          return $.remoteNetworkGuide.ts4a;
        }, values),
        t(($) => {
          return $.remoteNetworkGuide.ts4b;
        }, values),
      ],
      note: t(($) => {
        return $.remoteNetworkGuide.ts4c;
      }, values),
    },
  ];
}
function GuideActions({ step }: { readonly step: GuideStep }) {
  const { t } = useTranslation();
  return (
    <div className="grid gap-5 text-sm leading-6">
      <header className="grid gap-2">
        <h3 className="text-lg font-semibold tracking-tight">{step.title}</h3>
        {step.description && (
          <p className="text-muted-foreground">{step.description}</p>
        )}
      </header>
      {step.href && step.link && (
        <a
          href={step.href}
          target="_blank"
          rel="noopener noreferrer"
          className={cn(
            buttonVariants({ variant: "outline" }),
            "h-auto min-h-9 w-fit whitespace-normal text-left",
          )}
        >
          {step.link}
          <ExternalLink size={14} aria-hidden />
        </a>
      )}
      {step.path && step.href && (
        <a
          href={step.href}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center justify-between gap-3 rounded-lg bg-gray-50 px-4 py-3 text-xs text-muted-foreground hover:bg-state-hover hover:text-foreground"
        >
          <span>{step.path}</span>
          <ExternalLink size={14} className="shrink-0" aria-hidden />
        </a>
      )}
      {step.rows && (
        <dl className="grid overflow-hidden rounded-xl bg-gray-50 divide-y divide-divider">
          {step.rows.map((row) => {
            return (
              <div
                key={row.label}
                className="grid grid-cols-2 items-center gap-3 px-4 py-3"
              >
                <dt className="text-xs text-muted-foreground">{row.label}</dt>
                <dd className="flex min-w-0 items-center justify-between gap-2">
                  <span className="min-w-0 break-words text-sm">
                    {row.value}
                  </span>
                  {row.copyable && (
                    <CopyButton
                      type="button"
                      text={row.value}
                      showTooltip={false}
                      aria-label={t(
                        ($) => {
                          return $.artifacts.jsonPreview.copyNode;
                        },
                        { label: row.label },
                      )}
                    />
                  )}
                </dd>
              </div>
            );
          })}
        </dl>
      )}
      {step.actions.map((action) => {
        return <p key={action}>{action}</p>;
      })}
      {step.note && (
        <p className="text-xs text-muted-foreground">{step.note}</p>
      )}
      {step.blocker && (
        <details className="group">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-md py-1 text-xs text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
            <ChevronRight
              size={14}
              className="shrink-0 transition-transform group-open:rotate-90"
              aria-hidden
            />
            {step.blockerTitle}
          </summary>
          <div className="mt-3 grid gap-3 text-sm text-muted-foreground">
            {step.blockerHref && (
              <a
                href={step.blockerHref}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex w-fit items-center gap-2 hover:text-foreground hover:underline"
              >
                {step.blockerLink}
                <ExternalLink size={14} aria-hidden />
              </a>
            )}
            <ol className="grid list-decimal gap-3 pl-5">
              {step.blocker.map((action) => {
                return <li key={action}>{action}</li>;
              })}
            </ol>
          </div>
        </details>
      )}
    </div>
  );
}
function GuideFooter({ step }: { readonly step: number }) {
  const { t } = useTranslation();
  const standalone = useGet(searchParams$).get("scope") === "private-network";
  const selectProvider = useSet(returnToRemoteNetworkProvider$);
  const move = useSet(moveRemoteNetworkGuide$);
  const close = useSet(closeRemoteNetworkGuide$);
  const lastStep = step === REMOTE_NETWORK_GUIDE_STEP_COUNT - 1;
  return (
    <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-divider px-4 py-4 sm:px-6">
      <Button
        type="button"
        variant="quiet"
        size="sm"
        onClick={() => {
          if (step > 0) {
            move(-1);
          } else if (standalone) {
            selectProvider();
          } else {
            close();
          }
        }}
      >
        {t(($) => {
          return step > 0
            ? $.remoteNetworkGuide.previous
            : standalone
              ? $.remoteNetworkGuide.returnToProvider
              : $.remoteNetworkGuide.returnToForm;
        })}
      </Button>
      <Button
        type="button"
        size="sm"
        onClick={() => {
          if (lastStep) {
            close(true);
          } else {
            move(1);
          }
        }}
      >
        {lastStep
          ? t(($) => {
              return $.remoteNetworkGuide.returnToForm;
            })
          : t(($) => {
              return $.remoteNetworkGuide.next;
            })}
        {!lastStep && <ArrowRight size={14} aria-hidden />}
      </Button>
    </footer>
  );
}
function GuideFirstStepSkip({ step }: { readonly step: number }) {
  const { t } = useTranslation();
  const standalone = useGet(searchParams$).get("scope") === "private-network";
  const close = useSet(closeRemoteNetworkGuide$);
  if (!standalone || step !== 0) {
    return null;
  }
  return (
    <Button
      type="button"
      variant="quiet"
      className="mt-5 h-auto justify-self-start px-0 text-sm"
      onClick={() => {
        close();
      }}
    >
      {t(($) => {
        return $.remoteNetworkGuide.existingCredentials;
      })}
    </Button>
  );
}
export function RemoteNetworkCredentialHelp({
  provider,
}: {
  readonly provider: NetworkGuideProvider;
}) {
  const { t } = useTranslation();
  const current = useGet(remoteNetworkGuide$);
  const open = useSet(openRemoteNetworkGuide$);
  const close = useSet(closeRemoteNetworkGuide$);
  const steps = useGuideSteps(provider, current?.tags ?? "");
  const index = current?.provider === provider ? current.step : 0;
  const step = steps[index];
  return (
    <>
      <div className="grid gap-2">
        <p className="text-sm text-muted-foreground">
          {t(($) => {
            return provider === "tailscale"
              ? $.remoteNetworkGuide.tailscaleCredentialSource
              : $.remoteNetworkGuide.cloudflareCredentialSource;
          })}
        </p>
        <Button
          type="button"
          variant="outline"
          className="h-auto min-h-9 justify-self-start whitespace-normal text-left"
          onClick={(event) => {
            const field = event.currentTarget
              .closest("form")
              ?.elements.namedItem("tailscaleTags");
            open(
              provider,
              field instanceof HTMLInputElement ? field.value.trim() : "",
            );
          }}
        >
          <CircleHelp size={14} aria-hidden />
          {t(($) => {
            return $.remoteNetworkGuide.open;
          })}
        </Button>
      </div>
      <Dialog
        open={current?.provider === provider && current.open}
        onOpenChange={(value) => {
          if (!value) {
            close();
          }
        }}
      >
        <DialogContent maxWidth="lg" contentClassName="flex flex-col gap-0 p-0">
          <div className="shrink-0 px-6 pt-6">
            <DialogHeader className="flex-row items-center justify-between space-y-0 gap-4 pr-10 text-left">
              <DialogTitle className="flex items-center gap-2 text-sm font-medium">
                {provider === "cloudflare" ? (
                  <Cloud size={18} className="shrink-0" aria-hidden />
                ) : (
                  <Network size={18} className="shrink-0" aria-hidden />
                )}
                <span className="sr-only">
                  {provider === "cloudflare"
                    ? t(($) => {
                        return $.remoteNetworkGuide.cloudflareTitle;
                      })
                    : t(($) => {
                        return $.remoteNetworkGuide.tailscaleTitle;
                      })}
                </span>
                <span aria-hidden>
                  {t(($) => {
                    return provider === "cloudflare"
                      ? $.cloudflareAccess.title
                      : $.tailscale.title;
                  })}
                </span>
              </DialogTitle>
              <DialogDescription
                className="shrink-0 text-xs tabular-nums"
                aria-live="polite"
              >
                {index + 1} / {REMOTE_NETWORK_GUIDE_STEP_COUNT}
              </DialogDescription>
            </DialogHeader>
            <ol className="mt-5 flex gap-1" aria-hidden>
              {steps.map((item, itemIndex) => {
                return (
                  <li
                    key={item.title}
                    className={cn(
                      "h-0.5 flex-1",
                      itemIndex === index
                        ? "bg-foreground"
                        : itemIndex < index
                          ? "bg-muted-foreground/50"
                          : "bg-divider",
                    )}
                  />
                );
              })}
            </ol>
          </div>
          <DialogBody className="min-h-0 flex-1 px-6 py-6">
            {step && <GuideActions step={step} />}
            <GuideFirstStepSkip step={index} />
          </DialogBody>
          <GuideFooter step={index} />
        </DialogContent>
      </Dialog>
    </>
  );
}
