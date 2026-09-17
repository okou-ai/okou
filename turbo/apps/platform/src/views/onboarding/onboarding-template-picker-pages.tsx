import type { SyntheticEvent } from "react";
import { useGet, useSet } from "ccstate-react";
import { ChevronLeft, ChevronRight, CircleCheckBig, Eye } from "lucide-react";
import type { IllustrationTemplateItem } from "@okouai/core/illustration-template-items";
import type { PresentationTemplateItem } from "@okouai/core/presentation-template-items";
import { r2ImageTransformUrl } from "@okouai/core/r2-image-transform";
import type { VideoTemplateItem } from "@okouai/core/video-template-items";
import { Button, cn } from "@okouai/ui";
import { useTranslation } from "react-i18next";
import {
  onboardingDraft$,
  onboardingUi$,
  setOnboardingImageVariant$,
  updateOnboardingDraft$,
  updateOnboardingUi$,
} from "../../signals/onboarding/onboarding-state.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { ROUTES } from "../../signals/route-paths.ts";
import { useOnboardingNavigation } from "./onboarding-navigation.ts";
import {
  OnboardingDialog,
  OnboardingFooter,
  OnboardingShell,
} from "./onboarding-shell.tsx";
import {
  localizedIllustrationTemplates,
  localizedPresentationTemplates,
  localizedVideoTemplates,
} from "./onboarding-template-localization.ts";
import { IconTooltipButton } from "../components/icon-tooltip.tsx";

function SelectionCheck({ selected }: { readonly selected: boolean }) {
  return selected ? (
    <CircleCheckBig
      size={18}
      className="shrink-0 text-brand-text"
      aria-hidden="true"
    />
  ) : null;
}

function PresentationPreview({
  template,
  activeSlide,
  onSlideChange,
  onClose,
  onSelect,
}: {
  readonly template: PresentationTemplateItem;
  readonly activeSlide: number;
  readonly onSlideChange: (index: number) => void;
  readonly onClose: () => void;
  readonly onSelect: () => void;
}) {
  const { t } = useTranslation();
  const slideCount = template.previewImages.length;
  const activeImage = template.previewImages[activeSlide];
  const move = (offset: number): void => {
    onSlideChange((activeSlide + offset + slideCount) % slideCount);
  };

  return (
    <OnboardingDialog
      title={template.title}
      onClose={onClose}
      footer={
        <>
          <Button type="button" variant="outline" onClick={onClose}>
            {t(($) => {
              return $.onboarding.common.gotIt;
            })}
          </Button>
          <Button type="button" onClick={onSelect}>
            {t(($) => {
              return $.onboarding.common.selectThisTemplate;
            })}
          </Button>
        </>
      }
    >
      <div className="relative flex aspect-video items-center justify-center overflow-hidden rounded-lg bg-muted/40">
        {activeImage ? (
          <img
            src={r2ImageTransformUrl(activeImage, { width: 1200 })}
            alt={t(
              ($) => {
                return $.onboarding.templatePicker.presentation.slideAlt;
              },
              { slide: activeSlide + 1, title: template.title },
            )}
            className="h-full w-full object-contain"
          />
        ) : null}
        <IconTooltipButton
          type="button"
          className="absolute left-3 inline-flex h-9 w-9 items-center justify-center rounded-full border border-border bg-background/90 shadow-sm"
          aria-label={t(($) => {
            return $.onboarding.templatePicker.presentation.previousSlide;
          })}
          onClick={() => {
            move(-1);
          }}
        >
          <ChevronLeft size={20} aria-hidden="true" />
        </IconTooltipButton>
        <IconTooltipButton
          type="button"
          className="absolute right-3 inline-flex h-9 w-9 items-center justify-center rounded-full border border-border bg-background/90 shadow-sm"
          aria-label={t(($) => {
            return $.onboarding.templatePicker.presentation.nextSlide;
          })}
          onClick={() => {
            move(1);
          }}
        >
          <ChevronRight size={20} aria-hidden="true" />
        </IconTooltipButton>
      </div>
      <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
        {template.previewImages.map((image, index) => {
          return (
            <button
              key={image}
              type="button"
              className={cn(
                "relative h-14 w-24 shrink-0 overflow-hidden rounded-md border bg-muted",
                index === activeSlide ? "border-primary" : "border-border",
              )}
              aria-label={t(
                ($) => {
                  return $.onboarding.templatePicker.presentation.showSlide;
                },
                { slide: index + 1 },
              )}
              aria-current={index === activeSlide ? "true" : undefined}
              onClick={() => {
                onSlideChange(index);
              }}
            >
              <img
                src={r2ImageTransformUrl(image, { width: 128 })}
                alt=""
                className="h-full w-full object-cover"
              />
              <span className="absolute bottom-0.5 right-1 text-[10px] font-medium text-white [text-shadow:0_1px_2px_rgb(0_0_0/0.8)]">
                {index + 1}
              </span>
            </button>
          );
        })}
      </div>
    </OnboardingDialog>
  );
}

