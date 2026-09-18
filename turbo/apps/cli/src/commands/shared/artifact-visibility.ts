import { Option } from "commander";
import type { ArtifactShareTarget } from "@okouai/api-contracts/contracts/artifact-shares";
import {
  getArtifactSharingAvailability,
  setArtifactAudience,
} from "../../lib/api/domains/artifact-shares";
import { decodeSandboxTokenPayload } from "../../lib/api/sandbox-token";
import { assertPrivateArtifactUrl } from "../../lib/artifact-url";

export type ArtifactVisibility = "only-me" | "org" | "public";

export function createArtifactVisibilityOption(): Option {
  return new Option(
    "--visibility <visibility>",
    "Who can access the result (requires privateArtifacts; defaults to only-me when enabled)",
  ).choices(["only-me", "org", "public"]);
}

/** Omission retains the server's existing, feature-gated creation policy. */
export async function prepareArtifactVisibility(
  visibility: ArtifactVisibility | undefined,
): Promise<true | undefined> {
  if (visibility === undefined) return undefined;

  const capabilities = decodeSandboxTokenPayload()?.capabilities;
  const required =
    visibility === "only-me"
      ? ["artifact:read"]
      : ["artifact:read", "artifact:write"];
  if (
    capabilities &&
    required.some((value) => {
      return !capabilities.includes(value);
    })
  ) {
    throw new Error(
      "--visibility requires a new run with privateArtifacts enabled and artifact sharing capabilities.",
    );
  }
  if (!(await getArtifactSharingAvailability()).enabled) {
    throw new Error("--visibility requires privateArtifacts to be enabled.");
  }
  return true;
}

/** Apply sharing only after creation; a failed share must never retry creation. */
export async function applyArtifactVisibility<
  T extends { readonly url: string },
>(
  result: T,
  target: ArtifactShareTarget,
  visibility: ArtifactVisibility | undefined,
): Promise<T & { visibility?: ArtifactVisibility; ownerUrl?: string }> {
  if (visibility === undefined) return result;

  await assertPrivateArtifactUrl(result.url);

  // New private artifacts are owner-only. Keep any existing sharing policy
  // unchanged when the caller requests a private publication.
  if (visibility === "only-me") {
    return { ...result, visibility, ownerUrl: result.url };
  }

  try {
    const status = await setArtifactAudience(
      target,
      visibility === "org" ? "organization" : "public",
    );
    const sharingUrl = status.shortUrl ?? status.url;
    if (!sharingUrl) {
      throw new Error("The API did not return a sharing URL.");
    }
    return {
      ...result,
      url: status.ownerUrl,
      visibility,
      ownerUrl: status.ownerUrl,
    };
  } catch (cause) {
    throw new Error(
      `The artifact was created at ${result.url}, but setting visibility failed. Read its current state with okou artifact ${target.id} --kind ${target.kind} --json before retrying the visibility change. Do not repeat the upload, hosting, or generation.`,
      { cause },
    );
  }
}
