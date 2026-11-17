import { describe, expect, it } from "vitest";
import { fromJSONSchema, type core } from "zod";
import {
  iosProjectSortOrderTransform,
  androidProjectSortOrderTransform,
} from "../project-sort-order";
import previousJsonSchema from "./fixtures/project-events-2026-11-17.json";

// runtime-api-schema-prod/current.json, release asset 759196377, retrieved
// 2026-11-17. iOS and Android share this production Project events response.
const previousSchema = fromJSONSchema(
  previousJsonSchema as core.JSONSchema.JSONSchema,
);
const projectId = "00000000-0000-4000-8000-000000000001";
const created = {
  id: "00000000-0000-4000-8000-000000000002",
  seqId: 1,
  projectId,
  kind: "created",
  name: "Campaign",
  createdAt: "2026-11-17T00:00:00.000Z",
};
const sorted = {
  ...created,
  id: "00000000-0000-4000-8000-000000000003",
  seqId: 2,
  kind: "sort_updated",
  sortOrder: "Zz",
};
const renamed = {
  ...created,
  id: "00000000-0000-4000-8000-000000000004",
  seqId: 3,
  kind: "renamed",
  name: "Renamed Campaign",
  sortOrder: "Zz",
};

describe.each([iosProjectSortOrderTransform, androidProjectSortOrderTransform])(
  "$client Project sorting compatibility",
  (transform) => {
    it("preserves event identities, pagination and names for the production reader", () => {
      const current = { events: [created, sorted, renamed], hasMore: true };
      expect(previousSchema.safeParse(current).success).toBe(false);
      const transformed = transform.transform(current);
      expect(previousSchema.safeParse(transformed).success).toBe(true);
      expect(transformed).toStrictEqual({
        events: [
          created,
          { ...created, id: sorted.id, seqId: 2, kind: "renamed" },
          {
            ...created,
            id: renamed.id,
            seqId: 3,
            kind: "renamed",
            name: "Renamed Campaign",
          },
        ],
        hasMore: true,
      });
    });
  },
);
