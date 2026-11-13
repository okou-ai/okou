import {
  FEISHU_PLATFORMS,
  type FeishuPlatform,
} from "@okouai/core/feishu-platform";
import { Button, buttonVariants, IconButton } from "@okouai/ui";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@okouai/ui/components/ui/dialog";
import {
  SegmentControl,
  SegmentControlItem,
} from "@okouai/ui/components/ui/segment-control";
import { useGet, useSet } from "ccstate-react";
import { ExternalLink, X, ZoomIn } from "lucide-react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";

import {
  platformFeishuAppCreatedCredentialsImg,
  platformFeishuAvailabilitySettingsAllMembersImg,
  platformFeishuCreateEnterpriseCustomAppImg,
  platformFeishuEncryptionStrategyImg,
  platformFeishuEventRequestUrlImg,
  platformFeishuEventSubscriptionModeImg,
  platformFeishuPermissionsScopesBatchImportMenuImg,
  platformFeishuPermissionsScopesBatchImportReviewImg,
  platformFeishuSecuritySettingsRedirectUrlImg,
  platformFeishuVersionAvailabilityEditImg,
  platformFeishuVersionManagementCreateVersionImg,
  platformLarkCreateAppForAgentImg,
} from "../../lib/static-assets.ts";
import {
  feishuGuideExpanded$,
  feishuGuideFocused$,
  feishuGuideImageIndex$,
  feishuPlatform$,
  setFeishuGuideExpanded$,
  setFeishuGuideFocused$,
  setFeishuGuideImageIndex$,
  type FeishuSetupStep,
} from "../../signals/okou-page/feishu.ts";

interface GuideImage {
  readonly src: string;
  readonly alt: string;
  readonly label: string;
  readonly width: number;
  readonly height: number;
}

const GUIDE_PRELOAD_SOURCES = [
  platformFeishuAppCreatedCredentialsImg,
  platformFeishuEncryptionStrategyImg,
  platformFeishuSecuritySettingsRedirectUrlImg,
  platformFeishuPermissionsScopesBatchImportMenuImg,
  platformFeishuPermissionsScopesBatchImportReviewImg,
  platformFeishuEventSubscriptionModeImg,
  platformFeishuEventRequestUrlImg,
  platformFeishuVersionManagementCreateVersionImg,
  platformFeishuVersionAvailabilityEditImg,
  platformFeishuAvailabilitySettingsAllMembersImg,
] as const;

function useGuideImages(
  step: FeishuSetupStep,
): readonly [GuideImage, ...GuideImage[]] {
  const { t } = useTranslation();
  const platform = useGet(feishuPlatform$);
  switch (step) {
    case "create": {
      return [
        {
          src:
            platform === "lark"
              ? platformLarkCreateAppForAgentImg
              : platformFeishuCreateEnterpriseCustomAppImg,
          width: platform === "lark" ? 1274 : 1234,
          height: platform === "lark" ? 1118 : 998,
          alt: t(($) => {
            return $.connectors.providerSettings[platform].create.imageAlt;
          }),
          label: t(($) => {
            return $.connectors.providerSettings[platform].create.title;
          }),
        },
      ];
    }
    case "credentials": {
      return [
        {
          src: platformFeishuAppCreatedCredentialsImg,
          width: 1190,
          height: 1076,
          alt: t(($) => {
            return $.connectors.providerSettings[platform].credentials.imageAlt;
          }),
          label: t(($) => {
            return $.connectors.providerSettings[platform].credentials.title;
          }),
        },
      ];
    }
    case "tokens": {
      return [
        {
          src: platformFeishuEncryptionStrategyImg,
          width: 2356,
          height: 1184,
          alt: t(($) => {
            return $.connectors.providerSettings[platform].tokens.imageAlt;
          }),
          label: t(($) => {
            return $.connectors.providerSettings[platform].tokens.title;
          }),
        },
      ];
    }
    case "redirect": {
      return [
        {
          src: platformFeishuSecuritySettingsRedirectUrlImg,
          width: 3190,
          height: 1220,
          alt: t(($) => {
            return $.connectors.providerSettings[platform].redirect.imageAlt;
          }),
          label: t(($) => {
            return $.connectors.providerSettings[platform].redirect.title;
          }),
        },
      ];
    }
    default: {
      return multiGuideImages(step, platform, t);
    }
  }
}

