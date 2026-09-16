export function retireImpactMetadata<T>(
  metadata: Readonly<Record<string, T>>,
): Record<string, T> {
  return Object.fromEntries(
    Object.entries(metadata).filter(([key]) => {
      return !key.startsWith("impact_");
    }),
  );
}
