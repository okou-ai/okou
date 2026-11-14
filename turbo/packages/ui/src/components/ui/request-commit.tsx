import { useLayoutEffect } from "react";

/** Acknowledge an explicit command-owned request after its DOM commit. */
export function RequestCommit<T>({
  request,
  onCommit,
}: {
  readonly request: T | null;
  readonly onCommit: (request: T) => void;
}) {
  useLayoutEffect(() => {
    if (request !== null) {
      onCommit(request);
    }
  }, [request, onCommit]);
  return null;
}
