import { computed } from "ccstate";
import { and, eq } from "drizzle-orm";
import { usagePricing } from "@okouai/db/schema/usage-pricing";
import { db$ } from "../external/db";
import {
  resolveUsagePricingProvider,
  usagePricingResolution$,
} from "../context/usage-pricing-resolution";

export const INTRO_VIDEO_RENDER_PROVIDER = "heygen-hyperframes-render";
export const INTRO_VIDEO_RENDER_CATEGORY = "output_video_seconds";
export const introVideoRenderPricing$ = computed(async (get) => {
  const provider = resolveUsagePricingProvider(
    get(usagePricingResolution$),
    "video",
    INTRO_VIDEO_RENDER_PROVIDER,
  );
  const [price] = await get(db$)
    .select({
      unitPrice: usagePricing.unitPrice,
      unitSize: usagePricing.unitSize,
    })
    .from(usagePricing)
    .where(
      and(
        eq(usagePricing.kind, "video"),
        eq(usagePricing.provider, provider),
        eq(usagePricing.category, INTRO_VIDEO_RENDER_CATEGORY),
      ),
    )
    .limit(1);
  return price && price.unitPrice > 0 && price.unitSize > 0 ? price : null;
});
