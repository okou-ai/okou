import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createFauxCore, fauxAssistantMessage } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, onTestFinished } from "vitest";

const LATE_INPUT = "accepted after the first loop ended";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-prompt-failure-"));
  onTestFinished(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const faux = createFauxCore({
    api: "prompt-failure-test",
    provider: "prompt-failure-test",
  });
  const requests: string[] = [];
  faux.setResponses([
    (context) => {
      requests.push(JSON.stringify(context.messages));
      return fauxAssistantMessage("initial complete");
    },
    (context) => {
      requests.push(JSON.stringify(context.messages));
      return fauxAssistantMessage("unexpected continuation");
    },
  ]);
  const modelRuntime = await ModelRuntime.create({
    allowModelNetwork: false,
    modelsPath: null,
    refreshOnCreate: false,
  });
  modelRuntime.registerProvider(faux.provider, {
    name: faux.provider,
    api: faux.api,
    apiKey: "synthetic-key",
    baseUrl: faux.getModel().baseUrl,
    streamSimple: faux.streamSimple,
    models: faux.models,
  });
  const settingsManager = SettingsManager.inMemory(
    { compaction: { enabled: false }, retry: { enabled: false } },
    { projectTrusted: true },
  );
  const agentDir = join(root, "agent");
  const resourceLoader = new DefaultResourceLoader({
    cwd: root,
    agentDir,
    settingsManager,
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd: root,
    agentDir,
    model: faux.getModel(),
    modelRuntime,
    settingsManager,
    resourceLoader,
    sessionManager: SessionManager.create(root),
    tools: [],
  });
  onTestFinished(() => {
    session.dispose();
  });
  return { session, requests };
}

describe("ordinary prompt settlement failures", () => {
  it("preserves accepted input without executing another turn after an event failure", async () => {
    const { session, requests } = await fixture();
    const failure = new Error("consumer failed during queued input");
    let queued = false;
    let failed = false;
    const unsubscribe = session.agent.subscribe(async (event) => {
      if (event.type === "agent_end" && !queued) {
        queued = true;
        await session.steer(LATE_INPUT);
      }
      if (
        event.type === "message_start" &&
        event.message.role === "user" &&
        JSON.stringify(event.message.content).includes(LATE_INPUT) &&
        !failed
      ) {
        failed = true;
        throw failure;
      }
    });
    onTestFinished(unsubscribe);

    await session.prompt("initial prompt");

    expect(requests).toHaveLength(1);
    expect(session.isIdle).toBe(true);
    expect(session.pendingMessageCount).toBe(0);
    const file = session.sessionFile;
    if (!file) throw new Error("Expected a persisted session");
    const messages = SessionManager.open(file).buildSessionContext().messages;
    expect(
      messages.filter((message) => {
        return (
          message.role === "user" &&
          JSON.stringify(message.content).includes(LATE_INPUT)
        );
      }),
    ).toHaveLength(1);
    expect(
      messages
        .filter((message) => {
          return message.role === "assistant";
        })
        .at(-1),
    ).toMatchObject({ stopReason: "error", errorMessage: failure.message });
  });

  it("propagates failed queue persistence and releases the native owner", async () => {
    const { session, requests } = await fixture();
    const failure = new Error("queued input persistence unavailable");
    let queued = false;
    let failures = 0;
    const unsubscribe = session.agent.subscribe(async (event) => {
      if (event.type === "agent_end" && !queued) {
        queued = true;
        await session.steer(LATE_INPUT);
      }
      if (
        event.type === "message_start" &&
        event.message.role === "user" &&
        JSON.stringify(event.message.content).includes(LATE_INPUT)
      ) {
        failures += 1;
        // Bound a regressed retry loop through the public subscription API.
        if (failures === 2) unsubscribe();
        throw failure;
      }
    });
    onTestFinished(unsubscribe);

    await expect(session.prompt("initial prompt")).rejects.toThrow(
      failure.message,
    );
    expect(requests).toHaveLength(1);
    expect(session.isIdle).toBe(true);
    expect(session.agent.state.isStreaming).toBe(false);
    expect(failures).toBe(2);
  });
});