function PresentationTemplateCard({
  template,
  selected,
  onSelect,
  onPreview,
}: {
  readonly template: PresentationTemplateItem;
  readonly selected: boolean;
  readonly onSelect: () => void;
  readonly onPreview: () => void;
}) {
  const { t } = useTranslation();
  const imageUrl = template.previewImages[0] ?? template.previewImage;
  return (
    <article
      className={cn(
        "group relative overflow-hidden rounded-xl border bg-background shadow-[var(--okou-card-shadow)] transition-colors hover:border-primary",
        selected && "border-primary",
      )}
    >
      <button
        type="button"
        className="absolute inset-0 z-10 rounded-xl"
        aria-label={t(
          ($) => {
            return $.onboarding.templatePicker.presentation.selectTemplate;
          },
          { title: template.title },
        )}
        aria-pressed={selected}
        onClick={onSelect}
      />
      <div className="aspect-video overflow-hidden bg-muted">
        <img
          src={r2ImageTransformUrl(imageUrl, { width: 430 })}
          alt=""
          loading="lazy"
          className="h-full w-full object-contain"
        />
      </div>
      <IconTooltipButton
        type="button"
        className="absolute right-1.5 top-1.5 z-20 inline-flex h-[26px] w-[26px] items-center justify-center rounded-md border border-border bg-background opacity-0 shadow-sm group-hover:opacity-100 group-focus-within:opacity-100"
        aria-label={t(
          ($) => {
            return $.onboarding.templatePicker.presentation.viewTemplate;
          },
          { title: template.title },
        )}
        onClick={onPreview}
      >
        <Eye size={13} aria-hidden="true" />
      </IconTooltipButton>
      <div className="flex min-w-0 items-center justify-between gap-2 px-2.5 py-[9px]">
        <span className="truncate text-[11px] font-semibold leading-4">
          {template.title}
        </span>
        <SelectionCheck selected={selected} />
      </div>
    </article>
  );
}

export function OnboardingPresentationTemplatePage() {
  const { t } = useTranslation();
  const draft = useGet(onboardingDraft$);
  const ui = useGet(onboardingUi$);
  const setDraft = useSet(updateOnboardingDraft$);
  const setUi = useSet(updateOnboardingUi$);
  const { navigateTo } = useOnboardingNavigation();
  const templates = localizedPresentationTemplates(t);
  const previewTemplate = templates.find((template) => {
    return template.slug === ui.presentationPreviewSlug;
  });
  const selectedSlug = draft.presentationTemplateSlug ?? "";

  const continueToRun = (): void => {
    if (!selectedSlug) {
      return;
    }
    setDraft({ presentationTemplateSlug: selectedSlug });
    navigateTo(ROUTES.onboardingPresentationRun, {
      updates: { template: selectedSlug },
      remove: ["category", "workflow"],
    });
  };

  return (
    <>
      <OnboardingShell
        currentStep={2}
        totalSteps={3}
        title={t(($) => {
          return $.onboarding.templatePicker.presentation.title;
        })}
        description={t(($) => {
          return $.onboarding.templatePicker.presentation.description;
        })}
        footer={
          <OnboardingFooter
            onBack={() => {
              navigateTo(ROUTES.onboarding);
            }}
            onPrimary={continueToRun}
            primaryLabel={t(($) => {
              return $.onboarding.common.continue;
            })}
            primaryDisabled={!selectedSlug}
          />
        }
      >
        <div className="mt-4 grid grid-cols-3 gap-3">
          {templates.map((template) => {
            return (
              <PresentationTemplateCard
                key={template.slug}
                template={template}
                selected={template.slug === selectedSlug}
                onSelect={() => {
                  setDraft({ presentationTemplateSlug: template.slug });
                }}
                onPreview={() => {
                  setUi({
                    presentationPreviewSlug: template.slug,
                    presentationSlideIndex: 0,
                  });
                }}
              />
            );
          })}
        </div>
      </OnboardingShell>
      {previewTemplate ? (
        <PresentationPreview
          template={previewTemplate}
          activeSlide={ui.presentationSlideIndex}
          onSlideChange={(presentationSlideIndex) => {
            setUi({ presentationSlideIndex });
          }}
          onClose={() => {
            setUi({ presentationPreviewSlug: null });
          }}
          onSelect={() => {
            setDraft({ presentationTemplateSlug: previewTemplate.slug });
            setUi({ presentationPreviewSlug: null });
          }}
        />
      ) : null}
    </>
  );
}

