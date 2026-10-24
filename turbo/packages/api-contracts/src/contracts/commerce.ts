import { z } from "zod";

export const amazonMarketplaceSchema = z.enum([
  "amazon.com",
  "amazon.co.uk",
  "amazon.de",
  "amazon.fr",
  "amazon.it",
  "amazon.es",
  "amazon.ca",
  "amazon.co.jp",
  "amazon.in",
]);

export type AmazonMarketplace = z.infer<typeof amazonMarketplaceSchema>;

export function parseAmazonProductTarget(target: string): {
  asin: string;
  marketplace?: AmazonMarketplace;
} | null {
  if (/^[A-Za-z0-9]{10}$/.test(target)) {
    return { asin: target.toUpperCase() };
  }
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return null;
  }
  const marketplace = amazonMarketplaceSchema.safeParse(
    url.hostname.replace(/^www\./, ""),
  );
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !marketplace.success
  ) {
    return null;
  }
  const asin =
    /^(?:\/[^/]+)?\/dp\/([A-Za-z0-9]{10})(?:\/|$)/.exec(url.pathname)?.[1] ??
    /^\/gp\/product\/([A-Za-z0-9]{10})(?:\/|$)/.exec(url.pathname)?.[1];
  return asin
    ? { asin: asin.toUpperCase(), marketplace: marketplace.data }
    : null;
}

export const commerceSearchRequestSchema = z
  .object({
    query: z
      .string()
      .trim()
      .min(1)
      .max(512)
      .refine((value) => {
        return (
          !/https?:\/\//i.test(value) &&
          !/^(?:www\.)?amazon\.[^\s/]+\//i.test(value)
        );
      }, "Use commerce inspect for Amazon product URLs, not keyword search"),
    marketplace: amazonMarketplaceSchema.default("amazon.com"),
    limit: z.number().int().min(1).max(48).default(48),
    requestId: z.uuid().optional(),
  })
  .strict();

export const commerceInspectRequestSchema = z
  .object({
    target: z.string().trim().min(1).max(2048),
    marketplace: amazonMarketplaceSchema.optional(),
    requestId: z.uuid().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const product = parseAmazonProductTarget(value.target);
    if (!product) {
      context.addIssue({
        code: "custom",
        path: ["target"],
        message: "Expected an ASIN or a supported HTTPS Amazon product URL",
      });
    } else if (
      product.marketplace &&
      value.marketplace &&
      product.marketplace !== value.marketplace
    ) {
      context.addIssue({
        code: "custom",
        path: ["marketplace"],
        message: "Marketplace must match the Amazon product URL",
      });
    }
  });

export type CommerceSearchRequest = z.infer<typeof commerceSearchRequestSchema>;

export type CommerceInspectRequest = z.infer<
  typeof commerceInspectRequestSchema
>;
