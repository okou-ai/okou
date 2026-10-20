import { useGet, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { ExternalLink, CircleHelp } from "lucide-react";
import {
  Button,
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
  type NetworkGuideProvider,
} from "../../signals/remote-network-guide.ts";

export function useRemoteNetworkSaveLabel() {
  const { t } = useTranslation();
  const setup = useGet(remoteSetup$);
  return setup?.step === "oauth" || setup?.step === "cf-access"
    ? t(($) => {
        return $.remoteNetworkGuide.saveContinue;
      })
    : t(($) => {
        return $.remoteNetworkGuide.saveNetwork;
      });
}
interface GuideStep {
  readonly title: string;
  readonly actions: readonly string[];
  readonly href?: string;
  readonly link?: string;
  readonly rows?: readonly { readonly label: string; readonly value: string }[];
  readonly blockerTitle?: string;
  readonly blocker?: readonly string[];
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
        return $.remoteNetworkGuide.cf1Title;
      }, values),
      actions: [
        t(($) => {
          return $.remoteNetworkGuide.cf1a;
        }, values),
        t(($) => {
          return $.remoteNetworkGuide.cf1b;
        }, values),
        t(($) => {
          return $.remoteNetworkGuide.cf1c;
        }, values),
      ],
      href: "https://dash.cloudflare.com/",
      link: t(($) => {
        return $.remoteNetworkGuide.openCloudflare;
      }, values),
    },
    {
      title: t(($) => {
        return $.remoteNetworkGuide.cf2Title;
      }, values),
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
      actions: [
        t(($) => {
          return $.remoteNetworkGuide.cf3a;
        }, values),
        t(($) => {
          return $.remoteNetworkGuide.cf3b;
        }, values),
        t(($) => {
          return $.remoteNetworkGuide.cf3c;
        }, values),
        t(($) => {
          return $.remoteNetworkGuide.cf3d;
        }, values),
      ],
      href: "https://dash.cloudflare.com/",
      link: t(($) => {
        return $.remoteNetworkGuide.openCloudflare;
      }, values),
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
      rows: [
        {
          label: t(($) => {
            return $.remoteNetworkGuide.clientId;
          }),
          value: values.clientId,
        },
        {
          label: t(($) => {
            return $.remoteNetworkGuide.clientSecret;
          }),
          value: values.clientSecret,
        },
      ],
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
        return $.remoteNetworkGuide.ts1Title;
      }, values),
      actions: [
        t(($) => {
          return $.remoteNetworkGuide.ts1a;
        }, values),
        t(($) => {
          return $.remoteNetworkGuide.ts1b;
        }, values),
        t(($) => {
          return $.remoteNetworkGuide.ts1c;
        }, values),
      ],
      href: "https://console.tailscale.com/admin/settings/trust-credentials",
      link: t(($) => {
        return $.remoteNetworkGuide.openTailscale;
      }, values),
    },
    {
      title: t(($) => {
        return $.remoteNetworkGuide.ts2Title;
      }, values),
      actions: [
        t(($) => {
          return $.remoteNetworkGuide.ts2a;
        }, values),
        t(($) => {
          return $.remoteNetworkGuide.ts2b;
        }, values),
      ],
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
      rows: [
        {
          label: t(($) => {
            return $.remoteNetworkGuide.authKeys;
          }),
          value: t(($) => {
            return $.remoteNetworkGuide.write;
          }),
        },
        {
          label: t(($) => {
            return $.remoteNetworkGuide.tags;
          }),
          value: values.tags,
        },
      ],
      actions: [
        t(($) => {
          return $.remoteNetworkGuide.ts3a;
        }, values),
        values.tags
          ? t(($) => {
              return $.remoteNetworkGuide.ts3b;
            }, values)
          : t(($) => {
              return $.remoteNetworkGuide.missingTags;
            }, values),
        t(($) => {
          return $.remoteNetworkGuide.ts3c;
        }, values),
      ],
      href: "https://console.tailscale.com/admin/acls",
      link: t(($) => {
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
      rows: [
        {
          label: t(($) => {
            return $.remoteNetworkGuide.clientId;
          }),
          value: values.clientId,
        },
        {
          label: t(($) => {
            return $.remoteNetworkGuide.tailscaleSecret;
          }),
          value: values.clientSecret,
        },
      ],
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
function GuideActions({ step }: { readonly step: GuideStep }) {
  return (
    <div className="grid gap-5 text-sm leading-6">
      <h3 className="text-lg font-semibold">{step.title}</h3>
      {step.href && (
        <a
          href={step.href}
          target="_blank"
          rel="noopener noreferrer"
          className={cn(
            buttonVariants({ variant: "outline" }),
            "h-auto w-fit whitespace-normal text-left",
          )}
        >
          {step.link}
          <ExternalLink size={14} aria-hidden />
        </a>
      )}
      <ol className="grid gap-4">
        {step.actions.map((action, index) => {
          return (
            <li key={action} className="flex items-start gap-4">
              <span className="shrink-0 text-xs text-muted-foreground">
                {index + 1}
              </span>
              <span>{action}</span>
            </li>
          );
        })}
      </ol>
      {step.rows && (
        <dl className="grid overflow-hidden rounded-lg border border-divider bg-gray-50 divide-y divide-divider">
          {step.rows.map((row) => {
            return (
              <div key={row.label} className="grid grid-cols-2 gap-3 px-4 py-3">
                <dt className="text-xs text-muted-foreground">{row.label}</dt>
                <dd className="break-words text-sm">{row.value}</dd>
              </div>
            );
          })}
        </dl>
      )}
      {step.blocker && (
        <details>
          <summary className="cursor-pointer text-muted-foreground">
            {step.blockerTitle}
          </summary>
          <ol className="mt-3 grid list-decimal gap-3 pl-5">
            {step.blocker.map((action) => {
              return <li key={action}>{action}</li>;
            })}
          </ol>
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
  return (
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-divider pt-4">
      <div className="flex flex-wrap gap-2">
        {standalone && step === 0 && (
          <Button type="button" variant="quiet" onClick={selectProvider}>
            {t(($) => {
              return $.remoteNetworkGuide.returnToProvider;
            })}
          </Button>
        )}
        {step > 0 && (
          <Button
            type="button"
            variant="quiet"
            onClick={() => {
              move(-1);
            }}
          >
            {t(($) => {
              return $.remoteNetworkGuide.previous;
            })}
          </Button>
        )}
        {step < 3 && !(standalone && step === 0) && (
          <Button
            type="button"
            variant="quiet"
            onClick={() => {
              close();
            }}
          >
            {t(($) => {
              return standalone && step === 0
                ? $.remoteNetworkGuide.existingCredentials
                : $.remoteNetworkGuide.returnToForm;
            })}
          </Button>
        )}
      </div>
      <Button
        type="button"
        onClick={() => {
          if (step === 3) {
            close(true);
          } else {
            move(1);
          }
        }}
      >
        {step === 3
          ? t(($) => {
              return $.remoteNetworkGuide.returnToForm;
            })
          : t(($) => {
              return $.remoteNetworkGuide.next;
            })}
      </Button>
    </div>
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
      <Button
        type="button"
        variant="quiet"
        className="h-auto justify-self-start px-0 text-xs text-muted-foreground hover:text-foreground"
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
      <Dialog
        open={current?.provider === provider && current.open}
        onOpenChange={(value) => {
          if (!value) {
            close();
          }
        }}
      >
        <DialogContent maxWidth={640} contentClassName="flex flex-col">
          <DialogHeader>
            <DialogTitle>
              {provider === "cloudflare"
                ? t(($) => {
                    return $.remoteNetworkGuide.cloudflareTitle;
                  })
                : t(($) => {
                    return $.remoteNetworkGuide.tailscaleTitle;
                  })}
            </DialogTitle>
            <DialogDescription>{index + 1} / 4</DialogDescription>
          </DialogHeader>
          <DialogBody className="min-h-0 overflow-y-auto py-3">
            {step && <GuideActions step={step} />}
            <GuideFirstStepSkip step={index} />
          </DialogBody>
          <GuideFooter step={index} />
        </DialogContent>
      </Dialog>
    </>
  );
}