function IllustrationTemplateCard({
  template,
  selected,
  variantIndex,
  onSelect,
  onVariantChange,
}: {
  readonly template: IllustrationTemplateItem;
  readonly selected: boolean;
  readonly variantIndex: number;
  readonly onSelect: () => void;
  readonly onVariantChange: (index: number) => void;
}) {
  const { t } = useTranslation();
  const activeImage =
    template.previewImages[variantIndex] ?? template.previewImage;
  return (
    <article
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      aria-label={t(
        ($) => {
          return $.onboarding.templatePicker.image.selectTemplate;
        },
        { title: template.title },
      )}
      className={cn(
        "mb-3 inline-block w-full break-inside-avoid overflow-hidden rounded-xl border bg-background shadow-[var(--okou-card-shadow)] transition-colors hover:border-primary",
        selected && "border-primary",
      )}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
    >
      <div
        className="w-full overflow-hidden bg-muted"
        style={{ aspectRatio: `${template.width} / ${template.height}` }}
      >
        <img
          src={r2ImageTransformUrl(activeImage, { width: 430 })}
          alt=""
          loading="lazy"
          className="h-full w-full object-cover"
        />
      </div>
      <div className="flex gap-1.5 overflow-x-auto px-2.5 pt-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {template.previewImages.map((image, index) => {
          return (
            <button
              key={image}
              type="button"
              className={cn(
                "h-[38px] w-[38px] shrink-0 overflow-hidden rounded-lg border p-px",
                index === variantIndex
                  ? "border-primary/70"
                  : "border-transparent",
              )}
              aria-label={t(
                ($) => {
                  return $.onboarding.templatePicker.image.showVariant;
                },
                { title: template.title, variant: index + 1 },
              )}
              aria-pressed={index === variantIndex}
              onClick={(event) => {
                event.stopPropagation();
                onVariantChange(index);
              }}
            >
              <img
                src={r2ImageTransformUrl(image, { width: 76 })}
                alt=""
                loading="lazy"
                className="h-full w-full rounded-md object-cover"
              />
            </button>
          );
        })}
      </div>
      <div className="flex min-w-0 items-center justify-between gap-2 px-2.5 py-[9px]">
        <span className="truncate text-[11px] font-semibold leading-4">
          {template.title}
        </span>
        <SelectionCheck selected={selected} />
      </div>
    </article>
  );
}

