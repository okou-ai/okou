const ESC = "\u001b";
const ANSI_PATTERN = new RegExp(`${ESC}\\[[0-9;]*m`, "g");

export function stripAnsi(s: string): string {
  return s.replace(ANSI_PATTERN, "");
}

export function padEndAnsi(s: string, width: number): string {
  const visible = stripAnsi(s).length;
  return s + " ".repeat(Math.max(0, width - visible));
}
