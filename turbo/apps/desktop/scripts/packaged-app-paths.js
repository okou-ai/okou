const path = require("node:path");

const { resolveDesktopBuildConfig } = require("./desktop-build-config");

function packagedAppPaths(options = {}) {
  const appRoot = path.resolve(__dirname, "..");
  const appName = resolveDesktopBuildConfig(options).identity.displayName;
  const appBundlePath = options.appBundlePath
    ? path.resolve(options.appBundlePath)
    : path.join(
        appRoot,
        "out",
        `${appName}-${process.platform}-${process.arch}`,
        `${appName}.app`,
      );

  return {
    appBundlePath,
    executablePath: path.join(appBundlePath, "Contents", "MacOS", appName),
    mainBundlePath: path.join(
      appBundlePath,
      "Contents",
      "Resources",
      "app",
      "dist",
      "main.js",
    ),
    mcpBundlePath: path.join(
      appBundlePath,
      "Contents",
      "Resources",
      "mcp",
      "index.mjs",
    ),
  };
}

module.exports = { packagedAppPaths };
