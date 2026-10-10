import type { ClientResponseTransform } from "../client-transforms/types";
import type { RuntimeApiCompatFinding } from "./compat";
import type { RuntimeApiRouteOwner } from "./routes";
import { stableStringify } from "./schema";

/*
 * Merge policy over runtime API compatibility findings. Findings on blocking
 * owners fail unless proven; Desktop accepts a floor raise (proof A) or a
 * registered response transform (proof B). See
 * docs/deployment-compatibility.md#desktop-contract-gate.
 */

const DESKTOP_FLOOR_FILE = "turbo/apps/api/src/lib/desktop-compatibility.json";
const DESKTOP_TRANSFORMS_FILE =
  "turbo/packages/api-contracts/src/client-transforms/desktop.ts";
export const DESKTOP_PUBLISHED_VERSION_ORACLE =
  "currentRelease of GET https://api.okou.ai/api/desktop/updates/ai-okou-desktop/stable/darwin/arm64/RELEASES.json";

/** The Desktop floor in the change under review and on the base branch. */
export interface DesktopFloorChange {
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
  readonly desktopFloor?: DesktopFloorChange;
  /** Published Desktop version; undefined when the oracle was unavailable. */
  readonly desktopPublishedVersion?: string;
  readonly desktopTransforms: readonly ClientResponseTransform[];
}

type RuntimeApiGateOutcome = "blocking" | "proven" | "inherited" | "warning";

interface RuntimeApiGateFinding extends RuntimeApiCompatFinding {
  readonly outcome: RuntimeApiGateOutcome;
  readonly resolution: string;
  /** The two accepted proofs; set for every Desktop finding. */
  readonly proofs?: string;
}

interface RuntimeApiGateError {
  readonly kind:
    | "desktop-floor-invalid"
    | "desktop-transform-invalid"
    | "desktop-transform-unreachable";
  readonly message: string;
}

export interface RuntimeApiGateResult {
  readonly passed: boolean;
  readonly findings: readonly RuntimeApiGateFinding[];
  readonly errors: readonly RuntimeApiGateError[];
}

type StableVersion = readonly [number, number, number];

type DesktopFloorEvaluation =
  | { readonly kind: "unchanged" }
  | {
      readonly kind: "raised";
      readonly from: string | null;
      readonly to: string;
      readonly published: string;
    }
  | { readonly kind: "invalid"; readonly message: string };

interface ClassifyContext {
  readonly blockingOwners: ReadonlySet<RuntimeApiRouteOwner>;
  readonly inherited: ReadonlySet<string>;
  readonly floor: DesktopFloorEvaluation;
  readonly publishedVersion: string | undefined;
  readonly transforms: readonly ClientResponseTransform[];
}

