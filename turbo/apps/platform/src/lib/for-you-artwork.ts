import { platformStaticAssetUrl } from "./static-assets.ts";

// Okou-original 2.5:1 covers for the For you banner.
export const forYouCovers = [
  {
    id: "cover-01",
    src: platformStaticAssetUrl(
      "views/for-you/assets/cover-01-dae5e2af3215.webp",
    ),
    thumbnail: platformStaticAssetUrl(
      "views/for-you/assets/cover-01-thumb-beb59cdbe6bd.webp",
    ),
  },
  {
    id: "cover-02",
    src: platformStaticAssetUrl(
      "views/for-you/assets/cover-02-c4e423a845da.webp",
    ),
    thumbnail: platformStaticAssetUrl(
      "views/for-you/assets/cover-02-thumb-6e0c54da4455.webp",
    ),
  },
  {
    id: "cover-03",
    src: platformStaticAssetUrl(
      "views/for-you/assets/cover-03-7833024f9308.webp",
    ),
    thumbnail: platformStaticAssetUrl(
      "views/for-you/assets/cover-03-thumb-72da71763deb.webp",
    ),
  },
  {
    id: "cover-04",
    src: platformStaticAssetUrl(
      "views/for-you/assets/cover-04-8bd71d3d0364.webp",
    ),
    thumbnail: platformStaticAssetUrl(
      "views/for-you/assets/cover-04-thumb-eaf89a5a0480.webp",
    ),
  },
  {
    id: "cover-05",
    src: platformStaticAssetUrl(
      "views/for-you/assets/cover-05-c0518205f46a.webp",
    ),
    thumbnail: platformStaticAssetUrl(
      "views/for-you/assets/cover-05-thumb-87f12089b719.webp",
    ),
  },
  {
    id: "cover-06",
    src: platformStaticAssetUrl(
      "views/for-you/assets/cover-06-51bbed54ce35.webp",
    ),
    thumbnail: platformStaticAssetUrl(
      "views/for-you/assets/cover-06-thumb-95ca9506d7b5.webp",
    ),
  },
  {
    id: "cover-07",
    src: platformStaticAssetUrl(
      "views/for-you/assets/cover-07-e4c980c62f38.webp",
    ),
    thumbnail: platformStaticAssetUrl(
      "views/for-you/assets/cover-07-thumb-ad9879df695e.webp",
    ),
  },
  {
    id: "cover-08",
    src: platformStaticAssetUrl(
      "views/for-you/assets/cover-08-b848542ef383.webp",
    ),
    thumbnail: platformStaticAssetUrl(
      "views/for-you/assets/cover-08-thumb-e4b71d5847f1.webp",
    ),
  },
  {
    id: "cover-09",
    src: platformStaticAssetUrl(
      "views/for-you/assets/cover-09-b4d14a817e11.webp",
    ),
    thumbnail: platformStaticAssetUrl(
      "views/for-you/assets/cover-09-thumb-2c41b44bce1d.webp",
    ),
  },
  {
    id: "cover-10",
    src: platformStaticAssetUrl(
      "views/for-you/assets/cover-10-eb2c8032f5bc.webp",
    ),
    thumbnail: platformStaticAssetUrl(
      "views/for-you/assets/cover-10-thumb-b31ebc318796.webp",
    ),
  },
  {
    id: "cover-11",
    src: platformStaticAssetUrl(
      "views/for-you/assets/cover-11-9a0bb233c32b.webp",
    ),
    thumbnail: platformStaticAssetUrl(
      "views/for-you/assets/cover-11-thumb-32fd94948836.webp",
    ),
  },
  {
    id: "cover-12",
    src: platformStaticAssetUrl(
      "views/for-you/assets/cover-12-fa0354c4a6e0.webp",
    ),
    thumbnail: platformStaticAssetUrl(
      "views/for-you/assets/cover-12-thumb-2c69c0ec1771.webp",
    ),
  },
  {
    id: "cover-13",
    src: platformStaticAssetUrl(
      "views/for-you/assets/cover-13-6afd53add535.webp",
    ),
    thumbnail: platformStaticAssetUrl(
      "views/for-you/assets/cover-13-thumb-3a78b4a5581b.webp",
    ),
  },
  {
    id: "cover-14",
    src: platformStaticAssetUrl(
      "views/for-you/assets/cover-14-38ad560cb8ee.webp",
    ),
    thumbnail: platformStaticAssetUrl(
      "views/for-you/assets/cover-14-thumb-b2e919051b48.webp",
    ),
  },
  {
    id: "cover-15",
    src: platformStaticAssetUrl(
      "views/for-you/assets/cover-15-1fd78847e1e8.webp",
    ),
    thumbnail: platformStaticAssetUrl(
      "views/for-you/assets/cover-15-thumb-6a93a13eb6c8.webp",
    ),
  },
  {
    id: "cover-16",
    src: platformStaticAssetUrl(
      "views/for-you/assets/cover-16-db44fe9ad13b.webp",
    ),
    thumbnail: platformStaticAssetUrl(
      "views/for-you/assets/cover-16-thumb-8ff4893544d7.webp",
    ),
  },
  {
    id: "cover-17",
    src: platformStaticAssetUrl(
      "views/for-you/assets/cover-17-39b84fc3729c.webp",
    ),
    thumbnail: platformStaticAssetUrl(
      "views/for-you/assets/cover-17-thumb-2527d154ca8f.webp",
    ),
  },
  {
    id: "cover-18",
    src: platformStaticAssetUrl(
      "views/for-you/assets/cover-18-a36171f0dc3f.webp",
    ),
    thumbnail: platformStaticAssetUrl(
      "views/for-you/assets/cover-18-thumb-d742db4b4a7f.webp",
    ),
  },
] as const;

