import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createFauxCore,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createBashTool,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, onTestFinished } from "vitest";

import { resumePiApiFirstTurn } from "./rpc";

describe.each(["prompt", "pending-tools"] as const)(
  "Pi Bash signal recovery through %s",
  (entry) => {
    it.each(["SIGKILL", "SIGTERM"])(
      "reports %s as a tool failure and continues the same session",
      async (signal) => {
        const root = await mkdtemp(join(tmpdir(), "pi-bash-signal-"));
        onTestFinished(async () => {
          await rm(root, { recursive: true, force: true });
        });
        const killedCall = fauxAssistantMessage(
          fauxToolCall(
            "bash",
            {
              command: `printf 'output-before-signal\\n'; kill -${signal} $$`,
              timeout: 3,
            },
            { id: "killed-tool" },
          ),
          { stopReason: "toolUse" },
        );
        const faux = createFauxCore({
          api: "bash-signal-test",
          provider: "bash-signal-test",
        });
        faux.setResponses([
          ...(entry === "prompt" ? [killedCall] : []),
          fauxAssistantMessage(
            fauxToolCall(
              "bash",
              { command: "printf 'recovery-succeeded\\n'", timeout: 3 },
              { id: "recovery-tool" },
            ),
            { stopReason: "toolUse" },
          ),
          fauxAssistantMessage("Recovered from the interrupted tool."),
        ]);
        const modelRuntime = await ModelRuntime.create({
          allowModelNetwork: false,
          modelsPath: null,
          refreshOnCreate: false,
        });
        modelRuntime.registerProvider(faux.provider, {
          name: faux.provider,
          api: faux.api,
          baseUrl: faux.getModel().baseUrl,
          apiKey: "synthetic-key",
          streamSimple: faux.streamSimple,
          models: faux.models,
        });
        const sessionManager = SessionManager.create(root, root);
        if (entry === "pending-tools") {
          sessionManager.appendMessage({
            role: "user",
            content: "Continue after the tool is interrupted.",
            timestamp: 1,
          });
          sessionManager.appendMessage(killedCall);
        }
        const settingsManager = SettingsManager.inMemory({
          compaction: { enabled: false },
          retry: { enabled: false },
        });
        const agentDir = join(root, "agent");
        const resourceLoader = new DefaultResourceLoader({
          cwd: root,
          agentDir,
          settingsManager,
          noExtensions: true,
          noSkills: true,
          noPromptTemplates: true,
          noThemes: true,
        });
        await resourceLoader.reload();
        const { session } = await createAgentSession({
          cwd: root,
          agentDir,
          model: faux.getModel(),
          modelRuntime,
          sessionManager,
          settingsManager,
          resourceLoader,
          tools: ["bash"],
          customTools: [
            createBashTool(root, {
              shellPath: "/bin/bash",
              exposeSessionEnvironment: false,
            }),
          ],
        });
        try {
          if (entry === "prompt") {
            await session.prompt("Continue after the tool is interrupted.");
          } else {
            await resumePiApiFirstTurn(session);
          }
        } finally {
          session.dispose();
        }

        const file = sessionManager.getSessionFile();
        if (!file) throw new Error("Expected a persisted Pi session");
        const messages =
          SessionManager.open(file).buildSessionContext().messages;
        const results = messages.filter((message) => {
          return message.role === "toolResult";
        });
        expect(results).toMatchObject([
          {
            toolCallId: "killed-tool",
            isError: true,
            content: [
              {
                type: "text",
                text: expect.stringContaining("output-before-signal"),
              },
            ],
          },
          {
            toolCallId: "recovery-tool",
            isError: false,
            content: [{ type: "text", text: "recovery-succeeded\n" }],
          },
        ]);
        expect(results[0]?.content).toEqual([
          {
            type: "text",
            text: expect.stringContaining("Command terminated by signal"),
          },
        ]);
        expect(messages.at(-1)).toMatchObject({
          role: "assistant",
          content: [
            { type: "text", text: "Recovered from the interrupted tool." },
          ],
          stopReason: "stop",
        });
      },
    );
  },
);
