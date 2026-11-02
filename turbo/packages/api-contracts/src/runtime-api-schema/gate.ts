import { isTransformableStatus } from "../client-transforms/select";
import type { ClientResponseTransform } from "../client-transforms/types";
import type { RuntimeApiCompatFinding } from "./compat";
import type { RuntimeApiRouteOwner } from "./routes";
import { stableStringify } from "./schema";

/*
 * Merge policy over runtime API compatibility findings. Findings on blocking
 * owners fail unless proven; native clients accept a floor raise (proof A) or a
 * registered response transform (proof B). See
 * docs/deployment-compatibility.md#desktop-contract-gate.
 */

export const DESKTOP_PUBLISHED_VERSION_ORACLE =
  "release tag version in the redirect from GET https://api.okou.ai/api/desktop/updates/stable/darwin/arm64/release";

export const IOS_PUBLISHED_VERSION_ORACLE =
  "ios-v* release commit with a successful publish-ios-testflight job and successful internal availability verification in release-please.yml";

type NativeOwner = "desktop" | "ios";
interface NativeClientPolicy {
  readonly owner: NativeOwner;
  readonly label: string;
  readonly floorFile: string;
  readonly transformsFile: string;
  readonly oracle: string;
}

const nativeClients: Readonly<Record<NativeOwner, NativeClientPolicy>> = {
  desktop: {
    owner: "desktop",
    label: "Desktop",
    floorFile: "turbo/apps/api/src/lib/desktop-compatibility.json",
    transformsFile:
      "turbo/packages/api-contracts/src/client-transforms/desktop.ts",
    oracle: DESKTOP_PUBLISHED_VERSION_ORACLE,
  },
  ios: {
    owner: "ios",
    label: "iOS",
    floorFile: "turbo/apps/api/src/lib/ios-client-compatibility.json",
    transformsFile: "turbo/packages/api-contracts/src/client-transforms/ios.ts",
    oracle: IOS_PUBLISHED_VERSION_ORACLE,
  },
};

/** The native client floor in the change under review and on the base branch. */
export interface NativeFloorChange {
  readonly floor: string | null;
  readonly baseFloor: string | null;
}

export interface RuntimeApiGateInput {
  /** Findings of the candidate schema against the production schema. */
  readonly findings: readonly RuntimeApiCompatFinding[];
  /**
   * Findings of the base commit's schema against the same production schema.
   * A blocking-owner finding that the base already has was introduced and
   * proven by an earlier change that has not reached production yet, so it
   * does not block this change. Omitted when no base schema is available.
   */
  readonly baseFindings?: readonly RuntimeApiCompatFinding[];
  readonly blockingOwners: ReadonlySet<RuntimeApiRouteOwner>;
  readonly desktopFloor?: NativeFloorChange;
  /** Published Desktop version; undefined when the oracle was unavailable. */
  readonly desktopPublishedVersion?: string;
  readonly desktopTransforms: readonly ClientResponseTransform[];
  readonly iosFloor?: NativeFloorChange;
  readonly iosPublishedVersion?: string;
  readonly iosTransforms?: readonly ClientResponseTransform[];
}

type RuntimeApiGateOutcome = "blocking" | "proven" | "inherited" | "warning";

interface RuntimeApiGateFinding extends RuntimeApiCompatFinding {
  readonly outcome: RuntimeApiGateOutcome;
  readonly resolution: string;
  /** The two accepted proofs; set for every native client finding. */
  readonly proofs?: string;
}

interface RuntimeApiGateError {
  readonly kind:
    | `${NativeOwner}-floor-invalid`
    | `${NativeOwner}-transform-invalid`
    | `${NativeOwner}-transform-unreachable`;
  readonly message: string;
}

export interface RuntimeApiGateResult {
  readonly passed: boolean;
  readonly findings: readonly RuntimeApiGateFinding[];
  readonly errors: readonly RuntimeApiGateError[];
}

type StableVersion = readonly [number, number, number];

type NativeFloorEvaluation =
  | { readonly kind: "unchanged" }
  | {
      readonly kind: "raised";
      readonly from: string | null;
      readonly to: string;
      readonly published: string;
    }
  | { readonly kind: "invalid"; readonly message: string };

interface ClassifyContext {
  readonly client: NativeClientPolicy;
  readonly blockingOwners: ReadonlySet<RuntimeApiRouteOwner>;
  readonly inherited: ReadonlySet<string>;
  readonly floor: NativeFloorEvaluation;
  readonly publishedVersion: string | undefined;
  readonly transforms: readonly ClientResponseTransform[];
}

