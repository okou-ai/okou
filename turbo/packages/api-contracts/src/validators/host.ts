import { string } from "zod";

export const hostedSiteUrlSlugSchema = string()
  .min(3)
  .max(63)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/)
  .refine((value) => {
    return !/^(?:dpl|pv|ps|sh)-/u.test(value);
  }, "This website prefix is reserved");

/**
 * HTML documents are a publication's mutable entry points: a redeploy replaces
 * them in place under the same address, so delivery never caches them and their
 * bytes may differ between publications of one site.
 */
export function isHostedSiteDocument(file: {
  readonly path: string;
  readonly contentType: string;
}): boolean {
  return (
    /\.html?$/iu.test(file.path) ||
    file.contentType.toLowerCase().startsWith("text/html")
  );
}
