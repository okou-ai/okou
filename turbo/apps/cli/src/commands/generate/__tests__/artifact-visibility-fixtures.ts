import type { ArtifactVisibilityResponse } from "@okouai/api-contracts/contracts/artifact-access";
import { artifactReferencePath } from "@okouai/api-contracts/contracts/artifact-references";
import { http, HttpResponse } from "msw";
import { expect } from "vitest";
import { server } from "../../../mocks/server";

export const GENERATION_ARTIFACT_ID = "00000000-0000-4000-8000-000000000001";

export function serveGenerationVisibility(
  filename: string,
  visibility: "only-me" | "org" | "public",
) {
  const reference = artifactReferencePath(GENERATION_ARTIFACT_ID, filename);
  const ownerUrl = `https://app.okou.ai${reference}`;
  const sharingUrl =
    visibility === "public"
      ? `https://a.okou.io/generated1.${filename.split(".").at(-1)}`
      : ownerUrl;
  const current: ArtifactVisibilityResponse = {
    artifactId: GENERATION_ARTIFACT_ID,
    kind: "file",
    visibility: "private",
    ownerUrl,
    shareUrl: null,
    shortUrl: null,
    organization: { id: "org_original", name: "Original organization" },
  };
  if (visibility !== "only-me") {
    server.use(
      http.get(
        `http://localhost:3000/api/artifacts/${GENERATION_ARTIFACT_ID}/visibility`,
        () => {
          return HttpResponse.json(current);
        },
      ),
      http.patch(
        `http://localhost:3000/api/artifacts/${GENERATION_ARTIFACT_ID}/visibility`,
        async ({ request }) => {
          const expected = visibility === "org" ? "organization" : "public";
          expect(await request.json()).toEqual({ visibility: expected });
          return HttpResponse.json({
            ...current,
            visibility: expected,
            shareUrl: sharingUrl,
            shortUrl: visibility === "org" ? sharingUrl : null,
          });
        },
      ),
    );
  }
  return { ownerUrl, url: ownerUrl, sharingUrl, reference };
}