export function evaluateRuntimeApiGate(
  input: RuntimeApiGateInput,
): RuntimeApiGateResult {
  const errors: RuntimeApiGateError[] = [];
  const desktop = nativeContext(input, nativeClients.desktop, errors);
  const ios = nativeContext(input, nativeClients.ios, errors);
  const findings = input.findings.map((finding) => {
    return classifyFinding(finding, finding.owner === "ios" ? ios : desktop);
  });

  return {
    passed:
      errors.length === 0 &&
      findings.every((finding) => {
        return finding.outcome !== "blocking";
      }),
    findings,
    errors,
  };
}

function nativeContext(
  input: RuntimeApiGateInput,
  client: NativeClientPolicy,
  errors: RuntimeApiGateError[],
): ClassifyContext {
  const change =
    client.owner === "desktop" ? input.desktopFloor : input.iosFloor;
  const publishedVersion =
    client.owner === "desktop"
      ? input.desktopPublishedVersion
      : input.iosPublishedVersion;
  const transforms =
    client.owner === "desktop"
      ? input.desktopTransforms
      : (input.iosTransforms ?? []);
  const floor = evaluateNativeFloor(change, publishedVersion, client);
  if (floor.kind === "invalid") {
    errors.push({
      kind: `${client.owner}-floor-invalid`,
      message: floor.message,
    });
  }
  errors.push(
    ...checkNativeTransforms(transforms, change?.floor ?? null, client),
  );
  return {
    client,
    floor,
    publishedVersion,
    transforms,
    blockingOwners: input.blockingOwners,
    inherited: new Set((input.baseFindings ?? []).map(findingKey)),
  };
}

export function renderRuntimeApiGateReport(
  result: RuntimeApiGateResult,
): string {
  if (result.findings.length === 0 && result.errors.length === 0) {
    return "Runtime API schema compatibility check passed.\n";
  }

  const sections = result.findings.map((finding, index) => {
    return [
      `Runtime API compatibility finding ${index + 1}/${result.findings.length}: ${finding.outcome}`,
      "",
      `Route: ${finding.route}`,
      `Owner: ${finding.owner}`,
      `Direction: ${finding.direction}`,
      `Path: ${finding.path}`,
      `Kind: ${finding.kind}`,
      "",
      `Problem: ${finding.problem}`,
      "",
      `Impact: ${finding.impact}`,
      "",
      `Suggested fix: ${finding.recommendation}`,
      ...(finding.proofs
        ? [
            "",
            `${finding.owner === "ios" ? "iOS" : "Desktop"} proofs: ${finding.proofs}`,
          ]
        : []),
      "",
      `Gate: ${finding.resolution}`,
      "",
      "Agent prompt:",
      finding.agentPrompt,
    ].join("\n");
  });
  for (const error of result.errors) {
    sections.push(
      `${error.kind.startsWith("ios-") ? "iOS" : "Desktop"} contract gate error (${error.kind})\n\n${error.message}`,
    );
  }

  return `${sections.join("\n\n---\n\n")}\n`;
}

export function renderRuntimeApiGateReportJson(
  result: RuntimeApiGateResult,
): string {
  return `${stableStringify(result)}\n`;
}

/** GitHub workflow commands: errors for what fails the gate, warnings otherwise. */
export function runtimeApiGateAnnotations(
  result: RuntimeApiGateResult,
): readonly string[] {
  const annotations = result.findings.map((finding) => {
    const message = oneLine(
      `${finding.route} ${finding.path}: ${finding.problem} Impact: ${finding.impact} ${finding.resolution}${finding.proofs ? ` ${finding.proofs}` : ""}`,
    );
    return finding.outcome === "blocking"
      ? `::error title=Runtime API compatibility break::${message}`
      : `::warning title=Runtime API compatibility (${finding.outcome})::${message}`;
  });
  for (const error of result.errors) {
    annotations.push(
      `::error title=${error.kind.startsWith("ios-") ? "iOS" : "Desktop"} contract gate::${oneLine(error.message)}`,
    );
  }
  return annotations;
}

export function parseStableVersion(value: string): StableVersion | undefined {
  if (!/^\d+\.\d+\.\d+$/u.test(value)) {
    return undefined;
  }
  const [major, minor, patch] = value.split(".").map(Number);
  if (
    major === undefined ||
    minor === undefined ||
    patch === undefined ||
    ![major, minor, patch].every(Number.isSafeInteger)
  ) {
    return undefined;
  }
  return [major, minor, patch];
}

