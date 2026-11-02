import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  marketingHandoffManifestSchema,
  serializeMarketingHandoff,
} from "../marketing-handoffs";
import vectors from "./fixtures/marketing-handoff-v1.json";

// Keep these protocol vectors identical to vm0-marketing/tests/fixtures.
describe("Marketing handoff v1 wire identity", () => {
  it.each(vectors)(
    "matches the published $hash digest",
    ({ hash, manifest }) => {
      const body = serializeMarketingHandoff(
        marketingHandoffManifestSchema.parse(manifest),
      );
      expect(createHash("sha256").update(body).digest("hex")).toBe(hash);
    },
  );
});
