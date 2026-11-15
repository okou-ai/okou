import { string } from "zod";

/** Android publishes stable x.y.z versions. Compare components numerically, without APK codes. */
export const androidVersionSchema = string()
  .max(64)
  // Require the absolute end: JavaScript's $ also accepts a trailing newline.
  .regex(/^[0-9]+\.[0-9]+\.[0-9]+(?![\s\S])/u);

export function compareAndroidVersions(
  left: string,
  right: string,
): number | null {
  if (
    !androidVersionSchema.safeParse(left).success ||
    !androidVersionSchema.safeParse(right).success
  ) {
    return null;
  }
  const rightParts = right.split(".").map(BigInt);
  for (const [index, part] of left.split(".").entries()) {
    const other = rightParts[index];
    if (other === undefined) {
      throw new Error("Android version must have three components");
    }
    const value = BigInt(part);
    if (value !== other) {
      return value < other ? -1 : 1;
    }
  }
  return 0;
}
