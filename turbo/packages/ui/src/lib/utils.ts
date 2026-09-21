import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * The `-or-` / `-offset-` halves of the safe-area utilities. `safe` on its own
 * is registered as a spacing scale value, but `safe-or-8` is not a scale value,
 * so its group needs an explicit validator. A class the merger cannot classify
 * has no group, therefore never conflicts, and both copies survive — which
 * hands the outcome back to stylesheet order and defeats the point of `cn()`.
 */
function isSafeAreaVariant(value: string): boolean {
  return /^safe-(or|offset)-(\d+(\.\d+)?|\[.+\])$/.test(value);
}

const mergeUtilities = extendTailwindMerge({
  extend: {
    theme: {
      radius: ["surface", "surface-compact"],
      shadow: ["surface"],
      spacing: ["safe"],
    },
    classGroups: {
      p: [{ p: [isSafeAreaVariant] }],
      pt: [{ pt: [isSafeAreaVariant] }],
      pr: [{ pr: [isSafeAreaVariant] }],
      pb: [{ pb: [isSafeAreaVariant] }],
      pl: [{ pl: [isSafeAreaVariant] }],
      mb: [{ mb: [isSafeAreaVariant] }],
      top: [{ top: [isSafeAreaVariant] }],
      right: [{ right: [isSafeAreaVariant] }],
      bottom: [{ bottom: [isSafeAreaVariant] }],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return mergeUtilities(clsx(inputs));
}
