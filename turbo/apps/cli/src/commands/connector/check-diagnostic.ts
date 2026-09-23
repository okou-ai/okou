import { Option, type Command } from "commander";
import {
  AWS_PREDICATE_VALUE_RE,
  AWS_QUERY_KEY_RE,
  AWS_QUERY_VALUE_RE,
  AWS_S3_PERMISSION_HEADER_NAMES,
} from "@okouai/connectors/firewall-expander";
import type {
  ConnectorCheckTargetAwareDiagnosticResult,
  ConnectorCheckRequestBody,
} from "@okouai/api-contracts/contracts/connector-check";
import type { ConnectorRuntimeTarget } from "@okouai/api-contracts/contracts/runners";
import { isComputerUsePermissionTarget } from "./computer-use-guidance";
import { customConnectorIdFromSelector } from "./custom-connector-guidance";

export interface CheckConnectorOptions {
  readonly json?: boolean;
  readonly connector?: string;
  readonly envName?: string;
  readonly url?: string;
  readonly method: string;
  readonly checkPermission?: string;
  readonly awsService?: string;
  readonly awsAction?: string;
  readonly awsTarget?: string;
  readonly awsQueryParam?: readonly string[];
  readonly awsHeaderPresent?: readonly string[];
}

const AWS_S3_PERMISSION_HEADER_NAME_SET = new Set<string>(
  AWS_S3_PERMISSION_HEADER_NAMES,
);
type AwsS3PermissionHeaderName =
  (typeof AWS_S3_PERMISSION_HEADER_NAMES)[number];

function collectRepeatedOption(
  value: string,
  previous: string[] = [],
): string[] {
  return [...previous, value];
}

export function addAwsDiagnosticOptions(command: Command): Command {
  return command
    .addOption(
      new Option(
        "--aws-service <SERVICE>",
        "Explicit AWS SigV4 signing service; required with AWS selectors",
      ),
    )
    .addOption(
      new Option("--aws-action <ACTION>", "AWS Query API Action selector"),
    )
    .addOption(
      new Option(
        "--aws-target <TARGET>",
        "AWS JSON X-Amz-Target selector (mutually exclusive with --aws-action)",
      ),
    )
    .addOption(
      new Option(
        "--aws-query-param <KEY[=VALUE]>",
        "Exact AWS query selector; repeat for additional keys; values must not be secret",
      ).argParser(collectRepeatedOption),
    )
    .addOption(
      new Option(
        "--aws-header-present <NAME>",
        "Allowlisted S3 permission-selector header name only; repeat as needed",
      ).argParser(collectRepeatedOption),
    );
}

type ValidatedCheckConnectorOptions = CheckConnectorOptions &
  (
    | { readonly url: string }
    | { readonly url?: undefined; readonly envName: string }
  );

export type ResolvedDiagnostic = Extract<
  ConnectorCheckTargetAwareDiagnosticResult,
  { readonly outcome: "resolved" }
>;
export type ResolvedUrlDiagnostic = Extract<
  ResolvedDiagnostic,
  { readonly mode: "url" }
>;
export type ResolvedEnvironmentDiagnostic = Extract<
  ResolvedDiagnostic,
  { readonly mode: "environment" }
>;
export type UrlDiagnosticRequest = Extract<
  ConnectorCheckRequestBody,
  { readonly mode: "url" }
>;

function stripUrlQueryAndFragment(url: string): string {
  const queryIndex = url.indexOf("?");
  const fragmentIndex = url.indexOf("#");
  let end = url.length;
  if (queryIndex !== -1) end = Math.min(end, queryIndex);
  if (fragmentIndex !== -1) end = Math.min(end, fragmentIndex);
  return url.slice(0, end);
}

function rawUrlAuthorityHasUserinfo(url: string): boolean {
  const schemeEnd = url.indexOf("://");
  if (schemeEnd === -1) return false;

  const authorityStart = schemeEnd + 3;
  let authorityEnd = url.length;
  for (const delimiter of ["/", "?", "#"]) {
    const delimiterIndex = url.indexOf(delimiter, authorityStart);
    if (delimiterIndex !== -1) {
      authorityEnd = Math.min(authorityEnd, delimiterIndex);
    }
  }
  return url.slice(authorityStart, authorityEnd).includes("@");
}

