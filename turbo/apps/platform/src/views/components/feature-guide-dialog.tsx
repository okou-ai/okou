import { useGet, useLastLoadable, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, ArrowRight, ArrowUpRight, Sparkles } from "lucide-react";
import { Button } from "@okouai/ui/components/ui/button";
import { IconButton } from "@okouai/ui/components/ui/icon-button";
import { cn } from "@okouai/ui/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@okouai/ui/components/ui/dialog";
import type { FeatureGuideMedia } from "@okouai/api-contracts/contracts/feature-guides";
import { authenticatedSessionKey$ } from "../../signals/auth.ts";
import { rootSignal$ } from "../../signals/root-signal.ts";
import {
  closeFeatureGuide$,
  dismissFeatureGuide$,
  dismissedFeatureGuide$,
  featureGuide$,
  featureGuideReady$,
  type FeatureGuideSnapshot,
  persistFeatureGuideSeen$,
  tryFeatureGuidePrompt$,
} from "../../signals/feature-guides.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { ROUTES } from "../../signals/route-paths.ts";
import { Link } from "../router/link.tsx";
import { shouldHandleLinkClick } from "../router/link-click.ts";
import { FeatureGuideConversationPreview } from "./feature-guide-conversation.tsx";

const FEATURE_GUIDE_ACTION_ROUTES = {
  "connect-discord": ROUTES.settingsDiscord,
  "open-artifacts": ROUTES.artifacts,
  "open-chats": ROUTES.home,
} as const;

function GuideMedia({
  media,
  selection,
}: {
  readonly media: FeatureGuideMedia;
  readonly selection: FeatureGuideSnapshot["selection"];
}) {
  const { t } = useTranslation();
  const stepIndex = useGet(selection.stepIndex$);
  const selectStep = useSet(selection.selectStep$);
  if (media.type === "image") {
    return (
      <img
        src={media.url}
        alt={media.alt}
        className="aspect-video w-full rounded-xl bg-gray-50 object-contain"
      />
    );
  }
  if (media.type === "video") {
    return (
      <video
        controls
        playsInline
        preload="none"
        poster={media.posterUrl}
        className="aspect-video w-full rounded-xl bg-gray-50"
      >
        <source src={media.url} type="video/mp4" />
        <track kind="captions" src={media.captionsUrl} srcLang="en" default />
      </video>
    );
  }
  const step = media.steps[stepIndex];
  if (!step) {
    throw new Error("Feature guide step is outside the current walkthrough");
  }
  return (
    <div
      className={cn(
        "flex flex-col gap-4",
        !step.conversation && "rounded-xl bg-gray-50 p-4 sm:p-5",
      )}
    >
      {step.conversation && (
        <FeatureGuideConversationPreview conversation={step.conversation} />
      )}
      {step.imageUrl && (
        <img
          src={step.imageUrl}
          alt={step.title}
          loading="lazy"
          className="max-h-48 w-full rounded-lg object-contain"
        />
      )}
      <div className="flex flex-col gap-2" aria-live="polite">
        <p className="text-lg font-medium">{step.title}</p>
        <p className="text-sm leading-relaxed text-muted-foreground">
          {step.description}
        </p>
      </div>
      <div className="flex items-center justify-between gap-3">
        <Button
          variant="quiet"
          size="sm"
          disabled={stepIndex === 0}
          onClick={() => {
            return selectStep(stepIndex - 1);
          }}
        >
          <ArrowLeft />
          <span className="sr-only sm:not-sr-only">
            {t(($) => {
              return $.featureGuide.previous;
            })}
          </span>
        </Button>
        <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">
          {stepIndex + 1} / {media.steps.length}
        </span>
        <Button
          variant="quiet"
          size="sm"
          disabled={stepIndex >= media.steps.length - 1}
          onClick={() => {
            return selectStep(stepIndex + 1);
          }}
        >
          <span className="sr-only sm:not-sr-only">
            {t(($) => {
              return $.featureGuide.next;
            })}
          </span>
          <ArrowRight />
        </Button>
      </div>
    </div>
  );
}

function FeatureGuideNavigation({
  snapshot,
}: {
  readonly snapshot: FeatureGuideSnapshot;
}) {
  const { t } = useTranslation();
  const itemIndex = useGet(snapshot.selection.itemIndex$);
  const selectItem = useSet(snapshot.selection.selectItem$);
  const items = snapshot.edition.content.items;
  if (items.length < 2) {
    return null;
  }
  return (
    <DialogFooter
      role="group"
      aria-label={t(($) => {
        return $.featureGuide.navigation;
      })}
      className="flex-row items-center justify-between gap-2 border-t border-border pt-3 sm:justify-between"
    >
      <IconButton
        aria-label={t(($) => {
          return $.featureGuide.previousFeature;
        })}
        className="size-8 shrink-0 text-muted-foreground hover:text-foreground"
        onClick={() => {
          return selectItem((itemIndex + items.length - 1) % items.length);
        }}
      >
        <ArrowLeft size={16} aria-hidden="true" />
      </IconButton>
      <div className="flex min-w-0 items-center gap-0.5">
        {items.map((item, index) => {
          return (
            <IconButton
              key={item.featureId}
              aria-label={item.title}
              aria-current={index === itemIndex ? "step" : undefined}
              className="size-6 rounded-full"
              onClick={() => {
                return selectItem(index);
              }}
            >
              <span
                aria-hidden="true"
                className={cn(
                  "h-1.5 rounded-full",
                  index === itemIndex
                    ? "w-4 bg-foreground"
                    : "w-1.5 bg-gray-300",
                )}
              />
            </IconButton>
          );
        })}
      </div>
      <IconButton
        aria-label={t(($) => {
          return $.featureGuide.nextFeature;
        })}
        className="size-8 shrink-0 text-muted-foreground hover:text-foreground"
        onClick={() => {
          return selectItem((itemIndex + 1) % items.length);
        }}
      >
        <ArrowRight size={16} aria-hidden="true" />
      </IconButton>
    </DialogFooter>
  );
}

