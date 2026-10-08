import {
  getStripeClient,
  type StripeProductRef,
} from "../external/stripe-client";

/** Historical Stripe objects remain replayable, but cannot grant live billing benefits. */
export function isArchivedUsageAllowanceMetadata(
  metadata: Readonly<Record<string, string>> | null | undefined,
): boolean {
  return (
    metadata?.purpose === "usage_allowance" ||
    metadata?.type === "usage_allowance" ||
    metadata?.source === "atom_usage_allowance"
  );
}

/** Resolve only archival identity, never an entitlement or its historical window settings. */
export async function isArchivedUsageAllowancePrice(
  price: { readonly id: string; readonly product?: StripeProductRef | null },
  signal: AbortSignal,
): Promise<boolean> {
  const stripe = getStripeClient();
  const productRef =
    price.product ??
    (await stripe.prices.retrieve(price.id, { expand: ["product"] })).product;
  signal.throwIfAborted();
  if (!productRef) {
    return false;
  }
  const product =
    typeof productRef === "string"
      ? await stripe.products.retrieve(productRef)
      : productRef;
  signal.throwIfAborted();
  return (
    !("deleted" in product) &&
    isArchivedUsageAllowanceMetadata(product.metadata)
  );
}
