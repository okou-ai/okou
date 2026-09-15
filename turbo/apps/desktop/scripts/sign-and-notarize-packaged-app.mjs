#!/usr/bin/env node

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { notarize } from "@electron/notarize";
import { sign } from "@electron/osx-sign";

import desktopNotarizeApiEnvironment from "./desktop-notarize-api-environment.js";
import desktopSigningIdentityEnvironment from "./desktop-signing-identity-environment.js";

const { resolveDesktopNotarizeApiEnvironment } = desktopNotarizeApiEnvironment;
const { resolveDesktopSigningIdentityEnvironment } =
  desktopSigningIdentityEnvironment;

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const desktopDirectory = path.resolve(scriptDirectory, "..");
const packageMetadata = JSON.parse(
  await readFile(path.join(desktopDirectory, "package.json"), "utf8"),
);
const desktopIdentities = JSON.parse(
  await readFile(
    path.join(desktopDirectory, "src", "desktop-identities.json"),
    "utf8",
  ),
);

function requiredEnvironmentVariable(name, value) {
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function optionsFromArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!value) {
      throw new Error(`Missing value for ${name}`);
    }
    if (name === "--app") {
      options.appPath = path.resolve(value);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${name}`);
  }
  if (!options.appPath) {
    throw new Error(
      "Usage: sign-and-notarize-packaged-app.mjs --app <app-path>",
    );
  }
  return options;
}

const options = optionsFromArguments(process.argv.slice(2));
const expectedAppName = `${desktopIdentities.okou.production.displayName}.app`;
const appStat = await stat(options.appPath);
if (
  !appStat.isDirectory() ||
  path.basename(options.appPath) !== expectedAppName
) {
  throw new Error(
    `Expected a ${expectedAppName} directory: ${options.appPath}`,
  );
}

const notarizeOptions = resolveDesktopNotarizeApiEnvironment();
if (!notarizeOptions) {
  throw new Error(
    "Desktop notarization API environment is required: state=absent",
  );
}

await sign({
  app: options.appPath,
  batchCodesignCalls: true,
  identity: requiredEnvironmentVariable(
    "OKOU_DESKTOP_SIGNING_IDENTITY",
    resolveDesktopSigningIdentityEnvironment(),
  ),
  identityValidation: true,
  platform: "darwin",
  version: packageMetadata.devDependencies.electron,
});

await notarize({
  appPath: options.appPath,
  ...notarizeOptions,
});
