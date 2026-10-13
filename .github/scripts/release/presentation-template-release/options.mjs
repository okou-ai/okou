export function requiredOption(args, name) {
  const index = args.indexOf(name);
  if (index === -1) {
    throw new Error(`${name} is required`);
  }

  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

export function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}