export function OnboardingImageTemplatePage() {
  const { t } = useTranslation();
  const draft = useGet(onboardingDraft$);
  const ui = useGet(onboardingUi$);
  const setDraft = useSet(updateOnboardingDraft$);
  const setImageVariant = useSet(setOnboardingImageVariant$);
  const { navigateTo } = useOnboardingNavigation();
  const templates = localizedIllustrationTemplates(t);
  const selectedSlug = draft.imageTemplateSlug ?? "";

  const continueToRun = (): void => {
    if (!selectedSlug) {
      return;
    }
    setDraft({ imageTemplateSlug: selectedSlug });
    navigateTo(ROUTES.onboardingImageRun, {
      updates: { template: selectedSlug },
      remove: ["category", "workflow"],
    });
  };

  return (
    <OnboardingShell
      currentStep={2}
      totalSteps={3}
      title={t(($) => {
        return $.onboarding.templatePicker.image.title;
      })}
      description={t(($) => {
        return $.onboarding.templatePicker.image.description;
      })}
      footer={
        <OnboardingFooter
          onBack={() => {
            navigateTo(ROUTES.onboarding);
          }}
          onPrimary={continueToRun}
          primaryLabel={t(($) => {
            return $.onboarding.common.continue;
          })}
          primaryDisabled={!selectedSlug}
        />
      }
    >
      <div className="mt-4 columns-1 gap-3 sm:columns-3">
        {templates.map((template) => {
          return (
            <IllustrationTemplateCard
              key={template.slug}
              template={template}
              selected={template.slug === selectedSlug}
              variantIndex={ui.imageVariantBySlug[template.slug] ?? 0}
              onSelect={() => {
                setDraft({ imageTemplateSlug: template.slug });
              }}
              onVariantChange={(index) => {
                setImageVariant(template.slug, index);
              }}
            />
          );
        })}
      </div>
    </OnboardingShell>
  );
}

function previewVideo(event: SyntheticEvent<HTMLButtonElement>): void {
  const video = event.currentTarget.querySelector("video");
  if (video) {
    detach(video.play(), Reason.DomCallback);
  }
}

function resetVideo(event: SyntheticEvent<HTMLButtonElement>): void {
  const video = event.currentTarget.querySelector("video");
  if (video) {
    video.pause();
    video.currentTime = 0;
  }
}

function VideoTemplateCard({
  template,
  selected,
  onSelect,
}: {
  readonly template: VideoTemplateItem;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      aria-pressed={selected}
      aria-label={t(
        ($) => {
          return $.onboarding.templatePicker.video.selectTemplate;
        },
        { title: template.title },
      )}
      className={cn(
        "overflow-hidden rounded-xl border bg-background text-left shadow-[var(--okou-card-shadow)] transition-colors hover:border-primary",
        selected && "border-primary",
      )}
      onClick={onSelect}
      onFocus={previewVideo}
      onBlur={resetVideo}
      onMouseEnter={previewVideo}
      onMouseLeave={resetVideo}
    >
      <span className="block aspect-[16/10] overflow-hidden bg-muted">
        <video
          muted
          loop
          playsInline
          preload="metadata"
          poster={template.cardPreviewImage ?? template.previewImage}
          className="h-full w-full object-cover"
        >
          <source src={template.previewWebm} type="video/webm; codecs=vp9" />
        </video>
      </span>
      <span className="flex min-w-0 items-center justify-between gap-2 px-3 pb-3 pt-[11px]">
        <span className="truncate text-sm font-semibold leading-5">
          {template.title}
        </span>
        <SelectionCheck selected={selected} />
      </span>
    </button>
  );
}

export function OnboardingVideoTemplatePage() {
  const { t } = useTranslation();
  const draft = useGet(onboardingDraft$);
  const setDraft = useSet(updateOnboardingDraft$);
  const { navigateTo } = useOnboardingNavigation();
  const selectedSlug = draft.videoTemplateSlug ?? "";
  const templates = localizedVideoTemplates(t);

  const continueToRun = (): void => {
    if (!selectedSlug) {
      return;
    }
    setDraft({ videoTemplateSlug: selectedSlug });
    navigateTo(ROUTES.onboardingVideoRun, {
      updates: { template: selectedSlug },
      remove: ["category", "workflow"],
    });
  };

  return (
    <OnboardingShell
      currentStep={2}
      totalSteps={3}
      title={t(($) => {
        return $.onboarding.templatePicker.video.title;
      })}
      description={t(($) => {
        return $.onboarding.templatePicker.video.description;
      })}
      footer={
        <OnboardingFooter
          onBack={() => {
            navigateTo(ROUTES.onboarding);
          }}
          onPrimary={continueToRun}
          primaryLabel={t(($) => {
            return $.onboarding.common.continue;
          })}
          primaryDisabled={!selectedSlug}
        />
      }
    >
      <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {templates.map((template) => {
          return (
            <VideoTemplateCard
              key={template.id}
              template={template}
              selected={template.slug === selectedSlug}
              onSelect={() => {
                setDraft({ videoTemplateSlug: template.slug });
              }}
            />
          );
        })}
      </div>
    </OnboardingShell>
  );
}