function multiGuideImages(
  step: "permissions" | "events" | "publish",
  platform: FeishuPlatform,
  t: TFunction<"common">,
): readonly [GuideImage, ...GuideImage[]] {
  switch (step) {
    case "permissions": {
      return [
        {
          src: platformFeishuPermissionsScopesBatchImportMenuImg,
          width: 1209,
          height: 838,
          alt: t(($) => {
            return $.connectors.providerSettings[platform].permissions.menuAlt;
          }),
          label: t(($) => {
            return $.connectors.providerSettings[platform].permissions
              .menuLabel;
          }),
        },
        {
          src: platformFeishuPermissionsScopesBatchImportReviewImg,
          width: 838,
          height: 893,
          alt: t(($) => {
            return $.connectors.providerSettings[platform].permissions
              .reviewAlt;
          }),
          label: t(($) => {
            return $.connectors.providerSettings[platform].permissions
              .reviewLabel;
          }),
        },
      ];
    }
    case "events": {
      return [
        {
          src: platformFeishuEventSubscriptionModeImg,
          width: 2562,
          height: 1296,
          alt: t(($) => {
            return $.connectors.providerSettings[platform].events
              .subscriptionAlt;
          }),
          label: t(($) => {
            return $.connectors.providerSettings[platform].events
              .subscriptionLabel;
          }),
        },
        {
          src: platformFeishuEventRequestUrlImg,
          width: 2442,
          height: 1278,
          alt: t(($) => {
            return $.connectors.providerSettings[platform].events.requestAlt;
          }),
          label: t(($) => {
            return $.connectors.providerSettings[platform].events.requestLabel;
          }),
        },
      ];
    }
    case "publish": {
      return [
        {
          src: platformFeishuVersionManagementCreateVersionImg,
          width: 3822,
          height: 1708,
          alt: t(($) => {
            return $.connectors.providerSettings[platform].publish
              .createVersionAlt;
          }),
          label: t(($) => {
            return $.connectors.providerSettings[platform].publish
              .createVersionLabel;
          }),
        },
        {
          src: platformFeishuVersionAvailabilityEditImg,
          width: 3046,
          height: 1780,
          alt: t(($) => {
            return $.connectors.providerSettings[platform].publish
              .editAvailabilityAlt;
          }),
          label: t(($) => {
            return $.connectors.providerSettings[platform].publish
              .editAvailabilityLabel;
          }),
        },
        {
          src: platformFeishuAvailabilitySettingsAllMembersImg,
          width: 1630,
          height: 544,
          alt: t(($) => {
            return $.connectors.providerSettings[platform].publish
              .allMembersAlt;
          }),
          label: t(($) => {
            return $.connectors.providerSettings[platform].publish
              .allMembersLabel;
          }),
        },
      ];
    }
  }
}

export function FeishuSetupGuide({ step }: { readonly step: FeishuSetupStep }) {
  const { t } = useTranslation();
  const platform = useGet(feishuPlatform$);
  const images = useGuideImages(step);
  const index = useGet(feishuGuideImageIndex$);
  const image = images[index] ?? images[0];
  return (
    <section
      id="feishu-setup-reference"
      aria-label={t(($) => {
        return $.connectors.setupGuide.title;
      })}
      className="order-2 flex shrink-0 flex-col gap-4 bg-gray-50 p-5 md:order-1 md:min-h-0 md:shrink md:gap-5 md:p-8 lg:px-10"
    >
      {GUIDE_PRELOAD_SOURCES.map((src) => {
        return <link key={src} rel="preload" as="image" href={src} />;
      })}
      <div className="flex shrink-0 items-center justify-between gap-4">
        <h2 className="text-sm font-medium">
          {t(($) => {
            return $.connectors.setupGuide.title;
          })}
        </h2>
        <a
          href={
            step === "create"
              ? new URL(
                  "/page/launcher?from=backend_oneclick",
                  FEISHU_PLATFORMS[platform].developerConsoleUrl,
                ).toString()
              : FEISHU_PLATFORMS[platform].developerConsoleUrl
          }
          target="_blank"
          rel="noreferrer"
          className={buttonVariants({ variant: "outline", size: "sm" })}
        >
          {t(($) => {
            return $.connectors.providerSettings[platform].developerConsole;
          })}
          <ExternalLink size={14} />
        </a>
      </div>
      <FeishuGuideStage step={step} image={image} />
      <FeishuGuideControls step={step} images={images} />
      <FeishuGuidePreview image={image} />
    </section>
  );
}

function FeishuGuideStage({
  step,
  image,
}: {
  readonly step: FeishuSetupStep;
  readonly image: GuideImage;
}) {
  const { t } = useTranslation();
  const focused = useGet(feishuGuideFocused$);
  const setExpanded = useSet(setFeishuGuideExpanded$);
  const showCrop = step === "credentials" && focused;
  const zoomLabel = t(($) => {
    return $.connectors.setupGuide.enlarge;
  });
  return (
    <Button
      type="button"
      variant="quiet"
      aria-label={zoomLabel}
      onClick={() => {
        return setExpanded(true);
      }}
      className="relative flex h-64 min-h-0 w-full items-center justify-center overflow-hidden rounded-3xl border border-surface-border bg-background p-4 hover:border-foreground/40 hover:bg-background md:h-auto md:flex-1 md:p-5"
    >
      {showCrop ? (
        // Keep the original image; crop only the surrounding whitespace.
        <div className="relative aspect-[96/61] max-h-full w-full overflow-hidden">
          <img
            src={image.src}
            alt={image.alt}
            width={image.width}
            height={image.height}
            className="absolute -left-[12.5%] -top-[60.656%] h-auto w-[123.959%] max-w-none"
          />
        </div>
      ) : (
        <img
          src={image.src}
          alt={image.alt}
          width={image.width}
          height={image.height}
          className="h-full min-h-0 w-full rounded-lg object-contain"
        />
      )}
      <span className="absolute bottom-3 right-3 inline-flex items-center gap-1.5 rounded-lg border border-surface-border bg-background px-2 py-1 text-xs text-muted-foreground">
        <ZoomIn size={14} />
        {zoomLabel}
      </span>
    </Button>
  );
}