function parseAwsQueryParam(value: string): {
  readonly key: string;
  readonly value?: string;
} {
  const separator = value.indexOf("=");
  const key = separator === -1 ? value : value.slice(0, separator);
  const queryValue = separator === -1 ? undefined : value.slice(separator + 1);
  if (
    !AWS_QUERY_KEY_RE.test(key) ||
    key.length > 128 ||
    (queryValue !== undefined &&
      (queryValue === "" ||
        queryValue.length > 256 ||
        (queryValue !== "*" && !AWS_QUERY_VALUE_RE.test(queryValue))))
  ) {
    throw new Error(
      `Invalid --aws-query-param value "${value}". Use KEY or KEY=VALUE with a bounded AWS selector value.`,
    );
  }
  return queryValue === undefined ? { key } : { key, value: queryValue };
}

function hasAwsDiagnosticSelectors(
  options: Pick<
    CheckConnectorOptions,
    | "awsService"
    | "awsAction"
    | "awsTarget"
    | "awsQueryParam"
    | "awsHeaderPresent"
  >,
): boolean {
  return (
    options.awsService !== undefined ||
    options.awsAction !== undefined ||
    options.awsTarget !== undefined ||
    (options.awsQueryParam?.length ?? 0) > 0 ||
    (options.awsHeaderPresent?.length ?? 0) > 0
  );
}

function requireAwsService(value: string | undefined): string {
  if (
    value === undefined ||
    value.length === 0 ||
    value.length > 128 ||
    !AWS_PREDICATE_VALUE_RE.test(value)
  ) {
    throw new Error(
      "--aws-service is required when AWS selectors are used and must be a valid SigV4 service name.",
    );
  }
  return value;
}

function validateAwsActionAndTarget(
  action: string | undefined,
  target: string | undefined,
): void {
  if (
    action !== undefined &&
    (action.length === 0 ||
      action.length > 256 ||
      !AWS_PREDICATE_VALUE_RE.test(action))
  ) {
    throw new Error("--aws-action must be a valid bounded AWS action name.");
  }
  if (
    target !== undefined &&
    (target.length === 0 ||
      target.length > 256 ||
      !AWS_PREDICATE_VALUE_RE.test(target))
  ) {
    throw new Error("--aws-target must be a valid bounded AWS target name.");
  }
  if (action !== undefined && target !== undefined) {
    throw new Error("--aws-action and --aws-target cannot be combined.");
  }
}

function parseAwsQuerySelectors(
  inputs: readonly string[],
  action: string | undefined,
): { readonly key: string; readonly value?: string }[] {
  const query = inputs.map(parseAwsQueryParam);
  const queryKeys = new Set<string>();
  for (const selector of query) {
    if (queryKeys.has(selector.key)) {
      throw new Error(
        `--aws-query-param cannot repeat the key "${selector.key}".`,
      );
    }
    queryKeys.add(selector.key);
  }

  const actionSelectors = query.filter((selector) => {
    return selector.key === "Action";
  });
  if (
    action !== undefined &&
    actionSelectors.length > 0 &&
    (actionSelectors.length !== 1 || actionSelectors[0]?.value !== action)
  ) {
    throw new Error(
      "--aws-query-param Action conflicts with --aws-action; provide the same value or omit the query selector.",
    );
  }
  return query;
}

function parseAwsHeaderNames(
  inputs: readonly string[],
  service: string,
  action: string | undefined,
  target: string | undefined,
): AwsS3PermissionHeaderName[] {
  const headerNames: AwsS3PermissionHeaderName[] = [];
  const seenHeaderNames = new Set<string>();
  for (const input of inputs) {
    if (!AWS_S3_PERMISSION_HEADER_NAME_SET.has(input)) {
      throw new Error(
        `Unsupported --aws-header-present name "${input}". Only allowlisted S3 permission-selector header names are accepted.`,
      );
    }
    const headerName = input as AwsS3PermissionHeaderName;
    if (seenHeaderNames.has(headerName)) {
      throw new Error(
        `--aws-header-present cannot repeat the name "${headerName}".`,
      );
    }
    seenHeaderNames.add(headerName);
    headerNames.push(headerName);
  }
  if (
    headerNames.length > 0 &&
    (service !== "s3" || action !== undefined || target !== undefined)
  ) {
    throw new Error(
      "--aws-header-present is supported only for actionless S3 diagnostics.",
    );
  }
  return headerNames;
}

