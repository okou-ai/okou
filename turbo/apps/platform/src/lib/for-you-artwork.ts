import { platformStaticAssetUrl } from "./static-assets.ts";

// Okou-original 2.5:1 covers for the For you banner. `header` holds the colors
// the header uses over each cover: `wide` for containers of 56rem and up, where
// the header sits on 34-47% of the artwork's height, and `compact` below that,
// where it sits on the top 26%. Each `tint` is the average color of the left,
// middle and right of that band, pushed 20% away from the header ink and then
// far enough to reach 5:1 against it; `tone` picks white ink (`dark`) or dark
// ink (`light`) by the left part, under the title.
export const forYouCovers = [
  {
    id: "cover-01",
    src: platformStaticAssetUrl(
      "views/for-you/assets/cover-01-dae5e2af3215.webp",
    ),
    thumbnail: platformStaticAssetUrl(
      "views/for-you/assets/cover-01-thumb-beb59cdbe6bd.webp",
    ),
    header: {
      wide: {
        tone: "light",
        tint: ["118 200 226", "137 205 225", "115 196 223"],
      },
      compact: {
        tone: "light",
        tint: ["91 185 224", "91 185 224", "91 185 224"],
      },
    },
  },
  {
    id: "cover-02",
    src: platformStaticAssetUrl(
      "views/for-you/assets/cover-02-c4e423a845da.webp",
    ),
    thumbnail: platformStaticAssetUrl(
      "views/for-you/assets/cover-02-thumb-6e0c54da4455.webp",
    ),
    header: {
      wide: {
        tone: "light",
        tint: ["194 192 190", "209 208 205", "226 224 215"],
      },
      compact: {
        tone: "light",
        tint: ["209 237 250", "208 237 250", "209 237 249"],
      },
    },
  },
  {
    id: "cover-03",
    src: platformStaticAssetUrl(
      "views/for-you/assets/cover-03-7833024f9308.webp",
    ),
    thumbnail: platformStaticAssetUrl(
      "views/for-you/assets/cover-03-thumb-72da71763deb.webp",
    ),
    header: {
      wide: {
        tone: "dark",
        tint: ["11 82 81", "14 89 86", "11 90 87"],
      },
      compact: {
        tone: "light",
        tint: ["247 236 205", "253 240 208", "252 240 211"],
      },
    },
  },
  {
    id: "cover-04",
    src: platformStaticAssetUrl(
      "views/for-you/assets/cover-04-8bd71d3d0364.webp",
    ),
    thumbnail: platformStaticAssetUrl(
      "views/for-you/assets/cover-04-thumb-eaf89a5a0480.webp",
    ),
    header: {
      wide: {
        tone: "light",
        tint: ["185 205 225", "132 170 197", "129 176 217"],
      },
      compact: {
        tone: "light",
        tint: ["124 175 223", "123 175 223", "123 175 223"],
      },
    },
  },
  {
    id: "cover-05",
    src: platformStaticAssetUrl(
      "views/for-you/assets/cover-05-c0518205f46a.webp",
    ),
    thumbnail: platformStaticAssetUrl(
      "views/for-you/assets/cover-05-thumb-87f12089b719.webp",
    ),
    header: {
      wide: {
        tone: "dark",
        tint: ["100 97 98", "100 98 101", "115 108 114"],
      },
      compact: {
        tone: "dark",
        tint: ["89 94 125", "89 93 125", "89 93 125"],
      },
    },
  },
  {
    id: "cover-06",
    src: platformStaticAssetUrl(
      "views/for-you/assets/cover-06-51bbed54ce35.webp",
    ),
    thumbnail: platformStaticAssetUrl(
      "views/for-you/assets/cover-06-thumb-95ca9506d7b5.webp",
    ),
    header: {
      wide: {
        tone: "light",
        tint: ["169 213 196", "159 199 153", "138 180 97"],
      },
      compact: {
        tone: "light",
        tint: ["205 235 242", "204 235 242", "205 236 243"],
      },
    },
  },
  {
    id: "cover-07",
    src: platformStaticAssetUrl(
      "views/for-you/assets/cover-07-e4c980c62f38.webp",
    ),
    thumbnail: platformStaticAssetUrl(
      "views/for-you/assets/cover-07-thumb-ad9879df695e.webp",
    ),
    header: {
      wide: {
        tone: "light",
        tint: ["133 170 214", "157 186 218", "129 157 167"],
      },
      compact: {
        tone: "light",
        tint: ["177 213 234", "177 213 235", "175 213 234"],
      },
    },
  },
  {
    id: "cover-08",
    src: platformStaticAssetUrl(
      "views/for-you/assets/cover-08-b848542ef383.webp",
    ),
    thumbnail: platformStaticAssetUrl(
      "views/for-you/assets/cover-08-thumb-e4b71d5847f1.webp",
    ),
    header: {
      wide: {
        tone: "light",
        tint: ["241 197 73", "240 195 73", "240 194 72"],
      },
      compact: {
        tone: "light",
        tint: ["199 213 214", "203 213 206", "201 213 208"],
      },
    },
  },
  {
    id: "cover-09",
    src: platformStaticAssetUrl(
      "views/for-you/assets/cover-09-b4d14a817e11.webp",
    ),
    thumbnail: platformStaticAssetUrl(
      "views/for-you/assets/cover-09-thumb-2c41b44bce1d.webp",
    ),
    header: {
      wide: {
        tone: "dark",
        tint: ["17 40 70", "18 41 70", "17 41 70"],
      },
      compact: {
        tone: "dark",
        tint: ["13 35 63", "13 35 63", "19 41 66"],
      },
    },
  },
  {
    id: "cover-10",
    src: platformStaticAssetUrl(
      "views/for-you/assets/cover-10-eb2c8032f5bc.webp",
    ),
    thumbnail: platformStaticAssetUrl(
      "views/for-you/assets/cover-10-thumb-b31ebc318796.webp",
    ),
    header: {
      wide: {
        tone: "light",
        tint: ["184 223 210", "186 220 206", "213 149 139"],
      },
      compact: {
        tone: "light",
        tint: ["172 219 210", "173 219 210", "176 220 210"],
      },
    },
  },
  {
    id: "cover-11",
    src: platformStaticAssetUrl(
      "views/for-you/assets/cover-11-9a0bb233c32b.webp",
    ),
    thumbnail: platformStaticAssetUrl(
      "views/for-you/assets/cover-11-thumb-32fd94948836.webp",
    ),
    header: {
      wide: {
        tone: "light",
        tint: ["246 208 205", "242 210 209", "229 214 219"],
      },
      compact: {
        tone: "light",
        tint: ["148 203 233", "147 202 233", "149 203 232"],
      },
    },
  },
  {
    id: "cover-12",
    src: platformStaticAssetUrl(
      "views/for-you/assets/cover-12-fa0354c4a6e0.webp",
    ),
    thumbnail: platformStaticAssetUrl(
      "views/for-you/assets/cover-12-thumb-2c69c0ec1771.webp",
    ),
    header: {
      wide: {
        tone: "light",
        tint: ["117 178 201", "134 193 217", "152 187 207"],
      },
      compact: {
        tone: "light",
        tint: ["104 179 213", "105 179 213", "105 178 213"],
      },
    },
  },
  {
    id: "cover-13",
    src: platformStaticAssetUrl(
      "views/for-you/assets/cover-13-6afd53add535.webp",
    ),
    thumbnail: platformStaticAssetUrl(
      "views/for-you/assets/cover-13-thumb-3a78b4a5581b.webp",
    ),
    header: {
      wide: {
        tone: "light",
        tint: ["125 166 142", "201 226 221", "165 195 171"],
      },
      compact: {
        tone: "light",
        tint: ["173 219 229", "173 221 234", "174 221 234"],
      },
    },
  },
  {
    id: "cover-14",
    src: platformStaticAssetUrl(
      "views/for-you/assets/cover-14-38ad560cb8ee.webp",
    ),
    thumbnail: platformStaticAssetUrl(
      "views/for-you/assets/cover-14-thumb-b2e919051b48.webp",
    ),
    header: {
      wide: {
        tone: "dark",
        tint: ["85 103 103", "100 111 117", "86 99 101"],
      },
      compact: {
        tone: "light",
        tint: ["177 197 212", "191 209 225", "189 207 222"],
      },
    },
  },
  {
    id: "cover-15",
    src: platformStaticAssetUrl(
      "views/for-you/assets/cover-15-1fd78847e1e8.webp",
    ),
    thumbnail: platformStaticAssetUrl(
      "views/for-you/assets/cover-15-thumb-6a93a13eb6c8.webp",
    ),
    header: {
      wide: {
        tone: "light",
        tint: ["250 233 189", "247 225 164", "186 173 157"],
      },
      compact: {
        tone: "light",
        tint: ["253 224 150", "253 225 151", "253 225 152"],
      },
    },
  },
  {
    id: "cover-16",
    src: platformStaticAssetUrl(
      "views/for-you/assets/cover-16-db44fe9ad13b.webp",
    ),
    thumbnail: platformStaticAssetUrl(
      "views/for-you/assets/cover-16-thumb-8ff4893544d7.webp",
    ),
    header: {
      wide: {
        tone: "light",
        tint: ["137 186 192", "145 196 203", "147 210 233"],
      },
      compact: {
        tone: "light",
        tint: ["113 190 228", "113 189 228", "113 189 228"],
      },
    },
  },
  {
    id: "cover-17",
    src: platformStaticAssetUrl(
      "views/for-you/assets/cover-17-39b84fc3729c.webp",
    ),
    thumbnail: platformStaticAssetUrl(
      "views/for-you/assets/cover-17-thumb-2527d154ca8f.webp",
    ),
    header: {
      wide: {
        tone: "light",
        tint: ["248 147 122", "184 138 124", "196 137 122"],
      },
      compact: {
        tone: "light",
        tint: ["251 165 109", "249 165 109", "250 166 109"],
      },
    },
  },
  {
    id: "cover-18",
    src: platformStaticAssetUrl(
      "views/for-you/assets/cover-18-a36171f0dc3f.webp",
    ),
    thumbnail: platformStaticAssetUrl(
      "views/for-you/assets/cover-18-thumb-d742db4b4a7f.webp",
    ),
    header: {
      wide: {
        tone: "light",
        tint: ["197 222 238", "194 225 243", "194 220 233"],
      },
      compact: {
        tone: "light",
        tint: ["174 211 241", "173 211 241", "173 211 241"],
      },
    },
  },
] as const;

type ForYouCoverId = (typeof forYouCovers)[number]["id"];

// The first cover is the default.
export const DEFAULT_FOR_YOU_COVER_ID: ForYouCoverId = forYouCovers[0].id;

// Shown once the last card is handled: Okou takes a breather with the user.
export const forYouCompleteIllustration = platformStaticAssetUrl(
  "views/for-you/assets/take-a-breather-1edc7a6640d4.webp",
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
