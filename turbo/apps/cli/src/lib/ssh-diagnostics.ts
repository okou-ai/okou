export function printSshDiagnostics(result: {
  type: string;
  diagnostic_text?: string;
}) {
  if (result.diagnostic_text) console.error(result.diagnostic_text);
}
