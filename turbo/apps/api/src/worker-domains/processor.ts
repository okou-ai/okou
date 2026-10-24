import { Buffer } from "node:buffer";
import { prepareGoogleSlides } from "../signals/services/google-slides-preparation";

async function workerFetch(request: Request): Promise<Response> {
  if (
    request.method !== "POST" ||
    new URL(request.url).pathname !== "/v1/prepare"
  ) {
    return new Response("Not found", { status: 404 });
  }
  const body = await request.formData();
  const filename = body.get("filename");
  const file = body.get("file");
  if (typeof filename !== "string" || !(file instanceof Blob)) {
    return new Response("Invalid preparation request", { status: 400 });
  }
  const signal = AbortSignal.any([
    request.signal,
    AbortSignal.timeout(300_000),
  ]);
  signal.throwIfAborted();
  const source = Buffer.from(await file.arrayBuffer());
  const prepared = await prepareGoogleSlides(
    { filename, file: source },
    (message, fields) => {
      console.warn("[api:google-slides-import]", message, fields);
    },
    signal,
  );
  signal.throwIfAborted();
  const result = new FormData();
  if (prepared.ok) {
    result.set(
      "result",
      JSON.stringify({ ok: true, textStyles: prepared.textStyles }),
    );
    result.set("file", new Blob([prepared.file]), "prepared.bin");
  } else {
    result.set("result", JSON.stringify(prepared));
  }
  return new Response(result);
}

export default { fetch: workerFetch };
