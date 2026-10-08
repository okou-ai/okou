import {
  isStripeResourceMissingError,
  type StripeClient,
  type StripeProductRef,
} from "../external/stripe-client";
import { isConcurrencyPriceId } from "./org-concurrency-entitlements.service";
import { settle } from "../utils";

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

interface ArchivedSubscriptionIdentity {
  readonly metadata?: Readonly<Record<string, string>> | null;
  readonly items?: {
    readonly data: readonly { readonly price: { readonly id: string } }[];
  };
}

/** A reused Plan price alone is not proof that an archival object owns a live Plan. */
export function archivedSubscriptionHasSurvivingPlan(
  subscription: ArchivedSubscriptionIdentity,
): boolean {
  return !isArchivedUsageAllowanceMetadata(subscription.metadata);
}

export function archivedSubscriptionHasSurvivingComponents(
  subscription: ArchivedSubscriptionIdentity,
): boolean {
  if (!isArchivedUsageAllowanceMetadata(subscription.metadata)) {
    return true;
  }
  // The historical shared add-on had an independent configured concurrency item.
  return (subscription.items?.data ?? []).some((item) => {
    return isConcurrencyPriceId(item.price.id);
  });
}

interface BillingInvoiceLineIdentity {
  readonly metadata?: Readonly<Record<string, string>> | null;
  readonly price?: {
    readonly id: string;
    readonly product?: StripeProductRef | null;
  } | null;
  readonly pricing?: {
    readonly price_details?: {
      readonly price?:
        | string
        | { readonly id: string; readonly product?: StripeProductRef | null }
        | null;
      readonly product?: StripeProductRef | null;
    } | null;
  } | null;
}

function billingInvoiceLinePrice(line: BillingInvoiceLineIdentity) {
  const modern = line.pricing?.price_details?.price;
  const expanded = modern && typeof modern !== "string" ? modern : null;
  const id =
    line.price?.id ?? (typeof modern === "string" ? modern : expanded?.id);
  return id
    ? {
        id,
        product:
          line.price?.product ??
          expanded?.product ??
          line.pricing?.price_details?.product,
      }
    : null;
}

export async function survivingStripeBillingInvoiceLines<
  T extends BillingInvoiceLineIdentity,
>(
  lines: readonly T[],
  metadataCandidates: readonly (
    | Readonly<Record<string, string>>
    | null
    | undefined
  )[],
  stripe: StripeClient,
  signal: AbortSignal,
): Promise<T[]> {
  const archivalHeader = metadataCandidates.some(
    isArchivedUsageAllowanceMetadata,
  );
  const allowancePrices = new Set(
    metadataCandidates.flatMap((metadata) => {
      return metadata?.allowancePriceId ? [metadata.allowancePriceId] : [];
    }),
  );
  const surviving: T[] = [];
  for (const line of lines) {
    const price = billingInvoiceLinePrice(line);
    if (
      isArchivedUsageAllowanceMetadata(line.metadata) ||
      (price && allowancePrices.has(price.id)) ||
      (archivalHeader && (!price || !isConcurrencyPriceId(price.id)))
    ) {
      continue;
    }
    if (price && (await isExcludedStripeBillingPrice(price, stripe, signal))) {
      continue;
    }
    surviving.push(line);
  }
  return surviving;
}

/** Exclude archival or explicitly unavailable components, without reconstructing live rights. */
export async function isExcludedStripeBillingPrice(
  price: { readonly id: string; readonly product?: StripeProductRef | null },
  stripe: StripeClient,
  signal: AbortSignal,
): Promise<boolean> {
  let productRef = price.product;
  if (!productRef) {
    const fetchedPrice = await resolveBillingReference(
      stripe.prices.retrieve(price.id, { expand: ["product"] }),
      signal,
    );
    if (fetchedPrice === null) {
      return true;
    }
    productRef = fetchedPrice.product;
    if (!productRef) {
      throw new Error(
        `Cannot classify Stripe billing price ${price.id}: required Product is missing`,
      );
    }
  }
  const product =
    typeof productRef === "string"
      ? await resolveBillingReference(
          stripe.products.retrieve(productRef),
          signal,
        )
      : productRef;
  signal.throwIfAborted();
  return (
    product === null ||
    "deleted" in product ||
    isArchivedUsageAllowanceMetadata(product.metadata)
  );
}

async function resolveBillingReference<T extends object>(
  lookup: Promise<T>,
  signal: AbortSignal,
): Promise<T | null> {
  const result = await settle(lookup, signal);
  signal.throwIfAborted();
  if (result.ok) {
    if (typeof result.value !== "object" || result.value === null) {
      throw new Error(
        "Stripe billing reference lookup returned no required entity object",
      );
    }
    return result.value;
  }
  if (isStripeResourceMissingError(result.error)) {
    return null;
  }
  throw result.error;
}