function compareVersions(left: StableVersion, right: StableVersion): number {
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
}

function evaluateNativeFloor(
  change: NativeFloorChange | undefined,
  published: string | undefined,
  client: NativeClientPolicy,
): NativeFloorEvaluation {
  if (!change || change.floor === change.baseFloor) {
    return { kind: "unchanged" };
  }

  const { floor, baseFloor } = change;
  const summary = `${client.floorFile} changes minimumSupportedVersion from ${JSON.stringify(baseFloor)} to ${JSON.stringify(floor)}`;
  const invalid = (reason: string): NativeFloorEvaluation => {
    return { kind: "invalid", message: `${summary}, ${reason}` };
  };

  if (floor === null) {
    return invalid(
      `which removes the ${client.label} floor. The floor may only rise.`,
    );
  }
  const to = parseStableVersion(floor);
  if (!to) {
    return invalid("but the floor must be a stable x.y.z version.");
  }
  if (baseFloor !== null) {
    const from = parseStableVersion(baseFloor);
    if (!from) {
      return invalid(
        "but the base floor is not a stable x.y.z version, so the change cannot be checked.",
      );
    }
    if (compareVersions(to, from) < 0) {
      return invalid(
        "which lowers it below the base branch floor. The floor may only rise.",
      );
    }
  }
  if (published === undefined) {
    return invalid(
      `but the published ${client.label} version is unavailable, so the raise cannot be verified. Oracle: ${client.oracle}. Re-run the check once the oracle responds.`,
    );
  }
  const publishedVersion = parseStableVersion(published);
  if (!publishedVersion) {
    return invalid(
      `but the published ${client.label} version ${JSON.stringify(published)} from the oracle is not a stable x.y.z version. Oracle: ${client.oracle}.`,
    );
  }
  if (compareVersions(to, publishedVersion) > 0) {
    return invalid(
      `which is above the published ${client.label} version ${published}; users cannot update to it yet. Oracle: ${client.oracle}.`,
    );
  }
  return { kind: "raised", from: baseFloor, to: floor, published };
}

function checkNativeTransforms(
  transforms: readonly ClientResponseTransform[],
  floor: string | null,
  client: NativeClientPolicy,
): readonly RuntimeApiGateError[] {
  const errors: RuntimeApiGateError[] = [];
  const floorVersion = floor === null ? undefined : parseStableVersion(floor);

  for (const transform of transforms) {
    if (transform.maxVersion === null) {
      continue;
    }
    const label = `${transform.method} ${transform.path} ${transform.status} (since ${transform.since}) in ${client.transformsFile}`;
    const maxVersion = parseStableVersion(transform.maxVersion);
    if (!maxVersion) {
      errors.push({
        kind: `${client.owner}-transform-invalid`,
        message: `${client.label} transform ${label} has maxVersion ${JSON.stringify(transform.maxVersion)}; it must be null or a stable x.y.z version.`,
      });
      continue;
    }
    if (floorVersion && compareVersions(maxVersion, floorVersion) < 0) {
      errors.push({
        kind: `${client.owner}-transform-unreachable`,
        message: `${client.label} transform ${label} is unreachable, delete it: its maxVersion ${transform.maxVersion} is below the ${client.label} floor ${floor}, so no supported ${client.label} build receives the transformed shape.`,
      });
    }
  }
  return errors;
}

function classifyFinding(
  finding: RuntimeApiCompatFinding,
  context: ClassifyContext,
): RuntimeApiGateFinding {
  return {
    ...finding,
    ...classifyOutcome(finding, context),
    ...(finding.owner === "desktop" || finding.owner === "ios"
      ? {
          proofs: nativeProofs(
            finding,
            context.publishedVersion,
            context.client,
          ),
        }
      : {}),
  };
}

