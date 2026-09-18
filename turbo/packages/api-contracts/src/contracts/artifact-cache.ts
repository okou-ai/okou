/** Browser caching for immutable content behind an expiring artifact credential. */
export const PRIVATE_ARTIFACT_CACHE_CONTROL =
  "private, max-age=31536000, must-revalidate";

/** Authorization, mutable delivery, and error responses must reach the server. */
export const PRIVATE_NO_STORE_CACHE_CONTROL = "private, no-store";
