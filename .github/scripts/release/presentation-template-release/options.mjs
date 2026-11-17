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

export function validateOptions(args, valueOptions, flagOptions = []) {
  const allowed = new Set([...valueOptions, ...flagOptions]);
  const flags = new Set(flagOptions);
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (!allowed.has(name)) {
      throw new Error(`Unsupported option: ${name}`);
    }
    if (seen.has(name)) {
      throw new Error(`Duplicate option: ${name}`);
    }
    seen.add(name);
    if (!flags.has(name)) {
      requiredOption(args, name);
      index += 1;
    }
  }
}

export function outputFormatOption(args) {
  return args.includes("--format") ? requiredOption(args, "--format") : "html";
}

export function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}
