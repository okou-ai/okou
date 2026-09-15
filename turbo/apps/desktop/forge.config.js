const os = require("node:os");
const path = require("node:path");

const packageMetadata = require("./package.json");
const desktopBrandAssets = require("./src/desktop-brand-assets.json");
const { resolveDesktopBuildConfig } = require("./scripts/desktop-build-config");
const {
  resolveDesktopNotarizeApiEnvironment,
} = require("./scripts/desktop-notarize-api-environment");
const {
  resolveDesktopNotarizeKeychainEnvironment,
} = require("./scripts/desktop-notarize-keychain-environment");
const {
  resolveDesktopSigningIdentityEnvironment,
} = require("./scripts/desktop-signing-identity-environment");

const MINIMUM_MACOS_VERSION = "14.0";
const DEFAULT_NOTARIZE_KEYCHAIN_PROFILE = "vm0-desktop-notary";
const DEFAULT_NOTARIZE_KEYCHAIN = path.join(
  os.homedir(),
  "Library",
  "Keychains",
  "login.keychain-db",
);
const DEVELOPER_ID_APPLICATION_IDENTITY =
  "Developer ID Application: Max & Zoe, Inc. (C5UWSXYB67)";
const codeSigningIdentity =
  resolveDesktopSigningIdentityEnvironment() ??
  (process.env.CI === "true" ? "-" : DEVELOPER_ID_APPLICATION_IDENTITY);

function desktopNotarizeOptions() {
  if (process.env.OKOU_DESKTOP_NOTARIZE !== "true") {
    return undefined;
  }

  const keychainEnvironment = resolveDesktopNotarizeKeychainEnvironment();
  if (keychainEnvironment) {
    return {
      keychainProfile: keychainEnvironment.keychainProfile,
      keychain: keychainEnvironment.keychain ?? DEFAULT_NOTARIZE_KEYCHAIN,
    };
  }

  const apiEnvironment = resolveDesktopNotarizeApiEnvironment();
  if (apiEnvironment) {
    return apiEnvironment;
  }

  return {
    keychainProfile: DEFAULT_NOTARIZE_KEYCHAIN_PROFILE,
    keychain: DEFAULT_NOTARIZE_KEYCHAIN,
  };
}

const { identity: desktopIdentity } = resolveDesktopBuildConfig();
const osxNotarize = desktopNotarizeOptions();

// Forge 7 bundles Packager 18, whose CommonJS signing adapter cannot call osx-sign v2.
async function signPackagedDarwinApps(_forgeConfig, packageResult) {
  if (
    packageResult.platform !== "darwin" ||
    process.env.OKOU_DESKTOP_SKIP_SIGNING === "true"
  ) {
    return;
  }

  const { sign } = await import("@electron/osx-sign");
  const notarizeModule = osxNotarize
    ? await import("@electron/notarize")
    : undefined;

  for (const outputPath of packageResult.outputPaths) {
    const appPath = path.join(outputPath, `${desktopIdentity.displayName}.app`);

    await sign({
      app: appPath,
      batchCodesignCalls: true,
      identity: codeSigningIdentity,
      identityValidation: codeSigningIdentity !== "-",
      platform: "darwin",
      version: packageMetadata.devDependencies.electron,
      ...(codeSigningIdentity === "-" ? { timestamp: "none" } : {}),
    });

    if (notarizeModule) {
      await notarizeModule.notarize({
        appPath,
        ...osxNotarize,
      });
    }
  }
}

module.exports = {
  hooks: {
    postPackage: signPackagedDarwinApps,
  },
  packagerConfig: {
    name: desktopIdentity.displayName,
    executableName: desktopIdentity.displayName,
    appBundleId: desktopIdentity.bundleId,
    icon: path.join(__dirname, "assets", desktopBrandAssets.appIconBaseName),
    extendInfo: {
      CFBundleIconFile: "icon.icns",
      LSMinimumSystemVersion: MINIMUM_MACOS_VERSION,
      // macOS refuses to hand over the microphone without a stated purpose.
      NSMicrophoneUsageDescription:
        "Okou records your microphone so a screen recording can carry your narration.",
    },
    asar: false,
    extraResource: [
      path.join(__dirname, "native", "dist", "native"),
      path.join(__dirname, "dist", "mcp"),
    ],
    protocols: [
      {
        name: desktopIdentity.authProtocolName,
        schemes: [desktopIdentity.authScheme],
      },
    ],
    ignore: [
      /^\/node_modules($|\/)/,
      /^\/src($|\/)/,
      /^\/native($|\/)/,
      /^\/\.cache($|\/)/,
      /^\/scripts($|\/)/,
      /^\/\.turbo($|\/)/,
      /^\/\.npmrc$/,
      /^\/README\.md$/,
      /^\/forge\.config\.js$/,
      /^\/tsconfig\.json$/,
      /^\/tsup\.electron\.config\.js$/,
      /^\/tsup\.mcp-filesystem\.config\.js$/,
      /^\/vite\.renderer\.config\.ts$/,
      /^\/vitest\.config\.ts$/,
    ],
  },
  rebuildConfig: {},
  makers: [
    {
      name: "@electron-forge/maker-zip",
      platforms: ["darwin"],
    },
  ],
};