export function evaluateRuntimeApiGate(
  input: RuntimeApiGateInput,
): RuntimeApiGateResult {
  const errors: RuntimeApiGateError[] = [];
  const floor = evaluateDesktopFloor(
    input.desktopFloor,
    input.desktopPublishedVersion,
  );
  if (floor.kind === "invalid") {
    errors.push({ kind: "desktop-floor-invalid", message: floor.message });
  }
  errors.push(
    ...checkDesktopTransforms(
      input.desktopTransforms,
      input.desktopFloor?.floor ?? null,
    ),
  );

  const context: ClassifyContext = {
    blockingOwners: input.blockingOwners,
    inherited: new Set((input.baseFindings ?? []).map(findingKey)),
    floor,
    publishedVersion: input.desktopPublishedVersion,
    transforms: input.desktopTransforms,
  };
  const findings = input.findings.map((finding) => {
    return classifyFinding(finding, context);
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
      ...(finding.proofs ? ["", `Desktop proofs: ${finding.proofs}`] : []),
      "",
      `Gate: ${finding.resolution}`,
      "",
      "Agent prompt:",
      finding.agentPrompt,
    ].join("\n");
  });
  for (const error of result.errors) {
    sections.push(
      `Desktop contract gate error (${error.kind})\n\n${error.message}`,
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
      `::error title=Desktop contract gate::${oneLine(error.message)}`,
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

function evaluateDesktopFloor(
  change: DesktopFloorChange | undefined,
  published: string | undefined,
): DesktopFloorEvaluation {
  if (!change || change.floor === change.baseFloor) {
    return { kind: "unchanged" };
  }

  const { floor, baseFloor } = change;
  const summary = `${DESKTOP_FLOOR_FILE} changes minimumSupportedVersion from ${JSON.stringify(baseFloor)} to ${JSON.stringify(floor)}`;
  const invalid = (reason: string): DesktopFloorEvaluation => {
    return { kind: "invalid", message: `${summary}, ${reason}` };
  };

  if (floor === null) {
    return invalid("which removes the Desktop floor. The floor may only rise.");
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
      `but the published Desktop version is unavailable, so the raise cannot be verified. Oracle: ${DESKTOP_PUBLISHED_VERSION_ORACLE}. Re-run the check once the oracle responds.`,
    );
  }
  const publishedVersion = parseStableVersion(published);
  if (!publishedVersion) {
    return invalid(
      `but the published Desktop version ${JSON.stringify(published)} from the oracle is not a stable x.y.z version. Oracle: ${DESKTOP_PUBLISHED_VERSION_ORACLE}.`,
    );
  }
  if (compareVersions(to, publishedVersion) > 0) {
    return invalid(
      `which is above the published Desktop version ${published}; users cannot update to it yet. Oracle: ${DESKTOP_PUBLISHED_VERSION_ORACLE}.`,
    );
  }
  return { kind: "raised", from: baseFloor, to: floor, published };
}

function checkDesktopTransforms(
  transforms: readonly ClientResponseTransform[],
  floor: string | null,
): readonly RuntimeApiGateError[] {
  const errors: RuntimeApiGateError[] = [];
  const floorVersion = floor === null ? undefined : parseStableVersion(floor);

  for (const transform of transforms) {
    if (transform.maxVersion === null) {
      continue;
    }
    const label = `${transform.method} ${transform.path} ${transform.status} (since ${transform.since}) in ${DESKTOP_TRANSFORMS_FILE}`;
    const maxVersion = parseStableVersion(transform.maxVersion);
    if (!maxVersion) {
      errors.push({
        kind: "desktop-transform-invalid",
        message: `Desktop transform ${label} has maxVersion ${JSON.stringify(transform.maxVersion)}; it must be null or a stable x.y.z version.`,
      });
      continue;
    }
    if (floorVersion && compareVersions(maxVersion, floorVersion) < 0) {
      errors.push({
        kind: "desktop-transform-unreachable",
        message: `Desktop transform ${label} is unreachable, delete it: its maxVersion ${transform.maxVersion} is below the Desktop floor ${floor}, so no supported Desktop build receives the transformed shape.`,
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
    ...(finding.owner === "desktop"
      ? { proofs: desktopProofs(finding, context.publishedVersion) }
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

  if (finding.owner !== "desktop") {
    return {
      outcome: "blocking",
      resolution: `${finding.owner} findings block merges and accept no proof; keep the production contract.`,
    };
  }

  if (context.floor.kind === "raised") {
    return {
      outcome: "proven",
      resolution: `Proof A: this change raises the Desktop floor in ${DESKTOP_FLOOR_FILE} from ${JSON.stringify(context.floor.from)} to ${context.floor.to}, not above the published Desktop version ${context.floor.published}. Review must confirm that ${context.floor.to} tolerates the new shape.`,
    };
  }

  const transform = transformProof(
    finding,
    context.transforms,
    context.publishedVersion,
  );
  if (transform.proof) {
    return {
      outcome: "proven",
      resolution: `Proof B: ${DESKTOP_TRANSFORMS_FILE} registers a response transform for ${finding.method} ${finding.routePath} ${finding.responseStatus} (since ${transform.proof.since}, maxVersion ${JSON.stringify(transform.proof.maxVersion)}).`,
    };
  }

  return {
    outcome: "blocking",
    resolution: [
      "Blocking: installed Okou Desktop builds decode Desktop-consumed routes strictly, and this change carries neither accepted proof.",
      ...(transform.rejection ? [transform.rejection] : []),
    ].join(" "),
  };
}

function transformProof(
  finding: RuntimeApiCompatFinding,
  transforms: readonly ClientResponseTransform[],
  published: string | undefined,
): {
  readonly proof?: ClientResponseTransform;
  readonly rejection?: string;
} {
  if (
    finding.direction !== "response" ||
    finding.responseStatus === undefined
  ) {
    return {};
  }

  const matches = transforms.filter((transform) => {
    return (
      transform.client === "desktop" &&
      transform.method.toUpperCase() === finding.method.toUpperCase() &&
      transform.path === finding.routePath &&
      transform.status === finding.responseStatus
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
        `The matching transform (since ${transform.since}) has maxVersion ${transform.maxVersion}, but the published Desktop version is unavailable, so it cannot be verified. Oracle: ${DESKTOP_PUBLISHED_VERSION_ORACLE}.`,
      );
      continue;
    }
    if (maxVersion && compareVersions(maxVersion, publishedVersion) >= 0) {
      return { proof: transform };
    }
    rejections.push(
      `The matching transform (since ${transform.since}) has maxVersion ${transform.maxVersion}, below the published Desktop version ${published}, so published builds above it would receive the new shape.`,
    );
  }

  return rejections.length > 0 ? { rejection: rejections.join(" ") } : {};
}

function desktopProofs(
  finding: RuntimeApiCompatFinding,
  published: string | undefined,
): string {
  const publishedLabel =
    published === undefined
      ? `the published Desktop version (${DESKTOP_PUBLISHED_VERSION_ORACLE})`
      : `the published Desktop version ${published}`;
  const transformApplies =
    finding.direction === "response" && finding.responseStatus !== undefined;
  const proofB = transformApplies
    ? `(B) register a response transform for ${finding.method} ${finding.routePath} ${finding.responseStatus} in ${DESKTOP_TRANSFORMS_FILE} with maxVersion null or at least ${publishedLabel}.`
    : `(B) a response transform in ${DESKTOP_TRANSFORMS_FILE}, which cannot prove a ${finding.direction}-level finding; use (A) or keep the production contract.`;

  return [
    `A breaking change here needs one proof in the same PR: (A) raise minimumSupportedVersion in ${DESKTOP_FLOOR_FILE} to a stable x.y.z version that is not lower than the base branch floor, not above ${publishedLabel}, and already tolerates the new shape; or`,
    proofB,
  ].join(" ");
}

function findingKey(finding: RuntimeApiCompatFinding): string {
  return [finding.routeId, finding.direction, finding.path, finding.kind].join(
    "\u0000",
  );
}

function oneLine(value: string): string {
  return value.replace(/\s*\n\s*/gu, " ");
}
