import { literal, object } from "zod";
import { appStateRunnerSchema } from "@okouai/api-contracts/contracts/computer-use";
import { invokeRunnerRpc } from "../../lib/runner-rpc";

const info = object({
  type: literal("result"),
  data: appStateRunnerSchema,
}).strict();

/** An older Runner or a CLI outside its assigned sandbox offers no direct transport. */
export async function appStateRunnerIdentity() {
  let bytes = Buffer.alloc(0);
  let owner: typeof appStateRunnerSchema._output | undefined;
  return await invokeRunnerRpc(
    "computer.appState.info",
    {},
    {
      async read(chunk: unknown) {
        if (!Buffer.isBuffer(chunk) || bytes.length + chunk.length > 1024)
          throw new Error("Invalid Runner identity");
        bytes = Buffer.concat([bytes, chunk]);
      },
      finish(code, termination) {
        if (code !== 0 || termination !== null) return;
        const parsed = info.safeParse(JSON.parse(bytes.toString("utf8")));
        if (parsed.success) owner = parsed.data.data;
      },
      fail() {
        owner = undefined;
      },
      output() {
        return owner;
      },
    },
    true,
    AbortSignal.timeout(1000),
  );
}
