import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { probeBrowser } from "./browser.mjs";
import { safeHeaders } from "./netlog.mjs";

const exec = promisify(execFile);
const originalSource = "0ed1efd836c911898e4b13bff35fc3b74afcf81b";
const preview = "https://8c29615c-okou-app-preview.vm0.workers.dev";
const staticOrigin = "https://static.okou.io";
const assets = [
  {
    name: "index-C7OwusiM.js",
    bytes: 4058960,
    sha256: "cab14c652a9f9c4fed5e0bc6cff27ce68de05c8ef1dda91b057cb48f70015670",
  },
  {
    name: "index-6CUwcaiy.css",
    bytes: 366376,
    sha256: "cf0d8de2f4108c23ce9f72ac40f29cded912308be1b6158d19a69d3d6776903e",
  },
  {
    name: "vendor-3-BipdyGPd.js",
    bytes: 762359,
    sha256: "eb38c470cf8347cc7e5f5dfb9ad5f3f37d926bd197fec8b9750423499a98a823",
  },
];

export async function probeResource({
  url,
  protocol,
  encoding,
  bodyPath,
  headerPath,
  expected,
  expectedBuildSha,
}) {
  let stdout;
  let exitCode = 0;
  try {
    ({ stdout } = await exec(
      "curl",
      [
        "--disable",
        "--silent",
        "--show-error",
        "--max-time",
        "30",
        "--connect-timeout",
        "10",
        protocol === "h2" ? "--http2" : "--http1.1",
        "--compressed",
        "--header",
        `Accept-Encoding: ${encoding}`,
        "--dump-header",
        headerPath,
        "--output",
        bodyPath,
        "--write-out",
        "%{json}",
        url,
      ],
      { timeout: 35_000, maxBuffer: 128 * 1024 },
    ));
  } catch (error) {
    // Record the actual failed operation; never retry it or publish raw stderr.
    stdout = error.stdout;
    exitCode = Number.isInteger(error.code) ? error.code : -1;
  }
  const metrics = stdout ? JSON.parse(stdout) : {};
  const body = await readFile(bodyPath).catch((error) => {
    if (error.code === "ENOENT") return Buffer.alloc(0);
    throw error;
  });
  const headerText = await readFile(headerPath, "utf8").catch((error) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  const allHeaders = Object.fromEntries(
    headerText.split(/\r?\n/u).flatMap((line) => {
      const match = /^([^:]+):\s*(.*)$/u.exec(line);
      return match ? [[match[1].toLowerCase(), match[2]]] : [];
    }),
  );
  const sha256 = createHash("sha256").update(body).digest("hex");
  const encodingMatches =
    encoding === "identity"
      ? !allHeaders["content-encoding"] ||
        allHeaders["content-encoding"] === "identity"
      : allHeaders["content-encoding"] === encoding;
  const result = {
    url,
    requestedProtocol: protocol,
    requestedEncoding: encoding,
    curlExitCode: exitCode,
    bytes: body.length,
    sha256,
    encodingMatches,
    headers: safeHeaders(allHeaders),
    ...(expectedBuildSha
      ? {
          buildMatches: body
            .toString("utf8")
            .includes(
              `name="okou-app-git-commit-sha" content="${expectedBuildSha}"`,
            ),
        }
      : {}),
    metrics: Object.fromEntries(
      [
        "http_code",
        "http_version",
        "remote_ip",
        "local_ip",
        "time_connect",
        "time_appconnect",
        "time_starttransfer",
        "time_total",
        "size_download",
        "speed_download",
        "ssl_verify_result",
      ].map((key) => [key, metrics[key]]),
    ),
    ok:
      exitCode === 0 &&
      encodingMatches &&
      metrics.http_code === 200 &&
      metrics.http_version === (protocol === "h2" ? "2" : "1.1") &&
      (!expected ||
        (body.length === expected.bytes && sha256 === expected.sha256)),
  };
  await rm(bodyPath, { force: true });
  await rm(headerPath, { force: true });
  return result;
}

async function main() {
  if (process.argv.length !== 4 || !/^[1-4]$/u.test(process.argv[3])) {
    throw new Error(
      "Usage: node probe.mjs <new-output-directory> <sample:1-4>",
    );
  }
  const root = resolve(process.argv[2]);
  await mkdir(root, { mode: 0o700 });
  const outputDirectory = join(root, "results");
  const rawDirectory = join(root, "raw");
  await mkdir(outputDirectory);
  await mkdir(rawDirectory, { mode: 0o700 });
  const sample = Number(process.argv[3]);
  const protocols = sample % 2 ? ["h2", "h1"] : ["h1", "h2"];
  const context = {
    originalSource,
    preview,
    staticOrigin,
    sample,
    utc: new Date().toISOString(),
    driverSource: process.env.GITHUB_SHA ?? "local",
    runId: process.env.GITHUB_RUN_ID,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT,
    runnerName: process.env.RUNNER_NAME,
    curlVersion: (await exec("curl", ["--version"])).stdout.trim(),
    resourceModel:
      "concurrent fetches in an intercepted empty same-origin document; no application/authentication execution",
  };
  await writeFile(
    join(outputDirectory, "context.json"),
    JSON.stringify(context, null, 2),
  );

  const document = await probeResource({
    url: `${preview}/sign-in`,
    protocol: "h2",
    encoding: "zstd",
    bodyPath: join(rawDirectory, "document.body"),
    headerPath: join(rawDirectory, "document.headers"),
    expectedBuildSha: originalSource,
  });
  // Resource hashes are fixed independently of mutable PR aliases. The original
  // version's document is checked separately without executing Clerk or the app.
  await writeFile(
    join(outputDirectory, "document.json"),
    JSON.stringify(document, null, 2),
  );

  const cases = [];
  for (const protocol of protocols) {
    for (const encoding of ["zstd", "identity"]) {
      for (const [originName, origin] of [
        ["preview", preview],
        ["static", staticOrigin],
      ]) {
        for (const asset of assets)
          cases.push({ protocol, encoding, originName, origin, asset });
      }
    }
  }
  const results = [];
  // Four concurrent clients, 30 seconds per transfer, no retries.
  for (let start = 0; start < cases.length; start += 4) {
    results.push(
      ...(await Promise.all(
        cases.slice(start, start + 4).map(async (item) => {
          const name = `${item.originName}-${item.protocol}-${item.encoding}-${item.asset.name}`;
          const record = await probeResource({
            url: `${item.origin}/okou-app/assets/${item.asset.name}`,
            protocol: item.protocol,
            encoding: item.encoding,
            expected: item.asset,
            bodyPath: join(rawDirectory, `${name}.body`),
            headerPath: join(rawDirectory, `${name}.headers`),
          });
          await writeFile(
            join(outputDirectory, `${name}.json`),
            JSON.stringify(record, null, 2),
          );
          console.log(
            JSON.stringify({
              name,
              ok: record.ok,
              exitCode: record.curlExitCode,
              protocol: record.metrics.http_version,
              bytes: record.bytes,
              seconds: record.metrics.time_total,
              headers: record.headers,
            }),
          );
          return record;
        }),
      )),
    );
  }
  const browsers = [];
  for (const protocol of protocols) {
    const result = await probeBrowser({
      origin: preview,
      assets,
      protocol,
      rawDirectory,
      outputDirectory,
    });
    browsers.push(result);
    console.log(
      JSON.stringify({
        browser: protocol,
        ok: result.ok,
        transfers: result.transfers,
      }),
    );
  }
  const ok =
    document.ok &&
    document.buildMatches &&
    results.every((result) => result.ok) &&
    browsers.every((result) => result.ok);
  await writeFile(
    join(outputDirectory, "summary.json"),
    JSON.stringify({ ok, document, curl: results, browsers }, null, 2),
  );
  const rows = results.map(
    (result) =>
      `| ${new URL(result.url).hostname} | ${new URL(result.url).pathname.split("/").at(-1)} | ${result.requestedProtocol}/${result.requestedEncoding} | ${result.metrics.http_version} | ${result.curlExitCode} | ${result.bytes} | ${result.metrics.time_total} | ${result.headers["cf-ray"] ?? "unavailable"} |`,
  );
  await writeFile(
    join(outputDirectory, "summary.md"),
    [
      `# Preview resource sample ${sample}`,
      `Original app source: \`${originalSource}\`. Driver source: \`${context.driverSource}\`.`,
      `Document build matches: ${document.buildMatches}. All comparisons passed: ${ok}.`,
      "",
      "| Origin | Asset | Requested | Actual HTTP | curl exit | Decoded bytes | Seconds | CF-Ray |",
      "| --- | --- | --- | --- | --- | --- | --- | --- |",
      ...rows,
      "",
      ...browsers.map(
        (result) =>
          `Browser ${result.requestedProtocol}: ${result.ok ? "PASS" : "FAIL"}, Chromium ${result.browserVersion}.`,
      ),
      "",
      "These are read-only transport probes, not authentication/E2E acceptance. Runner region is recorded in this job's provisioner log.",
    ].join("\n") + "\n",
  );
  if (!ok) process.exitCode = 1;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  await main();
}
