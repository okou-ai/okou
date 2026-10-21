import { useGet, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import {
  ArrowRight,
  ChevronRight,
  ExternalLink,
  CircleHelp,
  X,
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
  DialogClose,
  IconButton,
} from "@okouai/ui";
import { cn } from "@okouai/ui/lib/utils";
import { searchParams$ } from "../../signals/route.ts";
import { REMOTE_PAGE_ACTION } from "./remote-editor-frame.tsx";
import {
  remoteNetworkGuide$,
  openRemoteNetworkGuide$,
  closeRemoteNetworkGuide$,
  moveRemoteNetworkGuide$,
  type NetworkGuideProvider,
} from "../../signals/remote-network-guide.ts";

export function useRemoteNetworkSaveLabel() {
  const { t } = useTranslation();
  return t(($) => {
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
      path: t(($) => {
        return $.remoteNetworkGuide.cf1c;
      }),
      href: "https://dash.cloudflare.com/",
      link: t(($) => {
        return $.remoteNetworkGuide.openCloudflare;
      }),
      actions: [
        t(($) => {
          return $.remoteNetworkGuide.cf2a;
        }, values),
        t(($) => {
          return $.remoteNetworkGuide.cf2b;
        }, values),
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
        t(($) => {
          return $.remoteNetworkGuide.cf4c;
        }, values),
      ],
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
        return $.remoteNetworkGuide.downloadTailscale;
      }),
      description: t(($) => {
        return $.remoteNetworkGuide.installTailscaleHelp;
      }),
      actions: [],
      href: "https://tailscale.com/download",
      link: t(($) => {
        return $.remoteNetworkGuide.downloadTailscale;
      }),
    },
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
        t(($) => {
          return $.remoteNetworkGuide.ts4c;
        }, values),
      ],
    },
  ];
}
function GuideDestination({ step }: { readonly step: GuideStep }) {
  if (!step.href || (!step.link && !step.path)) {
    return null;
  }
  return (
    <div className="grid gap-2">
      <a
        href={step.href}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex w-fit items-center gap-2 rounded-sm text-sm underline underline-offset-4 hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span>{step.link ?? step.path}</span>
        <ExternalLink size={14} className="shrink-0" aria-hidden />
      </a>
      {step.path && step.link && (
        <p className="text-xs leading-5 text-muted-foreground">{step.path}</p>
      )}
    </div>
  );
}
function GuideActions({ step }: { readonly step: GuideStep }) {
  const { t } = useTranslation();
  return (
    <div className="grid gap-5 text-sm leading-6">
      <GuideDestination step={step} />
      {step.description && <p>{step.description}</p>}
      {step.rows && (
        <dl className="grid gap-3">
          {step.rows.map((row) => {
            return (
              <div
                key={row.label}
                className="grid items-start gap-1 sm:grid-cols-2 sm:gap-3"
              >
                <dt className="text-sm text-muted-foreground">{row.label}</dt>
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
      {step.actions.length > 1 ? (
        <ol className="grid list-decimal gap-3 pl-5 marker:text-muted-foreground">
          {step.actions.map((action) => {
            return (
              <li key={action} className="pl-1">
                {action}
              </li>
            );
          })}
        </ol>
      ) : (
        step.actions.map((action) => {
          return <p key={action}>{action}</p>;
        })
      )}
      {step.note && (
        <p className="text-sm text-muted-foreground">{step.note}</p>
      )}
      {step.blocker && (
        <details className="group">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-md py-1 text-sm text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
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
            {step.blocker.length > 1 ? (
              <ol className="grid list-decimal gap-3 pl-5">
                {step.blocker.map((action) => {
                  return <li key={action}>{action}</li>;
                })}
              </ol>
            ) : (
              step.blocker.map((action) => {
                return <p key={action}>{action}</p>;
              })
            )}
          </div>
        </details>
      )}
    </div>
  );
}
function GuideFooter({
  step,
  count,
  provider,
}: {
  readonly step: number;
  readonly count: number;
  readonly provider: NetworkGuideProvider;
}) {
  const { t } = useTranslation();
  const move = useSet(moveRemoteNetworkGuide$);
  const close = useSet(closeRemoteNetworkGuide$);
  const lastStep = step === count - 1;
  return (
    <footer className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-divider px-6 py-4">
      {step > 0 ? (
        <Button
          type="button"
          variant="quiet"
          className="min-h-10 whitespace-normal text-left"
          onClick={() => {
            move(-1);
          }}
        >
          {t(($) => {
            return $.remoteNetworkGuide.previous;
          })}
        </Button>
      ) : (
        <GuideFirstStepSkip step={step} />
      )}
      <Button
        type="button"
        className={cn(REMOTE_PAGE_ACTION, "ml-auto whitespace-normal")}
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
              return provider === "tailscale" && step === 0
                ? $.remoteNetworkGuide.installedContinue
                : $.remoteNetworkGuide.next;
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
      className="h-auto min-h-10 whitespace-normal px-3 text-sm font-normal text-muted-foreground"
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
      <div className="mt-2 grid gap-1 border-t border-divider pt-5">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
          <h3 className="text-base font-semibold">
            {t(($) => {
              return $.remoteNetworkGuide.credentialsTitle;
            })}
          </h3>
          <Button
            type="button"
            variant="quiet"
            className="h-auto min-h-9 whitespace-normal px-3 text-sm font-normal text-muted-foreground"
            aria-label={t(($) => {
              return $.remoteNetworkGuide.open;
            })}
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
              return $.remoteNetworkGuide.helpLink;
            })}
          </Button>
        </div>
        <p className="text-sm leading-relaxed text-muted-foreground">
          {t(($) => {
            return provider === "tailscale"
              ? $.remoteNetworkGuide.tailscaleCredentialSource
              : $.remoteNetworkGuide.cloudflareCredentialSource;
          })}
        </p>
      </div>
      <Dialog
        open={current?.provider === provider && current.open}
        onOpenChange={(value) => {
          if (!value) {
            close();
          }
        }}
      >
        <DialogContent
          maxWidth="lg"
          contentClassName="flex flex-col gap-0 p-0"
          showCloseButton={false}
        >
          <DialogHeader className="space-y-0 px-6 pt-6 text-left">
            <div className="flex items-center justify-between gap-4">
              <DialogTitle
                className="min-w-0 flex-1 text-xl font-semibold leading-7"
                aria-live="polite"
              >
                {step?.title}
              </DialogTitle>
              <span
                className="shrink-0 text-xs leading-5 tabular-nums text-muted-foreground"
                aria-live="polite"
              >
                {index + 1} / {steps.length}
              </span>
              <DialogClose
                render={
                  <IconButton
                    aria-label={t(($) => {
                      return $.workflows.common.close;
                    })}
                    className="shrink-0 text-muted-foreground hover:text-foreground"
                  />
                }
              >
                <X size={18} aria-hidden />
              </DialogClose>
            </div>
            <DialogDescription className="sr-only">
              {t(($) => {
                return provider === "cloudflare"
                  ? $.remoteNetworkGuide.cloudflareTitle
                  : $.remoteNetworkGuide.tailscaleTitle;
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="min-h-0 flex-1 px-6 pb-6 pt-5">
            {step && <GuideActions step={step} />}
          </DialogBody>
          <GuideFooter step={index} count={steps.length} provider={provider} />
        </DialogContent>
      </Dialog>
    </>
  );
}
