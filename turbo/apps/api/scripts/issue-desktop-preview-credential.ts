import { writeFile } from "node:fs/promises";
import { issueDesktopPreviewCredential } from "../src/lib/desktop-preview-credential";

const [origin, output] = process.argv.slice(2);
const secret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
if (!origin || !output || !secret) {
  throw new Error(
    "Set VERCEL_AUTOMATION_BYPASS_SECRET and pass the PR API origin and a new private output file",
  );
}
const credential = await issueDesktopPreviewCredential(origin, secret);
await writeFile(output, JSON.stringify(credential), {
  mode: 0o600,
  flag: "wx",
});
