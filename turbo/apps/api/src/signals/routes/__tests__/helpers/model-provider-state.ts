import type {
  TestModelProviderStateActionBody,
  TestModelProviderStateActionResponse,
} from "@okouai/api-contracts/contracts/test-model-provider-state";

import { createAppWithRoutes } from "../../../../app-factory-core";
import { testModelProviderStateRoutes } from "../../test-model-provider-state";

const MODEL_PROVIDER_STATE_ROUTE = "/api/test/model-provider-state";

function requestModelProviderState(
  signal: AbortSignal,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const app = createAppWithRoutes({
    signal,
    routes: testModelProviderStateRoutes,
  });
  return Promise.resolve(app.request(path, init));
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

function expectOk(response: Response, operation: string): void {
  if (response.ok) {
    return;
  }
  throw new Error(`${operation} failed with ${response.status}`);
}

async function postAction(
  signal: AbortSignal,
  body: TestModelProviderStateActionBody,
): Promise<TestModelProviderStateActionResponse> {
  const response = await requestModelProviderState(
    signal,
    `${MODEL_PROVIDER_STATE_ROUTE}/action`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  expectOk(response, `model provider state action ${body.action}`);
  return await readJson<TestModelProviderStateActionResponse>(response);
}

export async function overwriteModelProviderSecretForTests(
  signal: AbortSignal,
  args: {
    readonly providerId: string;
    readonly secretName: string;
    readonly secret: string;
  },
): Promise<void> {
  await postAction(signal, {
    action: "overwrite-secret",
    provider_id: args.providerId,
    secret_name: args.secretName,
    secret: args.secret,
  });
}
