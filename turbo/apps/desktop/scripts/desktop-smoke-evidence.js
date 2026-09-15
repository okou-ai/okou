const packageMetadata = require("../package.json");

function requireEvidence(condition) {
  if (!condition) throw new Error("invalid_packaged_evidence");
}

function keys(value, expected) {
  requireEvidence(value && typeof value === "object" && !Array.isArray(value));
  requireEvidence(Object.keys(value).sort().join() === expected.sort().join());
}

function dormantDriver(driver) {
  keys(driver, [
    "actual",
    "phase",
    "lifecycleElapsedMs",
    "cleanupPending",
    "error",
    "canRetry",
  ]);
  requireEvidence(
    driver.phase === "stopped" &&
      driver.cleanupPending === false &&
      driver.error === null,
  );
  requireEvidence(typeof driver.canRetry === "boolean");
  requireEvidence(
    Number.isSafeInteger(driver.lifecycleElapsedMs) &&
      driver.lifecycleElapsedMs >= 0 &&
      driver.lifecycleElapsedMs <= 120_000,
  );
  if (driver.actual !== null) {
    keys(driver.actual, ["id", "generation", "version"]);
    requireEvidence(
      driver.actual.id === "okou" && driver.actual.version === null,
    );
    requireEvidence(
      Number.isSafeInteger(driver.actual.generation) &&
        driver.actual.generation > 0,
    );
  }
}

/** Parse only the one bounded metadata record from the actual child process. */
function readDesktopSmokeEvidence(stdout, identity) {
  const prefix = "[smoke-test] evidence ";
  const records = stdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith(prefix));
  requireEvidence(records.length === 1 && records[0].length <= 8192);
  const evidence = JSON.parse(records[0].slice(prefix.length));
  const common = [
    "schemaVersion",
    "desktopVersion",
    "electronVersion",
    "bundleId",
  ];
  keys(evidence, [...common, "bridge"]);
  requireEvidence(
    evidence.schemaVersion === 1 &&
      evidence.desktopVersion === packageMetadata.version,
  );
  requireEvidence(
    evidence.electronVersion === packageMetadata.devDependencies.electron &&
      evidence.bundleId === identity.bundleId,
  );
  validateDormantEvidence(evidence, identity);
  return evidence;
}

function validateDormantEvidence(evidence, identity) {
  const bridge = evidence.bridge;
  keys(bridge, [
    "auth",
    "authCompletionRejected",
    "computerUse",
    "developerTools",
    "driverControls",
    "driver",
    "settledDriver",
    "identity",
  ]);
  requireEvidence(
    bridge.auth === true &&
      bridge.authCompletionRejected === true &&
      bridge.computerUse === true &&
      bridge.developerTools === true &&
      bridge.driverControls === true,
  );
  keys(bridge.identity, ["product", "brandName", "displayName"]);
  requireEvidence(
    ["product", "brandName", "displayName"].every(
      (key) => bridge.identity[key] === identity[key],
    ),
  );
  dormantDriver(bridge.driver);
  dormantDriver(bridge.settledDriver);
}

module.exports = { readDesktopSmokeEvidence };
