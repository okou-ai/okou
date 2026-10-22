// Node canary adapter; only requested env names are read, without API bootstrap.
export function env(name) {
  return process.env[name];
}
