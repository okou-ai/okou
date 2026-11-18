import { describe, expect, it } from "vitest";
import { fromJSONSchema, type core } from "zod";
import { projectsContract } from "../../contracts/projects";
import { iosResponseTransforms } from "../ios";
import { selectClientResponseTransforms } from "../select";
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

describe("iOS Project sorting transform selection", () => {
  it.each([
    { version: "0.47.4", expected: [iosProjectSortOrderTransform] },
    { version: "0.47.5", expected: [] },
  ])(
    "selects the published-version boundary for $version",
    ({ version, expected }) => {
      expect(
        selectClientResponseTransforms({
          transforms: iosResponseTransforms,
          client: "iOS",
          version,
          method: projectsContract.events.method,
          path: projectsContract.events.path,
          status: 200,
        }),
      ).toStrictEqual(expected);
    },
  );
});

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
