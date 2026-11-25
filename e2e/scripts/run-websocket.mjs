import { readFileSync } from "node:fs";

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const runId = process.argv[2];
const { wssUrl, ticket } = parseJson(readFileSync(0, "utf8")) ?? {};
const url = typeof wssUrl === "string" ? URL.parse(wssUrl) : null;
if (
  !url ||
  url.protocol !== "wss:" ||
  url.username ||
  url.password ||
  url.search ||
  url.hash ||
  !url.pathname.startsWith("/runners/") ||
  !url.pathname.endsWith(`/sandbox/runs/${runId}`) ||
  typeof ticket !== "string" ||
  !/^[A-Za-z0-9_-]{43}$/u.test(ticket)
) {
  throw new Error("Invalid Run WebSocket bootstrap response");
}

const socket = new WebSocket(url);
const deadline = AbortSignal.timeout(10_000);
try {
  await new Promise((resolve, reject) => {
    deadline.addEventListener(
      "abort",
      () => reject(new Error("Timed out waiting for auth.ok")),
      { once: true },
    );
    socket.onopen = () => socket.send(JSON.stringify({ ticket }));
    socket.onerror = () => reject(new Error("Run WebSocket connection failed"));
    socket.onclose = () =>
      reject(new Error("Run WebSocket closed before auth.ok"));
    socket.onmessage = ({ data }) => {
      if (typeof data === "string" && parseJson(data)?.type === "auth.ok") {
        resolve();
      } else {
        reject(new Error("Expected auth.ok from the Run WebSocket"));
      }
    };
  });
} finally {
  socket.close();
}
