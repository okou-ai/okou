/** Worker-build-only replacement for Resend's optional React renderer. */
export function render(): never {
  throw new Error(
    "React email rendering via @react-email/render is unsupported in this Worker build. Supply pre-rendered html/text to Resend, or route React email rendering to the Node/Vercel API deployment. Add a reviewed Workers-compatible renderer before enabling React templates here.",
  );
}
