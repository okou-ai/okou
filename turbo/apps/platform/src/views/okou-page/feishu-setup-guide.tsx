import type { FeishuPlatform } from "@okouai/core/feishu-platform";
import { Button } from "@okouai/ui";
import {
  SegmentControl,
  SegmentControlItem,
} from "@okouai/ui/components/ui/segment-control";
import { useGet, useSet } from "ccstate-react";
import { Loader2 } from "lucide-react";
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
  feishuGuideImageIndex$,
  feishuGuideCanvas,
  feishuPlatform$,
  setFeishuGuideImageIndex$,
  type FeishuSetupStep,
} from "../../signals/okou-page/feishu.ts";

import { ZoomableArtifactImageCanvas } from "./zoomable-image-canvas.tsx";
import { ArtifactImageZoomControls } from "./artifact-actions.tsx";

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
  const images = useGuideImages(step);
  const index = useGet(feishuGuideImageIndex$);
  const image = images[index] ?? images[0];
  return (
    <section
      id="feishu-setup-reference"
      aria-label={t(($) => {
        return $.connectors.setupGuide.title;
      })}
      className="order-2 flex shrink-0 flex-col gap-4 bg-gray-50 p-5 @3xl/feishu-setup:order-1 @3xl/feishu-setup:min-h-0 @3xl/feishu-setup:shrink @3xl/feishu-setup:gap-5 @3xl/feishu-setup:p-6 @5xl/feishu-setup:px-8"
    >
      {GUIDE_PRELOAD_SOURCES.map((src) => {
        return <link key={src} rel="preload" as="image" href={src} />;
      })}
      <FeishuGuideStage image={image} />
      <FeishuGuideControls step={step} images={images} />
    </section>
  );
}

function FeishuGuideStage({ image }: { readonly image: GuideImage }) {
  const navigationOwnerRef = useSet(feishuGuideCanvas.navigationOwnerRef$);
  return (
    <div
      ref={navigationOwnerRef}
      role="group"
      aria-label={image.alt}
      tabIndex={0}
      className="relative flex h-72 min-h-0 w-full shrink-0 overflow-hidden rounded-3xl border border-surface-border bg-background @3xl/feishu-setup:h-auto @3xl/feishu-setup:flex-1 @3xl/feishu-setup:shrink"
    >
      <ZoomableArtifactImageCanvas
        key={image.src}
        src={image.src}
        alt={image.alt}
        signals={feishuGuideCanvas}
        canvasTestId="feishu-guide-canvas"
        imageTestId="feishu-guide-image"
        className="bg-background"
        contentClassName="p-4 @3xl/feishu-setup:p-5"
        pendingContent={<Loader2 size={20} className="animate-spin" />}
      >
        {(controls) => {
          return (
            <ArtifactImageZoomControls
              controls={controls}
              testIdPrefix="feishu-guide"
            />
          );
        }}
      </ZoomableArtifactImageCanvas>
    </div>
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
  const setIndex = useSet(setFeishuGuideImageIndex$);
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
                className="h-auto min-w-0 flex-1 justify-start whitespace-normal rounded-xl border border-surface-border px-2 py-2 text-left text-xs data-checked:border-primary"
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
      <Button
        type="button"
        variant="link"
        size="sm"
        className="px-0 text-xs font-normal text-muted-foreground underline underline-offset-4 hover:text-foreground @3xl/feishu-setup:hidden"
        onClick={() => {
          document
            .getElementById("feishu-setup-fields")
            ?.scrollIntoView({ block: "start" });
        }}
      >
        {t(($) => {
          return $.connectors.setupGuide.backToFields;
        })}
      </Button>
    </div>
  );
}