function classifyOutcome(
  finding: RuntimeApiCompatFinding,
  context: ClassifyContext,
): Pick<RuntimeApiGateFinding, "outcome" | "resolution"> {
  if (!context.blockingOwners.has(finding.owner)) {
    return {
      outcome: "warning",
      resolution: `Report only: ${finding.owner} findings do not block merges.`,
    };
  }

  if (context.inherited.has(findingKey(finding))) {
    return {
      outcome: "inherited",
      resolution:
        "The base commit already has this finding against the production schema. The change that introduced it carried its proof; it clears once that change reaches production.",
    };
  }

  if (finding.owner !== "desktop" && finding.owner !== "ios") {
    return {
      outcome: "blocking",
      resolution: `${finding.owner} findings block merges and accept no proof; keep the production contract.`,
    };
  }

  const client = context.client;
  if (context.floor.kind === "raised") {
    return {
      outcome: "proven",
      resolution: `Proof A: this change raises the ${client.label} floor in ${client.floorFile} from ${JSON.stringify(context.floor.from)} to ${context.floor.to}, not above the published ${client.label} version ${context.floor.published}. Review must confirm that ${context.floor.to} tolerates the new shape.`,
    };
  }

  const transform = transformProof(
    finding,
    context.transforms,
    context.publishedVersion,
    client,
  );
  if (transform.proof) {
    return {
      outcome: "proven",
      resolution: `Proof B: ${client.transformsFile} registers a response transform for ${finding.method} ${finding.routePath} ${finding.responseStatus} (since ${transform.proof.since}, maxVersion ${JSON.stringify(transform.proof.maxVersion)}).`,
    };
  }

  return {
    outcome: "blocking",
    resolution: [
      `Blocking: installed Okou ${client.label} builds decode ${client.label}-consumed routes strictly, and this change carries neither accepted proof.`,
      ...(transform.rejection ? [transform.rejection] : []),
    ].join(" "),
  };
}

function transformProof(
  finding: RuntimeApiCompatFinding,
  transforms: readonly ClientResponseTransform[],
  published: string | undefined,
  client: NativeClientPolicy,
): {
  readonly proof?: ClientResponseTransform;
  readonly rejection?: string;
} {
  const status = transformableStatus(finding);
  if (status === undefined) {
    return {};
  }

  const matches = transforms.filter((transform) => {
    return (
      transform.client === client.owner &&
      transform.method === finding.method &&
      transform.path === finding.routePath &&
      transform.status === status
    );
  });
  const publishedVersion =
    published === undefined ? undefined : parseStableVersion(published);
  const rejections: string[] = [];

  for (const transform of matches) {
    if (transform.maxVersion === null) {
      return { proof: transform };
    }
    const maxVersion = parseStableVersion(transform.maxVersion);
    if (!publishedVersion) {
      rejections.push(
        `The matching transform (since ${transform.since}) has maxVersion ${transform.maxVersion}, but the published ${client.label} version is unavailable, so it cannot be verified. Oracle: ${client.oracle}.`,
      );
      continue;
    }
    if (maxVersion && compareVersions(maxVersion, publishedVersion) >= 0) {
      return { proof: transform };
    }
    rejections.push(
      `The matching transform (since ${transform.since}) has maxVersion ${transform.maxVersion}, below the published ${client.label} version ${published}, so published builds above it would receive the new shape.`,
    );
  }

  return rejections.length > 0 ? { rejection: rejections.join(" ") } : {};
}

function nativeProofs(
  finding: RuntimeApiCompatFinding,
  published: string | undefined,
  client: NativeClientPolicy,
): string {
  const publishedLabel =
    published === undefined
      ? `the published ${client.label} version (${client.oracle})`
      : `the published ${client.label} version ${published}`;
  const status = transformableStatus(finding);
  const unprovable =
    finding.responseStatus === undefined
      ? `a ${finding.direction}-level finding`
      : `a non-2xx (${finding.responseStatus}) response finding, because the API transforms only 2xx bodies`;
  const proofB =
    status === undefined
      ? `(B) a response transform in ${client.transformsFile}, which cannot prove ${unprovable}; use (A) or keep the production contract.`
      : `(B) register a response transform for ${finding.method} ${finding.routePath} ${status} in ${client.transformsFile} with maxVersion null or at least ${publishedLabel}.`;

  return [
    `A breaking change here needs one proof in the same PR: (A) raise minimumSupportedVersion in ${client.floorFile} to a stable x.y.z version that is not lower than the base branch floor, not above ${publishedLabel}, and already tolerates the new shape; or`,
    proofB,
  ].join(" ");
}

/** The response status a transform could prove, if the finding has one. */
function transformableStatus(
  finding: RuntimeApiCompatFinding,
): number | undefined {
  const status = finding.responseStatus;
  return status !== undefined && isTransformableStatus(status)
    ? status
    : undefined;
}

function findingKey(finding: RuntimeApiCompatFinding): string {
  return [finding.routeId, finding.direction, finding.path, finding.kind].join(
    "\u0000",
  );
}

function oneLine(value: string): string {
  return value.replace(/\s*\n\s*/gu, " ");
}
