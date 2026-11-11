import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import {
  checkGeneratedKotlin,
  generatedKotlinRelativeDirectory,
  renderKotlinFiles,
} from "../kotlin-bindings/generate";
import { kotlinTokens } from "../kotlin-bindings/source-tokens";

interface AndroidConsumptionFinding {
  readonly file: string;
  readonly line: number;
  readonly problem: string;
}

export async function checkAndroidConsumption(
  root: string,
): Promise<readonly AndroidConsumptionFinding[]> {
  const findings: AndroidConsumptionFinding[] = (
    await checkGeneratedKotlin(root)
  ).map((problem) => {
    return {
      file: generatedKotlinRelativeDirectory,
      line: 1,
      problem,
    };
  });
  const generated = new Set(
    [...renderKotlinFiles().keys()].map((name) => {
      return `${generatedKotlinRelativeDirectory}/${name}`;
    }),
  );
  const files = await kotlinFiles(join(root, "android"));
  for (const path of files) {
    const file = relative(root, path).replaceAll("\\", "/");
    if (generated.has(file)) continue;
    const source = await readFile(path, "utf8");
    const tokens = kotlinTokens(source);
    for (const [index, token] of tokens.entries()) {
      const qualified = tokens
        .slice(index, index + 4)
        .map((item) => {
          return item.text;
        })
        .join("");
      if (
        qualified === "retrofit2.http." ||
        (token.string && /^"(?:""|)\/api\//u.test(token.text))
      ) {
        findings.push({
          file,
          line: source.slice(0, token.offset).split("\n").length,
          problem:
            "Declare first-party API methods/paths in kotlin-bindings/bindings.ts and regenerate; manual Retrofit declarations/raw API paths are not inventoried.",
        });
      }
    }
  }
  return findings;
}

async function kotlinFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (
        !["build", ".gradle", ".kotlin", "test", "androidTest"].includes(
          entry.name,
        )
      )
        files.push(...(await kotlinFiles(path)));
    } else if (entry.name.endsWith(".kt")) files.push(path);
  }
  return files.sort();
}
