import type { ArtifactShareStatus } from "@okouai/api-contracts/contracts/artifact-shares";
import { artifactReferencePath } from "@okouai/api-contracts/contracts/artifact-references";
import { http, HttpResponse } from "msw";
import { expect } from "vitest";
import { server } from "../../../mocks/server";

export const GENERATION_ARTIFACT_ID = "00000000-0000-4000-8000-000000000001";
export const AVAILABILITY_URL =
  "http://localhost:3000/api/artifact-shares/availability";

export function serveGenerationVisibility(
  filename: string,
  visibility: "only-me" | "org" | "public",
) {
  const target = { kind: "file" as const, id: GENERATION_ARTIFACT_ID };
  const reference = artifactReferencePath(target.id, filename);
  const ownerUrl = `https://app.okou.ai${reference}`;
  const url =
    visibility === "public"
      ? `https://a.okou.io/generated1.${filename.split(".").at(-1)}`
      : ownerUrl;
  const status: ArtifactShareStatus = {
    ownerUrl,
    shareId: null,
    audience: "private",
    organization: { id: "org_original", name: "Original organization" },
    selectedTarget: null,
    selectedVersion: null,
    candidateVersion: null,
    url: null,
    shortUrl: null,
  };
  server.use(
    http.get(AVAILABILITY_URL, () => {
      return HttpResponse.json({ enabled: true });
    }),
  );
  if (visibility !== "only-me") {
    server.use(
      http.post(
        "http://localhost:3000/api/artifact-shares/status",
        async ({ request }) => {
          expect(await request.json()).toEqual(target);
          return HttpResponse.json(status);
        },
      ),
      http.put(
        "http://localhost:3000/api/artifact-shares",
        async ({ request }) => {
          const audience = visibility === "org" ? "organization" : "public";
          expect(await request.json()).toEqual({ target, audience });
          return HttpResponse.json({
            ...status,
            shareId: "00000000-0000-4000-8000-000000000002",
            audience,
            selectedTarget: target,
            url,
            shortUrl: visibility === "org" ? url : null,
          });
        },
      ),
    );
  }
  return { ownerUrl, url, reference };
}