function awsSelectorsFromOptions(
  options: Pick<
    CheckConnectorOptions,
    | "awsService"
    | "awsAction"
    | "awsTarget"
    | "awsQueryParam"
    | "awsHeaderPresent"
  >,
): UrlDiagnosticRequest["aws"] {
  const queryInputs = options.awsQueryParam ?? [];
  const headerInputs = options.awsHeaderPresent ?? [];
  if (!hasAwsDiagnosticSelectors(options)) return undefined;

  const service = requireAwsService(options.awsService);
  validateAwsActionAndTarget(options.awsAction, options.awsTarget);
  const query = parseAwsQuerySelectors(queryInputs, options.awsAction);
  const headerNames = parseAwsHeaderNames(
    headerInputs,
    service,
    options.awsAction,
    options.awsTarget,
  );

  return {
    sigv4Service: service,
    ...(options.awsAction === undefined ? {} : { action: options.awsAction }),
    ...(options.awsTarget === undefined ? {} : { target: options.awsTarget }),
    ...(query.length === 0 ? {} : { query }),
    ...(headerNames.length === 0 ? {} : { headerNames }),
  };
}

export function validateDiagnosticUrl(url: string): void {
  if (rawUrlAuthorityHasUserinfo(url)) {
    throw unsafeInputError("invalid-url");
  }
}

