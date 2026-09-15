import { env, optionalEnv } from "../../lib/env";
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

export function isTestEndpointAllowed(request: HeaderReader): boolean {
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

export function testEndpointNotFoundResponse(): Response {
  return new Response("Not found", { status: 404 });
}
