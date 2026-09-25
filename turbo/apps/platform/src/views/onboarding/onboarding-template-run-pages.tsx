import type { SyntheticEvent } from "react";
import { useGet, useSet } from "ccstate-react";
import { r2ImageTransformUrl } from "@okouai/core/r2-image-transform";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import {
  onboardingDraft$,
  updateOnboardingDraft$,
  type OnboardingDraft,
} from "../../signals/onboarding/onboarding-state.ts";
import { ROUTES, type RoutePath } from "../../signals/route-paths.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { onboardingVideoPrompt } from "./onboarding-data.ts";
import { useOnboardingNavigation } from "./onboarding-navigation.ts";
import { OnboardingRunAction } from "./onboarding-run-action.tsx";
import { Textarea, cn } from "@okouai/ui";
import {
  ONBOARDING_TEXTAREA_CLASS,
  OnboardingShell,
} from "./onboarding-shell.tsx";
import { ILLUSTRATION_TEMPLATE_ITEMS } from "@okouai/core/illustration-template-items";
import { PRESENTATION_TEMPLATE_PICKER_ITEMS } from "@okouai/core/presentation-template-items";
import { VIDEO_TEMPLATE_ITEMS } from "@okouai/core/video-template-items";

type TemplateRunKind = "presentation" | "image" | "video";

type TemplateRunMedia =
  | {
      readonly kind: "presentation" | "image";
      readonly imageUrl: string;
    }
  | {
      readonly kind: "video";
      readonly imageUrl: string;
      readonly videoUrl: string;
    };

interface TemplateRunConfig {
  readonly title: string;
  readonly prompt: string;
  readonly note: string;
  readonly noteLabel: string;
  readonly notePlaceholder: string;
  readonly templateSlug: string;
  readonly templateId: string;
  readonly backPath: RoutePath;
  readonly media: TemplateRunMedia;
  readonly requiresPaidPlan: boolean;
}

function withNote(basePrompt: string, label: string, note: string): string {
  const trimmedNote = note.trim();
  return trimmedNote
    ? `${basePrompt}\n\n${label}:\n${trimmedNote}`
    : basePrompt;
}

function presentationRunConfig(
  slug: string | null,
  note: string,
  t: TFunction<"common">,
): TemplateRunConfig | null {
  const item = PRESENTATION_TEMPLATE_PICKER_ITEMS.find((candidate) => {
    return candidate.slug === slug;
  });
  if (!item) {
    return null;
  }
  return {
    title: t(($) => {
      return $.onboarding.templateRun.presentation.title;
    }),
    prompt: withNote(item.prompt, "Additional content and instruction", note),
    note,
    noteLabel: t(($) => {
      return $.onboarding.templateRun.presentation.noteLabel;
    }),
    notePlaceholder: t(($) => {
      return $.onboarding.templateRun.presentation.notePlaceholder;
    }),
    templateSlug: item.slug,
    templateId: `presentation-template:${item.slug}`,
    backPath: ROUTES.onboardingPresentationTemplate,
    media: {
      kind: "presentation",
      imageUrl: item.previewImages[0] ?? item.previewImage,
    },
    requiresPaidPlan: false,
  };
}

function imageRunConfig(
  slug: string | null,
  note: string,
  t: TFunction<"common">,
): TemplateRunConfig | null {
  const item = ILLUSTRATION_TEMPLATE_ITEMS.find((candidate) => {
    return candidate.slug === slug;
  });
  if (!item) {
    return null;
  }
  const basePrompt = `Generate an illustration in the ${item.title} style.`;
  return {
    title: t(($) => {
      return $.onboarding.templateRun.image.title;
    }),
    prompt: withNote(basePrompt, "Scene", note),
    note,
    noteLabel: t(($) => {
      return $.onboarding.templateRun.image.noteLabel;
    }),
    notePlaceholder: t(($) => {
      return $.onboarding.templateRun.image.notePlaceholder;
    }),
    templateSlug: item.slug,
    templateId: `illustration-template:${item.slug}`,
    backPath: ROUTES.onboardingImageTemplate,
    media: {
      kind: "image",
      imageUrl: item.previewImage,
    },
    requiresPaidPlan: false,
  };
}

function videoRunConfig(
  slug: string | null,
  note: string,
  t: TFunction<"common">,
): TemplateRunConfig | null {
  const item = VIDEO_TEMPLATE_ITEMS.find((candidate) => {
    return candidate.slug === slug;
  });
  if (!item) {
    return null;
  }
  return {
    title: t(($) => {
      return $.onboarding.templateRun.video.title;
    }),
    prompt: withNote(
      onboardingVideoPrompt(item.slug),
      "Additional direction",
      note,
    ),
    note,
    noteLabel: t(($) => {
      return $.onboarding.templateRun.video.noteLabel;
    }),
    notePlaceholder: t(($) => {
      return $.onboarding.templateRun.video.notePlaceholder;
    }),
    templateSlug: item.slug,
    templateId: item.id,
    backPath: ROUTES.onboardingVideoTemplate,
    media: {
      kind: "video",
      imageUrl: item.cardPreviewImage ?? item.previewImage,
      videoUrl: item.previewWebm,
    },
    requiresPaidPlan: true,
  };
}

