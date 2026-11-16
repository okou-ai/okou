import { describe, expect, it } from "vitest";
import vectors from "../fixtures/android-versions.json";
import {
  androidVersionSchema,
  compareAndroidVersions,
} from "../android-version";

describe("Android version ordering shared with APK publication and native policy", () => {
  it.each(vectors.comparisons)(
    "orders $left and $right",
    ({ left, right, order }) => {
      expect(compareAndroidVersions(left, right)).toBe(order);
      expect(compareAndroidVersions(right, left)).toBe(
        order === 0 ? 0 : -order,
      );
    },
  );

  it.each(vectors.invalid)(
    "rejects an invalid stable version %j",
    (version) => {
      expect(androidVersionSchema.safeParse(version).success).toBe(false);
      expect(compareAndroidVersions(version, "1.2.3")).toBeNull();
      expect(compareAndroidVersions("1.2.3", version)).toBeNull();
    },
  );
});
