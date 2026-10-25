import { pgTable, uniqueIndex } from "drizzle-orm/pg-core";
import { usagePricingColumns } from "../columns/usage-pricing";

/**
 * Per-resource pricing for `usage_event` rows.
 *
 * Looked up by the three-level classification `(kind, provider, category)`
 * to price a batch of usage events.  Formula:
 *
 *   creditsCharged = ceil(quantity × unit_price / unit_size)
 *
 * `unit_price` is the credit cost of one pricing unit; `unit_size` is how
 * many `usage_event.quantity` items make up one unit.  Each row picks the
 * natural granularity for its category:
 *
 *   kind       provider                  category       unit_price  unit_size  meaning
 *   ---------  ------------------------  -------------  ----------  ---------  -------------------------------
 *   connector  x                         tweet.read     100         1000       $0.0001/read
 *   model      claude-sonnet-4-6         tokens.input   3000        1000000    $3 / 1M input tokens
 *   image      fal-ai/nano-banana-2      output_image   96          1          $0.096 per image
 *   image      gpt-image-2               tokens.output.image 36000  1000000    $36 / 1M output image tokens
 *   image      fal-ai/qwen-image         output_megapixel 24        1          $0.024 per output megapixel
 *   video      fal-ai/veo3.1/fast        output_video_seconds.audio 180 1      generated video seconds
 *   video      bytedance/seedance-2.0    output_video_tokens 1680   100000     generated video tokens
 */
export const usagePricing = pgTable(
  "usage_pricing",
  {
    ...usagePricingColumns(),
  },
  (table) => {
    return [
      uniqueIndex("uq_usage_pricing_kind_provider_category").on(
        table.kind,
        table.provider,
        table.category,
      ),
    ];
  },
);
