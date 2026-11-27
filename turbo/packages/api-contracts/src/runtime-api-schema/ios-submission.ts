import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { selectClientResponseTransforms } from "../client-transforms/select";
import type { ClientResponseTransform } from "../client-transforms/types";
import { CLIENT_TYPE_IOS } from "../contracts/client-headers";
import { iosBuildIdentitySchema } from "../contracts/ios-client-compatibility";
import { compareRuntimeApiSchemas } from "./compat";
import { iosFloorAbove } from "./ios-policy";
import {
  readRuntimeApiSchemaDocument,
  type RuntimeApiSchemaDocument,
} from "./schema";

export async function checkIosSubmission(
  buildPath: string,
  candidate: RuntimeApiSchemaDocument,
  appStoreMinimum: string | null,
  transforms: readonly ClientResponseTransform[],
): Promise<string[]> {
  const build = iosBuildIdentitySchema.parse(
    JSON.parse(await readFile(buildPath, "utf8")),
  );
  const submitted = await readRuntimeApiSchemaDocument(
    join(dirname(buildPath), `${build.commit}.json.gz`),
  );
  const label = `Submitted iOS ${build.version} (${build.build})`;
  if (
    !submitted.routes.length ||
    submitted.routes.some((route) => {
      return route.owner !== "ios";
    })
  ) {
    throw new Error(`${label} needs a nonempty iOS-only API snapshot.`);
  }

  const errors: string[] = [];
  if (iosFloorAbove(appStoreMinimum, build.version)) {
    errors.push(
      `${label} would receive HTTP 426 from App Store minimum ${appStoreMinimum}.`,
    );
  }
  const iosCandidate = {
    ...candidate,
    routes: candidate.routes.filter((route) => {
      return route.owner === "ios";
    }),
  };
  for (const finding of compareRuntimeApiSchemas(submitted, iosCandidate)) {
    // Only a transform selected by the runtime for a known success status
    // can preserve this build's response body.
    if (
      finding.responseStatus !== undefined &&
      finding.kind !== "response-status-added" &&
      selectClientResponseTransforms({
        transforms,
        client: CLIENT_TYPE_IOS,
        version: build.version,
        method: finding.method,
        path: finding.routePath,
        status: finding.responseStatus,
      }).length > 0
    ) {
      continue;
    }
    errors.push(
      `${label}: ${finding.route} has an incompatible ${finding.direction} change at ${finding.path} (${finding.kind}).`,
    );
  }
  return errors;
}