function GuideContents({
  snapshot,
  onClose,
  onTry,
}: {
  readonly snapshot: FeatureGuideSnapshot;
  readonly onClose: () => void;
  readonly onTry: (prompt: string) => void;
}) {
  const { t } = useTranslation();
  const itemIndex = useGet(snapshot.selection.itemIndex$);
  const { edition } = snapshot;
  const activeItem = edition.content.items[itemIndex];
  if (!activeItem) {
    throw new Error("Feature guide item is outside the current edition");
  }
  const prompt = activeItem.prompt;
  return (
    <>
      <div className="flex items-center gap-2 text-xs font-medium text-brand-text">
        <Sparkles size={14} aria-hidden="true" />
        {t(($) => {
          return $.featureGuide.label;
        })}
        {snapshot.preview && (
          <span className="text-muted-foreground">
            {t(($) => {
              return $.featureGuide.preview;
            })}
          </span>
        )}
      </div>
      <div aria-live="polite">
        <DialogHeader className="text-left">
          <DialogTitle className="pr-7 text-2xl leading-snug sm:text-3xl">
            {activeItem.title}
          </DialogTitle>
          <DialogDescription>{activeItem.description}</DialogDescription>
        </DialogHeader>
      </div>
      {activeItem.media && (
        <GuideMedia
          key={activeItem.featureId}
          media={activeItem.media}
          selection={snapshot.selection}
        />
      )}
      {activeItem.action ? (
        <Link
          pathname={FEATURE_GUIDE_ACTION_ROUTES[activeItem.action.type]}
          options={
            snapshot.preview
              ? {
                  searchParams: new URLSearchParams({
                    featureGuidePreview: "1",
                  }),
                }
              : undefined
          }
          className="inline-flex min-h-8 w-fit items-center gap-1 text-sm text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline"
          onClick={(event) => {
            if (shouldHandleLinkClick(event)) {
              onClose();
            }
          }}
        >
          {activeItem.action.label}
          <ArrowUpRight size={14} aria-hidden="true" />
        </Link>
      ) : prompt ? (
        <Button
          variant="link"
          className="h-auto w-fit px-0 py-1 text-muted-foreground hover:text-foreground"
          onClick={() => {
            return onTry(prompt);
          }}
        >
          {t(($) => {
            return $.featureGuide.tryPrompt;
          })}
          <ArrowUpRight aria-hidden="true" />
        </Button>
      ) : null}
      <FeatureGuideNavigation snapshot={snapshot} />
    </>
  );
}

export function FeatureGuideDialog() {
  const { t } = useTranslation();
  const loadable = useLastLoadable(featureGuide$);
  const owner = useGet(authenticatedSessionKey$);
  const dismissed = useGet(dismissedFeatureGuide$);
  const ready = useGet(featureGuideReady$);
  const signal = useGet(rootSignal$);
  const closeGuide = useSet(closeFeatureGuide$);
  const dismissGuide = useSet(dismissFeatureGuide$);
  const persistSeen = useSet(persistFeatureGuideSeen$);
  const tryPrompt = useSet(tryFeatureGuidePrompt$);
  const snapshot =
    loadable.state === "hasData" && loadable.data?.owner === owner
      ? loadable.data
      : null;
  const alreadyDismissed =
    snapshot &&
    dismissed?.owner === owner &&
    dismissed.editionId === snapshot.edition.id &&
    dismissed.preview === snapshot.preview;
  const open = Boolean(snapshot && ready && !alreadyDismissed);
  const close = () => {
    if (!snapshot) {
      return;
    }
    detach(dismissGuide(snapshot, signal), Reason.DomCallback);
  };
  const onTry = (prompt: string) => {
    if (!snapshot) {
      return;
    }
    detach(tryPrompt(snapshot, prompt, signal), Reason.DomCallback);
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          close();
        }
      }}
      onOpenChangeComplete={(next) => {
        if (next && snapshot) {
          detach(persistSeen(snapshot, signal), Reason.DomCallback);
        }
        if (!next && snapshot) {
          closeGuide(snapshot);
        }
      }}
    >
      <DialogContent
        maxWidth="2xl"
        contentClassName="auto-rows-max grid-cols-1"
        closeLabel={t(($) => {
          return $.featureGuide.close;
        })}
      >
        {snapshot && (
          <GuideContents snapshot={snapshot} onClose={close} onTry={onTry} />
        )}
      </DialogContent>
    </Dialog>
  );
}
