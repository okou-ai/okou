import { Command, Option } from "commander";
import type {
  ArtifactShareStatus,
  ArtifactShareTarget,
} from "@okouai/api-contracts/contracts/artifact-shares";
import {
  getArtifactShareStatus,
  resolveArtifactShareTarget,
  shareArtifact,
} from "../../lib/api/domains/artifact-shares";
import { withErrorHandler } from "../../lib/command/with-error-handler";

interface ArtifactOptions {
  readonly kind?: ArtifactShareTarget["kind"];
  readonly json?: boolean;
}

function printStatus(status: ArtifactShareStatus, json: boolean | undefined) {
  if (json) {
    console.log(JSON.stringify(status));
    return;
  }
  console.log(`Audience: ${status.audience}`);
  console.log(`Organization: ${status.organization.name}`);
  if (status.selectedVersion !== null) {
    console.log(`Shared version: ${status.selectedVersion}`);
  }
  if (status.candidateVersion !== null) {
    console.log(`Requested version: ${status.candidateVersion}`);
  }
  const url = status.shortUrl ?? status.url;
  if (url) {
    console.log(`URL: ${url}`);
  } else if (status.audience === "private") {
    console.log(
      "Only the owner can access this artifact; there is no active share link.",
    );
  } else {
    console.log(
      "Run okou artifact share with the desired audience to allocate its link.",
    );
  }
}

function artifactCommandFor(name: string, description: string): Command {
  return new Command(name)
    .description(description)
    .argument("<artifact>", "Owned /artifacts/<reference> path or artifact URL")
    .addOption(
      new Option(
        "--kind <kind>",
        "Use a file or hosted deployment UUID instead of a reference",
      ).choices(["file", "html"]),
    )
    .option("--json", "Output only the sharing status as JSON");
}

const statusCommand = artifactCommandFor(
  "status",
  "Read sharing state without changing permissions",
).action(
  withErrorHandler(async (artifact: string, options: ArtifactOptions) => {
    const target = await resolveArtifactShareTarget(artifact, options.kind);
    printStatus(await getArtifactShareStatus(target), options.json);
  }),
);

const shareCommand = artifactCommandFor(
  "share",
  "Set the selected version's audience and return its share link",
)
  .addOption(
    new Option("--audience <audience>", "Who can access the artifact")
      .choices(["organization", "public", "private"])
      .makeOptionMandatory(),
  )
  .addHelpText(
    "after",
    `
Notes:
  - organization requires current membership in the artifact's original organization
  - public allows anyone with the returned link to access the selected version
  - private stops sharing; already downloaded content cannot be recalled
  - Previously issued temporary previews retain their existing expiration
  - There is one active audience. Switching to organization or private revokes the old public link
  - Repeating the same audience and version reuses the existing link, including links created by the Share button
  - Sharing a newer hosted version requires an explicit share command
  - If a request fails, read status before retrying; the permission change may have applied`,
  )
  .action(
    withErrorHandler(
      async (
        artifact: string,
        options: ArtifactOptions & {
          readonly audience: ArtifactShareStatus["audience"];
        },
      ) => {
        const target = await resolveArtifactShareTarget(artifact, options.kind);
        printStatus(
          await shareArtifact(target, options.audience),
          options.json,
        );
      },
    ),
  );

export const artifactCommand = new Command("artifact")
  .description("Inspect and change sharing for owned private artifacts")
  .addCommand(statusCommand)
  .addCommand(shareCommand)
  .addHelpText(
    "after",
    `
Examples:
  Read sharing:       okou artifact status /artifacts/abc123def4.pdf --json
  Share to org:       okou artifact share /artifacts/abc123def4.pdf --audience organization
  Share to Public:    okou artifact share /artifacts/abc123def4.html --audience public
  Stop sharing:       okou artifact share /artifacts/abc123def4.html --audience private
  Use a file ID:      okou artifact share <file-id> --kind file --audience organization
  Use a deployment:   okou artifact share <deployment-id> --kind html --audience public

Notes:
  - Requires OKOU_TOKEN with artifact:read; changing sharing also requires artifact:write
  - These capabilities are available to new runs with privateArtifacts enabled
  - Only the owner in the original organization can manage an artifact's sharing
  - Uploading, generating, and hosting keep their existing privacy; share only when the user requests it
  - Return the exact URL printed by the command; it uses the same sharing policy as the Share button`,
  );
