import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const helper = fileURLToPath(
  new URL("../helpers/runner-chat.bash", import.meta.url),
);

function serializedSend(model, profileModel) {
  // Capture this helper's outgoing DTO, not a mocked backend outcome.
  const script = `source "$1"
runner_api_curl() { printf '%s\\n' "$5"; }
_runner_chat_post_parts "agent" "prompt" '[{"type":"text","text":"prompt"}]' "" "$2" "event" false`;
  return JSON.parse(
    execFileSync("bash", ["-c", script, "runner-chat-dto", helper, model], {
      encoding: "utf8",
      env: { ...process.env, E2E_MOCK_CODEX_MODEL: profileModel },
    }),
  );
}

test("new chats omit the model when exercising the product default", () => {
  const body = serializedSend("", "");
  assert.equal(Object.hasOwn(body, "model"), false);
  assert.equal(body.agentId, "agent");
  assert.equal(body.clientEventId, "event");
});

test("an explicit Auto selection is sent as null and overrides a mock Codex profile", () => {
  const body = serializedSend("auto", "gpt-6-sol");
  assert.equal(Object.hasOwn(body, "model"), true);
  assert.equal(body.model, null);
});

test("mock Codex probes retain their deliberate profile selection", () => {
  assert.equal(serializedSend("", "gpt-6-sol").model, "gpt-6-sol");
});
