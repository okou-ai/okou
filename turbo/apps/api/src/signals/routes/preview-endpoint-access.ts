import { env, optionalEnv } from "../../lib/env";

/**
 * The development and protected-preview environment gate.
 *
 * Some registered endpoints exist only to exercise a real execution path
 * outside production — an operator can call them on a local server or on a
 * protected preview deployment, and production must answer as if they do not
 * exist. This module owns that decision so a route which ships in the
 * deployed route table can use it without importing a test-only helper.
 *
 * It is environment protection, never owner authentication: a caller that
 * satisfies this gate still has to pass the route's ordinary authentication,
 * organization scope, capability and feature checks.
 */

const TEST_ENDPOINT_BYPASS_HEADER = "x-okou-test-endpoint-bypass";

interface HeaderReader {
  readonly header: (name: string) => string | undefined;
}

function isPreviewRuntime(deployEnv: string): boolean {
  return deployEnv === "preview" || optionalEnv("VERCEL_ENV") === "preview";
}

function expectedTestEndpointBypassSecret(): string | undefined {
  return (
    optionalEnv("VERCEL_AUTOMATION_BYPASS_SECRET") ??
    env("VERCEL_AUTOMATION_BYPASS_SECRET")
  );
}

// Vercel consumes the protection-bypass header before protected preview
// rewrites reach the API runtime. Production still stays denied.
function isProtectedPreviewRewrite(): boolean {
  return (
    optionalEnv("USE_MOCK_CLAUDE") === "true" &&
    !!expectedTestEndpointBypassSecret()
  );
}

export function isPreviewEndpointAllowed(request: HeaderReader): boolean {
  const deployEnv = env("ENV");

  if (deployEnv === "development") {
    return true;
  }

  if (isPreviewRuntime(deployEnv)) {
    const vercelBypassHeader = request.header("x-vercel-protection-bypass");
    const internalBypassHeader = request.header(TEST_ENDPOINT_BYPASS_HEADER);
    const expectedSecret = expectedTestEndpointBypassSecret();
    return (
      isProtectedPreviewRewrite() ||
      (!!expectedSecret &&
        (vercelBypassHeader === expectedSecret ||
          internalBypassHeader === expectedSecret))
    );
  }

  return false;
}

/** Production answers as if a preview-only endpoint were never registered. */
export function previewEndpointNotFoundResponse(): Response {
  return new Response("Not found", { status: 404 });
}