function FeishuGuideControls({
  step,
  images,
}: {
  readonly step: FeishuSetupStep;
  readonly images: readonly [GuideImage, ...GuideImage[]];
}) {
  const { t } = useTranslation();
  const platform = useGet(feishuPlatform$);
  const index = useGet(feishuGuideImageIndex$);
  const focused = useGet(feishuGuideFocused$);
  const setIndex = useSet(setFeishuGuideImageIndex$);
  const setFocused = useSet(setFeishuGuideFocused$);
  const image = images[index] ?? images[0];
  return (
    <div className="shrink-0 space-y-3">
      <div className="flex items-start justify-between gap-3 text-xs text-muted-foreground">
        <p>
          {images.length === 1
            ? image.alt
            : t(($) => {
                return $.connectors.setupGuide.title;
              })}
        </p>
        {images.length > 1 ? (
          <span className="shrink-0">
            {t(
              ($) => {
                return $.connectors.setupGuide.imageProgress;
              },
              {
                current: index + 1,
                total: images.length,
              },
            )}
          </span>
        ) : null}
      </div>
      {step === "credentials" ? (
        <SegmentControl
          size="xs"
          variant="plain"
          value={focused ? "focus" : "full"}
          onValueChange={(value) => {
            setFocused(value === "focus");
          }}
          aria-label={t(($) => {
            return $.connectors.setupGuide.imageArea;
          })}
        >
          <SegmentControlItem value="focus">
            {t(($) => {
              return $.connectors.setupGuide.keyArea;
            })}
          </SegmentControlItem>
          <SegmentControlItem value="full">
            {t(($) => {
              return $.connectors.setupGuide.fullImage;
            })}
          </SegmentControlItem>
        </SegmentControl>
      ) : null}
      {images.length > 1 ? (
        <SegmentControl
          variant="plain"
          size="sm"
          value={index}
          onValueChange={setIndex}
          aria-label={t(($) => {
            return $.connectors.setupGuide.images;
          })}
          className="flex h-auto w-full items-stretch gap-2"
        >
          {images.map((item, itemIndex) => {
            return (
              <SegmentControlItem
                key={item.src}
                value={itemIndex}
                className="h-auto min-w-0 flex-1 justify-start whitespace-normal rounded-xl border border-surface-border px-2 py-2 text-left text-xs data-checked:border-foreground data-checked:bg-background"
              >
                <img
                  src={item.src}
                  alt=""
                  width={item.width}
                  height={item.height}
                  className="h-9 w-12 shrink-0 rounded border border-border bg-background object-contain"
                />
                <span>
                  {itemIndex + 1}. {item.label}
                </span>
              </SegmentControlItem>
            );
          })}
        </SegmentControl>
      ) : null}
      {platform === "lark" && step !== "create" ? (
        <p className="text-xs text-muted-foreground">
          {t(($) => {
            return $.connectors.providerSettings.lark.guideReference;
          })}
        </p>
      ) : null}
      {step === "permissions" ? (
        <p className="text-xs text-muted-foreground">
          {t(($) => {
            return $.connectors.setupGuide.permissionReference;
          })}
        </p>
      ) : null}
      <a
        href="#feishu-setup-fields"
        className="inline-flex text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground md:hidden"
      >
        {t(($) => {
          return $.connectors.setupGuide.backToFields;
        })}
      </a>
    </div>
  );
}

function FeishuGuidePreview({ image }: { readonly image: GuideImage }) {
  const { t } = useTranslation();
  const expanded = useGet(feishuGuideExpanded$);
  const setExpanded = useSet(setFeishuGuideExpanded$);
  return (
    <Dialog open={expanded} onOpenChange={setExpanded}>
      <DialogContent
        maxWidth={1440}
        height={1000}
        showCloseButton={false}
        scrollable={false}
        contentClassName="flex min-h-0 flex-col gap-0 overflow-hidden p-0"
      >
        <div className="flex shrink-0 items-center justify-between gap-4 border-b border-border px-5 py-3">
          <DialogTitle className="text-sm font-medium">
            {image.label}
          </DialogTitle>
          <IconButton
            aria-label={t(($) => {
              return $.connectors.actions.close;
            })}
            onClick={() => {
              return setExpanded(false);
            }}
          >
            <X size={18} />
          </IconButton>
        </div>
        <div className="min-h-0 flex-1 overflow-auto bg-gray-50 p-4 md:p-6">
          <img
            src={image.src}
            alt={image.alt}
            width={image.width}
            height={image.height}
            className="mx-auto h-auto w-full rounded-xl bg-background"
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
