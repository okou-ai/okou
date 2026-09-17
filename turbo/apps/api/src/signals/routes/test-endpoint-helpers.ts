import {
  isPreviewEndpointAllowed,
  previewEndpointNotFoundResponse,
} from "./preview-endpoint-access";

/**
 * The gate for endpoints mounted only by a test route slice.
 *
 * The decision itself lives in
 * [preview endpoint access](./preview-endpoint-access.ts) so a route that does
 * ship in the deployed route table can share it; production code may not import
 * anything under `routes/test-*`. These names stay for the existing test route
 * slices that already use them.
 */

interface HeaderReader {
  readonly header: (name: string) => string | undefined;
}

export function isTestEndpointAllowed(request: HeaderReader): boolean {
  return isPreviewEndpointAllowed(request);
}

export function testEndpointNotFoundResponse(): Response {
  return previewEndpointNotFoundResponse();
}