type ForYouCoverId = (typeof forYouCovers)[number]["id"];

// The first cover is the default.
export const DEFAULT_FOR_YOU_COVER_ID: ForYouCoverId = forYouCovers[0].id;

// The banner's bottom edge is a repeating torn-paper alpha mask.
export const forYouCoverTornEdge = platformStaticAssetUrl(
  "views/for-you/assets/cover-torn-edge-d189ebb4db4f.png",
);

export const forYouIllustrations = [
  platformStaticAssetUrl(
    "views/for-you/assets/unlock-opportunities-5dad4d002dd9.webp",
  ),
  platformStaticAssetUrl("views/for-you/assets/set-the-pace-f97eed2a96bb.webp"),
  platformStaticAssetUrl(
    "views/for-you/assets/nurture-growth-6e6ff40c2025.webp",
  ),
  platformStaticAssetUrl(
    "views/for-you/assets/build-bridges-9d26e0538819.webp",
  ),
  platformStaticAssetUrl(
    "views/for-you/assets/weigh-options-d635758c9672.webp",
  ),
  platformStaticAssetUrl(
    "views/for-you/assets/safeguard-work-497c586e2886.webp",
  ),
  platformStaticAssetUrl(
    "views/for-you/assets/set-priorities-51ca5e83a135.webp",
  ),
  platformStaticAssetUrl("views/for-you/assets/create-ideas-efe552fed29c.webp"),
  platformStaticAssetUrl("views/for-you/assets/launch-plans-4ccc6a7acd29.webp"),
  platformStaticAssetUrl(
    "views/for-you/assets/connect-the-dots-5236dc102140.webp",
  ),
  platformStaticAssetUrl(
    "views/for-you/assets/move-work-forward-f31576266db4.webp",
  ),
  platformStaticAssetUrl(
    "views/for-you/assets/bring-clarity-ad0f943f00c6.webp",
  ),
  platformStaticAssetUrl(
    "views/for-you/assets/read-and-review-9fbdfb7c9332.webp",
  ),
  platformStaticAssetUrl(
    "views/for-you/assets/sort-the-inbox-9ac460eb7d57.webp",
  ),
  platformStaticAssetUrl(
    "views/for-you/assets/deliver-results-f636c33819e2.webp",
  ),
  platformStaticAssetUrl("views/for-you/assets/find-the-way-2ded8e3697bb.webp"),
  platformStaticAssetUrl(
    "views/for-you/assets/organize-threads-85558c4b8a68.webp",
  ),
  platformStaticAssetUrl(
    "views/for-you/assets/take-a-breather-1edc7a6640d4.webp",
  ),
  platformStaticAssetUrl(
    "views/for-you/assets/share-insights-f3ae2febde35.webp",
  ),
  platformStaticAssetUrl(
    "views/for-you/assets/investigate-details-2340a6b01547.webp",
  ),
] as const;