function templateRunConfig(
  kind: TemplateRunKind,
  draft: OnboardingDraft,
  t: TFunction<"common">,
): TemplateRunConfig | null {
  if (kind === "presentation") {
    return presentationRunConfig(
      draft.presentationTemplateSlug,
      draft.presentationNote,
      t,
    );
  }
  if (kind === "image") {
    return imageRunConfig(draft.imageTemplateSlug, draft.imageNote, t);
  }
  return videoRunConfig(draft.videoTemplateSlug, draft.videoNote, t);
}

function playVideo(event: SyntheticEvent<HTMLElement>): void {
  const video = event.currentTarget.querySelector("video");
  if (video) {
    detach(video.play(), Reason.DomCallback);
  }
}

function resetVideo(event: SyntheticEvent<HTMLElement>): void {
  const video = event.currentTarget.querySelector("video");
  if (video) {
    video.pause();
    video.currentTime = 0;
  }
}

function TemplateRunPreview({ media }: { readonly media: TemplateRunMedia }) {
  const { t } = useTranslation();
  if (media.kind === "video") {
    return (
      <section
        aria-label={t(($) => {
          return $.onboarding.templateRun.video.previewLabel;
        })}
        tabIndex={0}
        className="mt-6 h-[200px] w-full max-w-[350px] overflow-hidden rounded-3xl border border-border bg-background shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-primary"
        onFocus={playVideo}
        onBlur={resetVideo}
        onMouseEnter={playVideo}
        onMouseLeave={resetVideo}
      >
        <video
          muted
          loop
          playsInline
          preload="metadata"
          poster={media.imageUrl}
          className="h-full w-full object-cover"
        >
          <source src={media.videoUrl} type="video/webm; codecs=vp9" />
        </video>
      </section>
    );
  }
  if (media.kind === "presentation") {
    return (
      <section
        aria-label={t(($) => {
          return $.onboarding.templateRun.presentation.previewLabel;
        })}
        className="mt-6 h-[136px] w-[242px] overflow-hidden rounded-3xl border border-border bg-muted shadow-sm"
      >
        <img
          src={r2ImageTransformUrl(media.imageUrl, { width: 484 })}
          alt=""
          className="h-full w-full object-cover"
        />
      </section>
    );
  }
  return (
    <section
      aria-label={t(($) => {
        return $.onboarding.templateRun.image.previewLabel;
      })}
      className="mt-5 h-[225px] w-[167px] overflow-hidden rounded-3xl bg-muted"
    >
      <img
        src={r2ImageTransformUrl(media.imageUrl, { width: 334 })}
        alt=""
        className="h-full w-full object-cover"
      />
    </section>
  );
}

function OnboardingTemplateRunPage({
  kind,
}: {
  readonly kind: TemplateRunKind;
}) {
  const { t } = useTranslation();
  const draft = useGet(onboardingDraft$);
  const setDraft = useSet(updateOnboardingDraft$);
  const { navigateTo } = useOnboardingNavigation();
  const config = templateRunConfig(kind, draft, t);

  if (!config) {
    return null;
  }

  const setNote = (note: string): void => {
    if (kind === "presentation") {
      setDraft({ presentationNote: note });
    } else if (kind === "image") {
      setDraft({ imageNote: note });
    } else {
      setDraft({ videoNote: note });
    }
  };

  const handleBack = (): void => {
    navigateTo(config.backPath, {
      updates: { template: config.templateSlug },
    });
  };

  return (
    <OnboardingShell
      currentStep={3}
      totalSteps={3}
      title={config.title}
      description=""
      footer={
        <OnboardingRunAction
          prompt={config.prompt}
          template={config.templateId}
          templateSlug={config.templateSlug}
          requiresPaidPlan={config.requiresPaidPlan}
          onBack={handleBack}
        />
      }
    >
      <TemplateRunPreview media={config.media} />
      <div className="mt-6 flex w-full flex-col rounded-3xl border border-border bg-background px-6 pb-6">
        <label className="sr-only" htmlFor={`${kind}-note`}>
          {config.noteLabel}
        </label>
        <Textarea
          id={`${kind}-note`}
          value={config.note}
          onChange={(event) => {
            setNote(event.target.value);
          }}
          placeholder={config.notePlaceholder}
          rows={5}
          className={cn(
            ONBOARDING_TEXTAREA_CLASS,
            "mt-[18px] min-h-32 resize-y p-3 leading-5",
          )}
        />
      </div>
    </OnboardingShell>
  );
}

export function OnboardingPresentationRunPage() {
  return <OnboardingTemplateRunPage kind="presentation" />;
}

export function OnboardingImageRunPage() {
  return <OnboardingTemplateRunPage kind="image" />;
}

export function OnboardingVideoRunPage() {
  return <OnboardingTemplateRunPage kind="video" />;
}
