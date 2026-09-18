import { Command, Option } from "commander";
import type {
  ArtifactShareStatus,
  ArtifactShareTarget,
} from "@okouai/api-contracts/contracts/artifact-shares";
import {
  getArtifactShareStatus,
  resolveArtifactShareTarget,
  setArtifactAudience,
} from "../../lib/api/domains/artifact-shares";
import { withErrorHandler } from "../../lib/command/with-error-handler";
import { createDownloadFileCommand } from "../web/download-file";

const audiences = {
  "only-me": "private",
  org: "organization",
  public: "public",
} as const;
type Visibility = keyof typeof audiences;

const visibilities: Record<ArtifactShareStatus["audience"], Visibility> = {
  private: "only-me",
  organization: "org",
  public: "public",
};

interface ArtifactOptions {
  readonly visibility?: Visibility;
  readonly kind?: ArtifactShareTarget["kind"];
  readonly json?: boolean;
}

function printStatus(status: ArtifactShareStatus, json: boolean | undefined) {
  const result = {
    visibility: visibilities[status.audience],
    url:
      status.audience === "private"
        ? status.ownerUrl
        : (status.shortUrl ?? status.url),
    organization: status.organization,
    selectedTarget: status.selectedTarget,
  };
  if (json) {
    console.log(JSON.stringify(result));
    return;
  }
  console.log(`Visibility: ${result.visibility}`);
  console.log(`Organization: ${result.organization.name}`);
  if (status.audience !== "private" && result.selectedTarget) {
    console.log(
      `Shared artifact: ${result.selectedTarget.kind} ${result.selectedTarget.id}`,
    );
  }
  if (result.url) {
    console.log(`URL: ${result.url}`);
  } else {
    console.log(
      `Run okou artifact <artifact> --visibility ${result.visibility} to allocate its link.`,
    );
  }
}

export const artifactCommand = new Command("artifact")
  .description("Read or set an owned artifact's visibility and return its URL")
  .argument("<artifact>", "Owned /artifacts/<reference> path or artifact URL")
  .addOption(
    new Option(
      "--visibility <visibility>",
      "Set who can access the artifact",
    ).choices(["only-me", "org", "public"]),
  )
  .addOption(
    new Option(
      "--kind <kind>",
      "Use a file or hosted deployment UUID instead of a reference",
    ).choices(["file", "html"]),
  )
  .option("--json", "Output visibility, URL, and artifact identity as JSON")
  .addCommand(createDownloadFileCommand("download", "okou artifact download"))
  .addHelpText(
    "after",
    `
Examples:
  Read visibility:    okou artifact /artifacts/abc123def4.pdf --json
  Only me:            okou artifact /artifacts/abc123def4.pdf --visibility only-me
  Organization:       okou artifact /artifacts/abc123def4.pdf --visibility org
  Public:             okou artifact /artifacts/abc123def4.html --visibility public
  Download a file:    okou artifact download /artifacts/abc123def4.pdf -o /tmp/report.pdf
  Download a site:    okou artifact download /artifacts/abc123def4.html -o /tmp/site
  Use a file ID:      okou artifact <file-id> --kind file --visibility org
  Use a deployment:   okou artifact <deployment-id> --kind html --visibility public

Notes:
  - Without --visibility, read the current visibility and URL without changing permissions
  - only-me revokes sharing and returns the stable owner URL
  - org requires current membership in the artifact's original organization
  - public allows anyone with the returned link to access the shared artifact
  - Uses OKOU_TOKEN; reading visibility requires artifact:read and setting it also requires artifact:write
  - Downloads use artifact:read for owned, organization-shared, or public references under their current access policy; raw file IDs use file:read
  - Hosted sites download all pages and assets into --out as a directory, preserving the authorized publication
  - Download parameters match okou web download-file; see okou artifact download -h
  - Visibility capabilities are issued to new runs with privateArtifacts enabled
  - Only the owner in the original organization can manage an artifact's visibility
  - Change visibility only when the user requests it; uploads, generation, and hosting retain their existing privacy
  - There is one active audience. Switching to org or only-me revokes the old public link
  - Previously issued temporary previews retain their expiration; downloaded content cannot be recalled
  - Repeating the same visibility for the same artifact reuses the existing URL, including links created by the Share button
  - Every new hosted publication requires its own explicit --visibility org or public to be shared
  - Older organization shares without a short link return no URL until visibility is explicitly set
  - Return the exact URL printed by the command, never a temporary preview URL
  - If an update fails, rerun without --visibility before retrying; the permission change may have applied`,
  )
  .action(
    withErrorHandler(async (artifact: string, options: ArtifactOptions) => {
      const target = await resolveArtifactShareTarget(artifact, options.kind);
      const status = options.visibility
        ? await setArtifactAudience(target, audiences[options.visibility])
        : await getArtifactShareStatus(target);
      printStatus(status, options.json);
    }),
  );