function shellQuoteArg(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function connectorSelectionCommand(
  request: UrlDiagnosticRequest,
  selector: string,
): string {
  const args = [
    `--url ${shellQuoteArg(request.url)}`,
    `--connector ${shellQuoteArg(selector)}`,
  ];
  if (request.method !== "GET") {
    args.push(`--method ${shellQuoteArg(request.method)}`);
  }
  appendAwsSelectorCommandArgs(args, request.aws);
  return `okou connector check ${args.join(" ")}`;
}

function appendAwsSelectorCommandArgs(
  args: string[],
  aws: UrlDiagnosticRequest["aws"],
): void {
  if (aws === undefined) return;
  args.push(`--aws-service ${shellQuoteArg(aws.sigv4Service)}`);
  if (aws.action !== undefined) {
    args.push(`--aws-action ${shellQuoteArg(aws.action)}`);
  }
  if (aws.target !== undefined) {
    args.push(`--aws-target ${shellQuoteArg(aws.target)}`);
  }
  for (const selector of aws.query ?? []) {
    const value =
      selector.value === undefined
        ? selector.key
        : `${selector.key}=${selector.value}`;
    args.push(`--aws-query-param ${shellQuoteArg(value)}`);
  }
  for (const headerName of aws.headerNames ?? []) {
    args.push(`--aws-header-present ${shellQuoteArg(headerName)}`);
  }
}

function connectorSelector(target: ConnectorRuntimeTarget): string {
  return target.kind === "builtin"
    ? target.connectorSlug
    : `custom:${target.customConnectorId}`;
}

function rawPathFromUrl(url: string): string | undefined {
  const sanitizedUrl = stripUrlQueryAndFragment(url);
  const schemeEnd = sanitizedUrl.indexOf("://");
  if (schemeEnd === -1) return undefined;

  const pathStart = sanitizedUrl.indexOf("/", schemeEnd + 3);
  return pathStart === -1 ? "/" : sanitizedUrl.slice(pathStart);
}

export function isComputerUseCheckTarget(opts: CheckConnectorOptions): boolean {
  return isComputerUsePermissionTarget({
    connectorSlug: opts.connector ?? "",
    path: opts.url === undefined ? undefined : rawPathFromUrl(opts.url),
    permission: opts.checkPermission,
  });
}

export function validateCheckConnectorOptions(
  opts: CheckConnectorOptions,
  command: Command,
): asserts opts is ValidatedCheckConnectorOptions {
  const hasUrl = opts.url !== undefined;
  // Reject embedded credentials before the diagnostic request leaves the client.
  if (opts.url !== undefined) {
    validateDiagnosticUrl(opts.url);
  }
  const aws = awsSelectorsFromOptions(opts);
  if (aws !== undefined && !hasUrl) {
    throw new Error("AWS diagnostic selectors can only be used with --url.");
  }
  if (opts.connector !== undefined && !hasUrl) {
    throw new Error(
      "--connector can only be used with --url. Add --url <URL> or remove --connector.",
    );
  }
  if (opts.checkPermission !== undefined && hasUrl) {
    throw new Error(
      "--check-permission cannot be used with --url because the permission is derived from the request. Remove --check-permission.",
    );
  }
  if (opts.checkPermission?.trim() === "") {
    throw new Error("--check-permission requires a non-empty permission name.");
  }
  if (!hasUrl && command.getOptionValueSource("method") === "cli") {
    throw new Error(
      "--method can only be used with --url. Add --url <URL> or remove --method.",
    );
  }
  if (opts.envName === undefined && !hasUrl) {
    throw new Error(
      "Either --env-name or --url is required. Use --help for usage.",
    );
  }
}

export function buildConnectorUrlDiagnosticRequest(args: {
  readonly url: string;
  readonly method: string;
  readonly connector?: string;
  readonly environmentName?: string;
  readonly awsService?: string;
  readonly awsAction?: string;
  readonly awsTarget?: string;
  readonly awsQueryParam?: readonly string[];
  readonly awsHeaderPresent?: readonly string[];
}): UrlDiagnosticRequest {
  validateDiagnosticUrl(args.url);
  const aws = awsSelectorsFromOptions(args);
  const customConnectorId = customConnectorIdFromSelector(args.connector);
  const selection =
    customConnectorId !== undefined
      ? { target: { kind: "custom" as const, customConnectorId } }
      : args.connector !== undefined
        ? { connectorSlug: args.connector }
        : { includeCustomConnectors: true as const };
  return {
    mode: "url",
    method: args.method.toUpperCase(),
    url: stripUrlQueryAndFragment(args.url),
    ...selection,
    ...(aws === undefined ? {} : { aws }),
    ...(args.environmentName !== undefined
      ? { environmentName: args.environmentName }
      : {}),
  };
}

export function buildDiagnosticRequest(
  opts: ValidatedCheckConnectorOptions,
  method: string,
): ConnectorCheckRequestBody {
  if (opts.url !== undefined) {
    return buildConnectorUrlDiagnosticRequest({
      method,
      url: opts.url,
      connector: opts.connector,
      environmentName: opts.envName,
      ...(opts.awsService === undefined ? {} : { awsService: opts.awsService }),
      ...(opts.awsAction === undefined ? {} : { awsAction: opts.awsAction }),
      ...(opts.awsTarget === undefined ? {} : { awsTarget: opts.awsTarget }),
      ...(opts.awsQueryParam === undefined
        ? {}
        : { awsQueryParam: opts.awsQueryParam }),
      ...(opts.awsHeaderPresent === undefined
        ? {}
        : { awsHeaderPresent: opts.awsHeaderPresent }),
    });
  }

  return {
    mode: "environment",
    environmentName: opts.envName,
    ...(opts.checkPermission !== undefined
      ? { permission: opts.checkPermission }
      : {}),
  };
}

export function requireUrlRequest(
  request: ConnectorCheckRequestBody,
): UrlDiagnosticRequest {
  if (request.mode !== "url") {
    throw new Error(
      "Connector diagnostic returned a URL-only outcome for an environment request.",
    );
  }
  return request;
}

function requestedEnvironmentName(request: ConnectorCheckRequestBody): string {
  if (request.environmentName === undefined) {
    throw new Error(
      "Connector diagnostic returned an environment outcome without an environment name.",
    );
  }
  return request.environmentName;
}

function unsafeInputError(
  reason: Extract<
    ConnectorCheckTargetAwareDiagnosticResult,
    { readonly outcome: "unsafe-input" }
  >["reason"],
): Error {
  switch (reason) {
    case "invalid-method":
      return new Error(
        "connector check requires --method to be a supported HTTP method.",
      );
    case "invalid-url":
      return new Error(
        "connector check requires --url to be a valid absolute http or https URL.",
      );
    case "unsafe-path":
      return new Error(
        "connector check cannot diagnose unsafe URL paths because they are blocked before permission policy evaluation.",
      );
  }
}

function ambiguousConnectorError(
  request: UrlDiagnosticRequest,
  result: Extract<
    ConnectorCheckTargetAwareDiagnosticResult,
    { readonly outcome: "ambiguous" }
  >,
): Error {
  const candidates = [...result.candidates].sort((left, right) => {
    return connectorSelector(left.target).localeCompare(
      connectorSelector(right.target),
    );
  });
  const commands = candidates.map((candidate) => {
    return `  ${connectorSelectionCommand(request, connectorSelector(candidate.target))}`;
  });
  return new Error(
    `Multiple connectors match ${request.method} ${request.url}: ${candidates
      .map((candidate) => {
        return connectorSelector(candidate.target);
      })
      .join(", ")}\nSelect one explicitly:\n${commands.join("\n")}`,
  );
}

function unknownConnectorError(request: ConnectorCheckRequestBody): Error {
  if (
    request.mode === "url" &&
    "connectorSlug" in request &&
    request.connectorSlug !== undefined
  ) {
    return new Error(
      `Unknown connector slug: ${request.connectorSlug}\nRun: okou connector search ${shellQuoteArg(request.connectorSlug)}`,
    );
  }
  return new Error("The requested connector is unknown.");
}

function noMatchError(
  result: Extract<
    ConnectorCheckTargetAwareDiagnosticResult,
    { readonly outcome: "no-match" }
  >,
): Error {
  return new Error(
    result.scope === "run"
      ? "No connector found for provided URL — no connector configured for the current run matches this URL"
      : "No connector found for provided URL — no registered connector base URL matches this URL",
  );
}

function connectorMismatchError(
  request: UrlDiagnosticRequest,
  result: Extract<
    ConnectorCheckTargetAwareDiagnosticResult,
    { readonly outcome: "connector-mismatch" }
  >,
): Error {
  const requestedSlug =
    "target" in request && request.target
      ? connectorSelector(request.target)
      : (("connectorSlug" in request ? request.connectorSlug : undefined) ??
        "the requested connector");
  return new Error(
    `Connector ${requestedSlug} does not own ${request.method} ${request.url}; the matching connector is ${connectorSelector(result.connector.target)}\nRun: ${connectorSelectionCommand(request, connectorSelector(result.connector.target))}`,
  );
}

function environmentNotOwnedError(
  request: ConnectorCheckRequestBody,
  result: Extract<
    ConnectorCheckTargetAwareDiagnosticResult,
    { readonly outcome: "environment-not-owned" }
  >,
): Error {
  const environmentName = requestedEnvironmentName(request);
  return new Error(
    `${environmentName} is not an environment name for the ${result.connector.label} connector. Remove --env-name to use the matched route metadata.`,
  );
}

function environmentNotUsedError(
  request: ConnectorCheckRequestBody,
  result: Extract<
    ConnectorCheckTargetAwareDiagnosticResult,
    { readonly outcome: "environment-not-used" }
  >,
): Error {
  const environmentName = requestedEnvironmentName(request);
  return new Error(
    `${environmentName} is not used by the matched API route. Expected one of: ${result.environmentNames.join(", ") || "none"}. Remove --env-name to use the matched route metadata.`,
  );
}

export function resolveConnectorCheckDiagnostic(
  request: ConnectorCheckRequestBody,
  result: ConnectorCheckTargetAwareDiagnosticResult,
): ResolvedDiagnostic {
  if (result.outcome === "resolved") {
    return result;
  }
  throw connectorCheckDiagnosticError(request, result);
}

export function connectorCheckDiagnosticError(
  request: ConnectorCheckRequestBody,
  result: Exclude<
    ConnectorCheckTargetAwareDiagnosticResult,
    ResolvedDiagnostic
  >,
): Error {
  switch (result.outcome) {
    case "unsafe-input":
      return unsafeInputError(result.reason);
    case "unknown-connector":
      return unknownConnectorError(request);
    case "unknown-environment":
      return new Error(
        `Unknown environment name: ${requestedEnvironmentName(request)} — not managed by any connector`,
      );
    case "no-match":
      return noMatchError(result);
    case "ambiguous":
      return ambiguousConnectorError(requireUrlRequest(request), result);
    case "connector-mismatch":
      return connectorMismatchError(requireUrlRequest(request), result);
    case "environment-not-owned":
      return environmentNotOwnedError(request, result);
    case "environment-not-used":
      return environmentNotUsedError(request, result);
    case "unresolved-dynamic-base":
      return new Error(
        `No authoritative ${result.connector.label} base URL is available for this diagnostic. Verify the ${connectorSelector(result.connector.target)} connector configuration for the affected context and retry.`,
      );
    case "target-unavailable": {
      const reasons = {
        "not-admitted":
          "was not admitted to this run. Select it for the thread, then start a new run",
        "connector-unavailable":
          "is unavailable. Review its definition, agent access, and the account selected for this run",
        "permission-bundle-unavailable":
          "has unavailable permission metadata. Ask an administrator to review its permission definition",
        "runtime-configuration-unavailable":
          "has unavailable runtime configuration. Review its required fields and the account selected for this run",
      };
      return new Error(
        `Connector ${connectorSelector(result.target)} ${reasons[result.reason]}.`,
      );
    }
    case "run-context-unavailable":
      return new Error(
        "The current run context is unavailable for connector diagnosis. Retry from an active run or start a new run.",
      );
  }
}

export function connectorPermissionRequestCommand(
  connectorSlug: string,
  permission: string,
  request: UrlDiagnosticRequest,
): string {
  const args = [
    `okou connector permission-request ${shellQuoteArg(connectorSlug)}`,
    `--permission ${shellQuoteArg(permission)}`,
    `--url ${shellQuoteArg(request.url)}`,
    `--method ${shellQuoteArg(request.method)}`,
  ];
  appendAwsSelectorCommandArgs(args, request.aws);
  return args.join(" ");
}

export function connectorCheckRetryCommand(
  request: ConnectorCheckRequestBody,
): string {
  const args: string[] = [];
  if (request.mode === "url") {
    args.push(`--url ${shellQuoteArg(request.url)}`);
    if ("target" in request && request.target) {
      args.push(
        `--connector ${shellQuoteArg(connectorSelector(request.target))}`,
      );
    } else if (
      "connectorSlug" in request &&
      request.connectorSlug !== undefined
    ) {
      args.push(`--connector ${shellQuoteArg(request.connectorSlug)}`);
    }
    if (request.environmentName !== undefined) {
      args.push(`--env-name ${shellQuoteArg(request.environmentName)}`);
    }
    if (request.method !== "GET") {
      args.push(`--method ${shellQuoteArg(request.method)}`);
    }
    appendAwsSelectorCommandArgs(args, request.aws);
  } else {
    args.push(`--env-name ${shellQuoteArg(request.environmentName)}`);
    if (request.permission !== undefined) {
      args.push(`--check-permission ${shellQuoteArg(request.permission)}`);
    }
  }
  return `okou connector check ${args.join(" ")}`;
}

export function printDiagnosticSummary(
  request: ConnectorCheckRequestBody,
  result: ResolvedDiagnostic,
): void {
  if (result.mode === "url") {
    const urlRequest = requireUrlRequest(request);
    const target = result.connector.target;
    const identity =
      target.kind === "builtin"
        ? `slug: ${target.connectorSlug}`
        : `custom UUID: ${target.customConnectorId}`;
    console.log(
      `URL ${urlRequest.url} matches the ${result.connector.label} connector (${identity}).`,
    );
    if (urlRequest.aws !== undefined) {
      console.log(
        "  AWS selectors describe the intended operation only; no SigV4 signature was validated and no AWS request was sent.",
      );
    }
    console.log(`  Matched base URL: ${result.base}`);
    console.log(`  Relative path:    ${result.relativePath}`);
    if (result.environmentNames === null) {
      console.log("  Environment names: unavailable");
    } else {
      console.log(
        `  Environment names: [${result.environmentNames.join(", ")}]`,
      );
    }
    return;
  }

  console.log(
    `${result.environmentName} is managed by the ${result.connector.label} connector (slug: ${connectorSelector(result.connector.target)}).`,
  );
}

export function diagnosticEnvironmentNames(
  result: ResolvedDiagnostic,
): readonly string[] | null {
  return result.mode === "url"
    ? result.environmentNames
    : [result.environmentName];
}
