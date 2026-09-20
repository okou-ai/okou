export function normalizeMountOverlay<T extends { readonly mountPath: string }>(
  mounts: readonly T[],
): readonly T[] {
  const byMountPath = new Map<string, T>();
  for (const mount of mounts) {
    // Mount application is last-wins. Delete first so the canonical list also
    // preserves the winning entry's relative order.
    byMountPath.delete(mount.mountPath);
    byMountPath.set(mount.mountPath, mount);
  }
  return [...byMountPath.values()];
}
