interface ObjectUrlResource {
  readonly url: string;
  readonly release: () => void;
}

/**
 * Create one object URL owned by an explicit consumer lifetime. Consumers may
 * release it earlier; abort remains the final cleanup path when their state is
 * abandoned without running its normal close command.
 */
export function createObjectUrlResource(
  blob: Blob,
  signal: AbortSignal,
): ObjectUrlResource {
  signal.throwIfAborted();
  const url = URL.createObjectURL(blob);
  let released = false;
  const release = () => {
    if (released) {
      return;
    }
    released = true;
    signal.removeEventListener("abort", release);
    URL.revokeObjectURL(url);
  };
  signal.addEventListener("abort", release, { once: true });
  return { url, release };
}
