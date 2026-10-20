import {
  OFFICIAL_TELEGRAM_BOT_ID,
  TELEGRAM_AUTH_CALLBACK_OUTCOMES,
} from "@okouai/api-contracts/contracts/integrations-telegram";
import { INTEGRATION_SETTINGS_PATHS } from "@okouai/core/integration-routes";
import { allowedCorsOrigin } from "./cors";
import { env } from "./env";

const CALLBACK_SCRIPT = String.raw`function runTelegramCallback(context, settingsUrl, outcomes) {
  "use strict";
  var status = document.getElementById("status");
  document.getElementById("settings").href = settingsUrl;
  var owner = window.opener;
  var proof = readIdentity();
  // Retain only the version so reload offers result guidance, not v1's close.
  try {
    window.history.replaceState(null, "", window.location.pathname + "?callbackProtocol=2");
  } catch (_) {
    proof = null;
    status.textContent = "This page can no longer confirm the connection result. Return to the original page or check Telegram settings.";
    return;
  }
  var retry;
  var deadline;
  var completion;
  var expiresAt = Date.now() + 120000;
  var ready = false;
  var terminal = null;
  var disposed = false;

  function readIdentity() {
    var query = new URLSearchParams(window.location.search);
    var fragment = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    if (query.has("id") && fragment.has("id")) return null;
    var params = query.has("id") ? query : fragment;
    var data = {};
    var keys = ["id", "first_name", "last_name", "username", "photo_url", "auth_date", "hash"];
    for (var key of keys) {
      if (params.getAll(key).length > 1) return null;
      var value = params.get(key);
      if (value !== null) data[key] = value;
    }
    if (!/^[1-9][0-9]*$/.test(data.id) || !/^[1-9][0-9]*$/.test(data.auth_date) ||
        !/^[0-9a-f]{64}$/i.test(data.hash)) return null;
    return data;
  }

  function cleanup() {
    disposed = true;
    proof = null;
    window.clearInterval(retry);
    window.clearTimeout(deadline);
    window.clearTimeout(completion);
    window.removeEventListener("message", receive);
    window.removeEventListener("pagehide", interrupt);
  }

  function interrupt() {
    cleanup();
    status.textContent = "This page can no longer confirm the connection result. Return to the original page or check Telegram settings.";
  }

  if (!context || !proof || !owner || owner.closed) {
    interrupt();
    return;
  }

  function send(type, extra) {
    owner.postMessage(Object.assign({
      type: type, protocol: 2, operationId: context.operationId, bot: context.bot
    }, extra), context.targetOrigin);
  }

  function deliver() {
    if (owner.closed || Date.now() >= expiresAt) { interrupt(); return; }
    send("telegram-auth-bridge-ready");
    if (ready && proof) send("telegram-auth", { data: proof });
  }

  function receive(event) {
    if (!terminal && Date.now() >= expiresAt) { interrupt(); return; }
    var message = event.data;
    if (disposed || event.source !== owner || event.origin !== context.targetOrigin ||
        !message || message.protocol !== 2 || message.operationId !== context.operationId ||
        message.bot !== context.bot || owner.closed) return;
    if (terminal) {
      if (message.type === "telegram-auth-result" && message.status === terminal) {
        send("telegram-auth-ack", { stage: "result" });
      }
      return;
    }
    if (message.type === "telegram-auth-ready") {
      ready = true;
      deliver();
    } else if (message.type === "telegram-auth-ack" && message.stage === "identity" && ready) {
      proof = null;
      window.clearInterval(retry);
    } else if (message.type === "telegram-auth-result" && outcomes.indexOf(message.status) !== -1) {
      // The initiating App may finish via Telegram's native message before this
      // bridge delivers identity. Only its correlated binding outcome is authority.
      terminal = message.status;
      proof = null;
      window.clearInterval(retry);
      window.clearTimeout(deadline);
      send("telegram-auth-ack", { stage: "result" });
      var messages = {
        linked: "Connection confirmed. Opening Telegram settings.",
        cancelled: "Connection cancelled. Restart from the original page when ready.",
        failed: "The connection could not be completed. Check settings before retrying.",
        conflict: "This Telegram account conflicts with an existing connection. Check settings.",
        expired: "Telegram authorization expired. Restart from the original page.",
        interrupted: "This connection attempt was interrupted. Restart from the original page.",
        prerequisite: "Complete account setup in the original page before connecting Telegram."
      };
      status.textContent = messages[terminal];
      // A short bounded grace period acknowledges duplicate results before leaving.
      completion = window.setTimeout(function() {
        cleanup();
        if (terminal === "linked") window.location.replace(settingsUrl);
      }, 250);
    }
  }

  window.addEventListener("message", receive);
  window.addEventListener("pagehide", interrupt);
  // Browser timers belong to this document; every terminal/pagehide path releases them.
  retry = window.setInterval(deliver, 500);
  deadline = window.setTimeout(interrupt, 120000);
  deliver();
}
`;

/** Telegram's registered callback stays on the API origin, including for v2. */
export function telegramAuthCallbackV2Response(url: URL): Response {
  const params = url.searchParams;
  const targetOrigin = allowedCorsOrigin(
    params.get("targetOrigin") ?? undefined,
  );
  const operationId = params.get("operationId");
  const valid =
    ["callbackProtocol", "targetOrigin", "operationId", "bot"].every((key) => {
      return params.getAll(key).length === 1;
    }) &&
    params.get("callbackProtocol") === "2" &&
    targetOrigin !== null &&
    targetOrigin === params.get("targetOrigin") &&
    operationId !== null &&
    operationId.length === 36 &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      operationId,
    ) &&
    params.get("bot") === OFFICIAL_TELEGRAM_BOT_ID;
  const context = valid
    ? { protocol: 2, operationId, bot: OFFICIAL_TELEGRAM_BOT_ID, targetOrigin }
    : null;
  const settings = new URL(
    INTEGRATION_SETTINGS_PATHS.telegram,
    valid && targetOrigin ? targetOrigin : new URL(env("APP_URL")).origin,
  );
  settings.searchParams.set("bot", OFFICIAL_TELEGRAM_BOT_ID);

  // Only validated, non-credential context enters HTML. Provider query/fragment
  // proof is read by the browser, never reflected into the response or stored.
  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer">
<title>Telegram connection</title></head><body>
<h1>Telegram connection</h1>
<p id="status" role="status">Keep this page open. Return to the original page or check Telegram settings for the connection result.</p>
<a id="settings" rel="noreferrer">View Telegram settings</a>
<script>
${CALLBACK_SCRIPT}
runTelegramCallback(${JSON.stringify(context)}, ${JSON.stringify(settings.href)}, ${JSON.stringify(TELEGRAM_AUTH_CALLBACK_OUTCOMES)});
</script></body></html>`;
  return new Response(html, {
    status: valid ? 200 : 422,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    },
  });
}
