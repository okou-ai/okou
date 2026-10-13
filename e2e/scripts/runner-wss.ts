import { RunnerWssApi, type OwnedWssRun } from "./runner-wss-api";
import { FRAME_SIZES, RunnerWssClient } from "./runner-wss-client";

async function main(): Promise<void> {
  if (required("E2E_RUNNER_PROFILE") !== "mock-codex")
    throw new Error("Prepared mock Codex profile required");
  const apiUrl = new URL(required("E2E_API_URL"));
  if (
    apiUrl.protocol !== "https:" ||
    apiUrl.username ||
    apiUrl.password ||
    apiUrl.pathname !== "/" ||
    apiUrl.search ||
    apiUrl.hash
  )
    throw new Error("Exact HTTPS API origin required");
  const signal = AbortSignal.timeout(180_000);
  const api = new RunnerWssApi(
    apiUrl.origin,
    required("E2E_API_TOKEN"),
    signal,
  );
  let client: RunnerWssClient | undefined;
  let run: OwnedWssRun | undefined;
  let phase = "profile";
  let failed = false;
  let failureApiStatus: number | undefined;
  let cleanupFailures = 0;
  try {
    const model = required("E2E_MOCK_CODEX_MODEL");
    await api.verifyMockProfile(model);
    phase = "start";
    await api.createAgent();
    run = await api.start(model);
    phase = "bootstrap";
    const ticket = await api.bootstrap(run);
    client = new RunnerWssClient(run.runId, ticket, signal);
    phase = "admission";
    await client.connect();
    phase = "echo";
    await client.echo();
    phase = "replay";
    await client.rejectReplay();
    phase = "retained-echo";
    await client.echo();
    client.assertHealthy();
  } catch {
    failed = true;
    failureApiStatus = api.lastHttpStatus;
  } finally {
    if (!failed) phase = "cleanup";
    try {
      await client?.close();
    } catch {
      cleanupFailures += 1;
    }
    try {
      await api.cleanup();
    } catch {
      cleanupFailures += 1;
    }
  }
  if (failed || cleanupFailures || !run) {
    console.error(
      JSON.stringify({
        result: "FAIL",
        phase,
        apiStatus: failureApiStatus,
        cleanupFailures,
      }),
    );
    process.exitCode = 1;
    return;
  }
  console.log(
    JSON.stringify({
      result: "PASS",
      tlsVerification: true,
      frameSizes: FRAME_SIZES,
      replayRejectedBeforeExpiry: true,
      runId: run.runId,
      runnerId: run.runnerId,
      hostname: run.hostname,
      ownedCleanup: "PASS",
    }),
  );
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing WSS environment: ${name}`);
  return value;
}

void main().catch(() => {
  console.error(
    "Runner WSS acceptance failed; credential-bearing diagnostics are omitted",
  );
  process.exitCode = 1;
});
