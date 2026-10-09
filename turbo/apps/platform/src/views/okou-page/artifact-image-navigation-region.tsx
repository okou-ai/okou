import type { ReactNode } from "react";
import { useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import type { ZoomableImageCanvasSignals } from "../../signals/zoomable-image-canvas.ts";
import {
  ArtifactImageNavigationControls,
  type ArtifactImageNavigationActions,
} from "./artifact-actions.tsx";

/** A stable focus owner, independent of the image's loading/zoom lifecycle. */
export function ArtifactImageNavigationRegion({
  children,
  filename,
  navigation,
  signals,
  testIdPrefix,
}: {
  children: ReactNode;
  filename: string;
  navigation?: ArtifactImageNavigationActions;
  signals: ZoomableImageCanvasSignals;
  testIdPrefix: string;
}) {
  const { t } = useTranslation();
  const ownerRef = useSet(signals.navigationOwnerRef$);

  return (
    <div
      ref={ownerRef}
      role="group"
      tabIndex={0}
      aria-label={t(
        ($) => {
          return $.artifacts.preview.dialogLabel;
        },
        { filename },
      )}
      data-image-navigation-owner
      className="relative h-full min-h-0 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      onKeyDown={(event) => {
        if (
          event.target !== event.currentTarget ||
          event.defaultPrevented ||
          event.nativeEvent.isComposing ||
          event.altKey ||
          event.ctrlKey ||
          event.metaKey ||
          event.shiftKey
        ) {
          return;
        }
        const navigate =
          event.key === "ArrowLeft"
            ? navigation?.onPrevious
            : event.key === "ArrowRight"
              ? navigation?.onNext
              : undefined;
        if (navigate) {
          event.preventDefault();
          navigate();
        }
      }}
    >
      {children}
      <ArtifactImageNavigationControls
        navigation={navigation}
        testIdPrefix={testIdPrefix}
      />
    </div>
  );
}
