import { scheduledTaskIllustrationImgs } from "./platform-assets.ts";

type AutomationPreviewKind = "once" | "daily" | "weekly";

function AutomationPreview({ kind }: { readonly kind: AutomationPreviewKind }) {
  return (
    <img
      src={scheduledTaskIllustrationImgs[kind]}
      alt=""
      aria-hidden
      width={320}
      height={180}
      decoding="async"
      className="block size-full bg-background object-contain p-3"
    />
  );
}

export const SCHEDULE_SUGGESTIONS = ["once", "daily", "weekly"] as const;

export { AutomationPreview };
