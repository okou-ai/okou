declare module "pandoc-wasm" {
  export function convert(
    options: Readonly<Record<string, string>>,
    input: string,
    files: Readonly<Record<string, Blob>>,
  ): Promise<{
    readonly stdout: string;
    readonly files: Readonly<Partial<Record<string, Blob>>>;
  }>;
}
