import { useGet, useLastLoadable, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, ArrowRight, Sparkles } from "lucide-react";
import { Button } from "@okouai/ui/components/ui/button";
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
  dismissedFeatureGuide$,
  featureGuide$,
  featureGuideReady$,
  type FeatureGuideSnapshot,
  featureGuideItemIndex$,
  featureGuideStepIndex$,
  persistFeatureGuideSeen$,
  selectFeatureGuideItem$,
  selectFeatureGuideStep$,
  tryFeatureGuidePrompt$,
} from "../../signals/feature-guides.ts";
import { detach, Reason } from "../../signals/utils.ts";

function GuideMedia({ media }: { readonly media: FeatureGuideMedia }) {
  const { t } = useTranslation();
  const stepIndex = useGet(featureGuideStepIndex$);
  const selectStep = useSet(selectFeatureGuideStep$);
  if (media.type === "image") {
    return (
      <img
        src={media.url}
        alt={media.alt}
        loading="lazy"
        className="max-h-64 w-full rounded-xl object-contain"
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
        className="max-h-64 w-full rounded-xl"
      >
        <source src={media.url} type="video/mp4" />
        <track kind="captions" src={media.captionsUrl} srcLang="en" default />
      </video>
    );
  }
  const step = media.steps[stepIndex] ?? media.steps[0];
  if (!step) {
    return null;
  }
  return (
    <div className="flex flex-col gap-3 rounded-xl bg-gray-50 p-4">
      {step.imageUrl && (
        <img
          src={step.imageUrl}
          alt={step.title}
          loading="lazy"
          className="max-h-48 w-full rounded-lg object-contain"
        />
      )}
      <p className="text-sm font-medium">{step.title}</p>
      <p className="text-sm text-muted-foreground">{step.description}</p>
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
          {t(($) => {
            return $.featureGuide.previous;
          })}
        </Button>
        <span className="text-xs text-muted-foreground">
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
          {t(($) => {
            return $.featureGuide.next;
          })}
          <ArrowRight />
        </Button>
      </div>
    </div>
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
  const itemIndex = useGet(featureGuideItemIndex$);
  const selectItem = useSet(selectFeatureGuideItem$);
  const { edition } = snapshot;
  const activeIndex = edition.content.items[itemIndex] ? itemIndex : 0;
  const activeItem = edition.content.items[activeIndex];
  const prompt = activeItem?.prompt;
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
      <DialogHeader>
        <DialogTitle className="pr-7 text-2xl leading-snug sm:text-3xl">
          {edition.content.title}
        </DialogTitle>
        <DialogDescription>{edition.content.description}</DialogDescription>
      </DialogHeader>
      <div className="grid gap-2 sm:grid-cols-3">
        {edition.content.items.map((item, index) => {
          return (
            <Button
              key={item.featureId}
              variant="neutral"
              className="h-auto min-h-20 flex-col items-start justify-start gap-1 whitespace-normal rounded-xl p-3 text-left"
              aria-pressed={index === activeIndex}
              onClick={() => {
                return selectItem(index);
              }}
            >
              <span className="text-sm font-medium">{item.title}</span>
              <span className="text-xs font-normal text-muted-foreground">
                {item.description}
              </span>
            </Button>
          );
        })}
      </div>
      {activeItem?.media && (
        <GuideMedia key={activeItem.featureId} media={activeItem.media} />
      )}
      <DialogFooter>
        <Button variant="quiet" onClick={onClose}>
          {t(($) => {
            return $.featureGuide.dismiss;
          })}
        </Button>
        {prompt && (
          <Button
            onClick={() => {
              return onTry(prompt);
            }}
          >
            {t(($) => {
              return $.featureGuide.tryPrompt;
            })}
            <ArrowRight />
          </Button>
        )}
      </DialogFooter>
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
    closeGuide(snapshot);
    // The App owns acknowledgements so quick dismissal does not abort them.
    detach(persistSeen(snapshot, signal), Reason.DomCallback);
  };
  const onTry = (prompt: string) => {
    if (!snapshot) {
      return;
    }
    tryPrompt(snapshot, prompt);
    detach(persistSeen(snapshot, signal), Reason.DomCallback);
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
