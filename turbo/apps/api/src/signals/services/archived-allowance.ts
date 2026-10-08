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
