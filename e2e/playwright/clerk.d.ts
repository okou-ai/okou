export {};

declare global {
  interface Window {
    Clerk?: {
      loaded: boolean;
      readonly publishableKey: string;
      client?: {
        readonly signIn?: {
          readonly firstFactorVerification?: {
            readonly strategy: string | null;
            readonly status: string | null;
          } | null;
        } | null;
      } | null;
      user?: { readonly id: string } | null;
      organization?: { readonly id: string } | null;
      setActive(options: { readonly organization: string }): Promise<void>;
      session?: {
        getToken(options?: {
          readonly skipCache?: boolean;
        }): Promise<string | null>;
      } | null;
    };
  }
}
