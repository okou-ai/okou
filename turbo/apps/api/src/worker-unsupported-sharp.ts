/**
 * Worker-build-only replacement for sharp's native libvips addon.
 * The Vercel build continues to import the real sharp package.
 */
export default function unsupportedSharp(): never {
  throw new Error(
    "This image operation requires sharp/libvips, which is unsupported on Cloudflare Workers. Route this operation to the Node/Vercel API deployment or implement an approved Workers-native image processor before enabling it here.",
  );
}
