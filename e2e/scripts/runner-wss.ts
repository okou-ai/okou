import { RunnerWssApi, type OwnedWssRun } from "./runner-wss-api";
import { ECHO_SIZES, RunnerWssClient } from "./runner-wss-client";
import { probeHomeFiles } from "./runner-wss-files";
import { probeFileReads } from "./runner-wss-file-read";
import { probeDownloads, probeDownloadRunEnd } from "./runner-file-download";

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
  let downloadHttpStatus: number | undefined;
  let cleanupFailures = 0;
  let filesystem: Awaited<ReturnType<typeof probeHomeFiles>> | undefined;
  let fileReads: Awaited<ReturnType<typeof probeFileReads>> | undefined;
  let downloads: Awaited<ReturnType<typeof probeDownloads>> | undefined;
  let downloadRunEnd:
    Awaited<ReturnType<typeof probeDownloadRunEnd>> | undefined;
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
    phase = "replay";
    await client.rejectReplay();
    phase = "diagnostics";
    await client.diagnostics();
    phase = "filesystem";
    filesystem = await probeHomeFiles(client, run.homeFixture);
    phase = "file-read";
    fileReads = await probeFileReads(client, run.homeFixture);
    phase = "retained-diagnostics";
    await client.diagnostics();
    client.assertHealthy();
    phase = "file-download";
    downloads = await probeDownloads(
      api,
      run,
      (check, status) => {
        // Only fixed probe labels and numeric status enter failure diagnostics.
        phase = `file-download-${check}`;
        downloadHttpStatus = status;
      },
      signal,
    );
    await client.close();
    phase = "file-download-run-end";
    downloadHttpStatus = undefined;
    downloadRunEnd = await probeDownloadRunEnd(api, run, signal);
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
  if (failed || cleanupFailures || !run || !client) {
    console.error(
      JSON.stringify({
        result: "FAIL",
        phase,
        apiStatus: failureApiStatus,
        downloadHttpStatus,
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
      schemaVersion: 1,
      echoSizes: ECHO_SIZES,
      ...client.receipts,
      ...filesystem,
      ...fileReads,
      ...downloads,
      ...downloadRunEnd,
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
