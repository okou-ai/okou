import { platformStaticAssetUrl } from "./static-assets.ts";

// Okou-original 2.5:1 covers for the For you banner. `header` holds the colors
// the header uses over each cover: `wide` for containers of 56rem and up, where
// the header sits on 34-47% of the artwork's height, and `compact` below that,
// where it sits on the top 26%. Each `tint` is the average color of the left,
// middle and right of that band, pushed 20% away from the header ink and then
// far enough to reach 5:1 against it; `tone` picks white ink (`dark`) or dark
// ink (`light`) by the left part, under the title. `bar` is the progress
// active and track colors, from the middle tint's hue: deep and pale on
// `light` covers, pale and deep on `dark` ones.
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
        bar: ["26 128 158", "228 242 247"],
      },
      compact: {
        tone: "light",
        tint: ["91 185 224", "91 185 224", "91 185 224"],
        bar: ["26 119 158", "226 242 248"],
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
        bar: ["106 99 78", "238 237 236"],
      },
      compact: {
        tone: "light",
        tint: ["209 237 250", "208 237 250", "209 237 249"],
        bar: ["26 117 158", "224 242 250"],
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
        bar: ["185 244 241", "38 145 141"],
      },
      compact: {
        tone: "light",
        tint: ["247 236 205", "253 240 208", "252 240 211"],
        bar: ["158 120 26", "252 243 222"],
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
        bar: ["41 100 142", "231 238 243"],
      },
      compact: {
        tone: "light",
        tint: ["124 175 223", "123 175 223", "123 175 223"],
        bar: ["26 94 158", "227 238 247"],
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
        bar: ["216 207 221", "92 91 93"],
      },
      compact: {
        tone: "dark",
        tint: ["89 94 125", "89 93 125", "89 93 125"],
        bar: ["200 203 229", "79 82 104"],
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
        bar: ["60 134 49", "234 242 232"],
      },
      compact: {
        tone: "light",
        tint: ["205 235 242", "204 235 242", "205 236 243"],
        bar: ["26 134 158", "228 243 247"],
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
        bar: ["31 89 153", "230 237 244"],
      },
      compact: {
        tone: "light",
        tint: ["177 213 234", "177 213 235", "175 213 234"],
        bar: ["26 108 158", "228 239 247"],
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
        bar: ["158 122 26", "251 243 224"],
      },
      compact: {
        tone: "light",
        tint: ["199 213 214", "203 213 206", "201 213 208"],
        bar: ["70 113 83", "235 239 236"],
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
        bar: ["185 211 244", "48 87 135"],
      },
      compact: {
        tone: "dark",
        tint: ["13 35 63", "13 35 63", "19 41 66"],
        bar: ["185 211 244", "43 86 140"],
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
        bar: ["45 138 100", "232 242 238"],
      },
      compact: {
        tone: "light",
        tint: ["172 219 210", "173 219 210", "176 220 210"],
        bar: ["38 146 125", "231 243 241"],
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
        bar: ["158 30 26", "246 229 228"],
      },
      compact: {
        tone: "light",
        tint: ["148 203 233", "147 202 233", "149 203 232"],
        bar: ["26 110 158", "227 240 248"],
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
        bar: ["26 120 158", "229 241 246"],
      },
      compact: {
        tone: "light",
        tint: ["104 179 213", "105 179 213", "105 178 213"],
        bar: ["26 116 158", "228 240 246"],
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
        bar: ["48 136 118", "232 242 240"],
      },
      compact: {
        tone: "light",
        tint: ["173 219 229", "173 221 234", "174 221 234"],
        bar: ["26 130 158", "228 243 247"],
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
        bar: ["204 217 224", "86 93 98"],
      },
      compact: {
        tone: "light",
        tint: ["177 197 212", "191 209 225", "189 207 222"],
        bar: ["41 95 142", "231 237 243"],
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
        bar: ["158 123 26", "251 243 224"],
      },
      compact: {
        tone: "light",
        tint: ["253 224 150", "253 225 151", "253 225 152"],
        bar: ["158 122 26", "253 244 222"],
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
        bar: ["42 130 142", "231 242 243"],
      },
      compact: {
        tone: "light",
        tint: ["113 190 228", "113 189 228", "113 189 228"],
        bar: ["26 113 158", "226 241 248"],
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
        bar: ["135 69 49", "242 235 232"],
      },
      compact: {
        tone: "light",
        tint: ["251 165 109", "249 165 109", "250 166 109"],
        bar: ["158 79 26", "252 234 222"],
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
        bar: ["26 109 158", "226 240 248"],
      },
      compact: {
        tone: "light",
        tint: ["174 211 241", "173 211 241", "173 211 241"],
        bar: ["26 100 158", "226 238 249"],
      },
    },
  },
] as const;

type ForYouCoverId = (typeof forYouCovers)[number]["id"];

// The first cover is the default.
export const DEFAULT_FOR_YOU_COVER_ID: ForYouCoverId = forYouCovers[0].id;

// Shown once the last card is handled: Okou takes a breather with the user.
export const forYouCompleteIllustration = platformStaticAssetUrl(
  "views/for-you/assets/take-a-breather-f38f669c7fbb.svg",
);

export const forYouIllustrations = [
  platformStaticAssetUrl(
    "views/for-you/assets/unlock-opportunities-a8af035a649b.svg",
  ),
  platformStaticAssetUrl("views/for-you/assets/set-the-pace-6ff5ad24d986.svg"),
  platformStaticAssetUrl(
    "views/for-you/assets/nurture-growth-93823ce150f4.svg",
  ),
  platformStaticAssetUrl("views/for-you/assets/build-bridges-ceb3f0055e34.svg"),
  platformStaticAssetUrl("views/for-you/assets/weigh-options-54ba5ca7abeb.svg"),
  platformStaticAssetUrl(
    "views/for-you/assets/safeguard-work-e424352134df.svg",
  ),
  platformStaticAssetUrl(
    "views/for-you/assets/set-priorities-be9fc024b776.svg",
  ),
  platformStaticAssetUrl("views/for-you/assets/create-ideas-c0006849002b.svg"),
  platformStaticAssetUrl("views/for-you/assets/launch-plans-633169f1b1cb.svg"),
  platformStaticAssetUrl(
    "views/for-you/assets/connect-the-dots-2fad645a96ba.svg",
  ),
  platformStaticAssetUrl(
    "views/for-you/assets/move-work-forward-aa94ea42d39e.svg",
  ),
  platformStaticAssetUrl("views/for-you/assets/bring-clarity-77942326e9f0.svg"),
  platformStaticAssetUrl(
    "views/for-you/assets/read-and-review-f4169266852e.svg",
  ),
  platformStaticAssetUrl(
    "views/for-you/assets/sort-the-inbox-386847720a75.svg",
  ),
  platformStaticAssetUrl(
    "views/for-you/assets/deliver-results-d9f9faa63888.svg",
  ),
  platformStaticAssetUrl("views/for-you/assets/find-the-way-c03429e0e8cc.svg"),
  platformStaticAssetUrl(
    "views/for-you/assets/organize-threads-5be22d93a78a.svg",
  ),
  platformStaticAssetUrl(
    "views/for-you/assets/take-a-breather-f38f669c7fbb.svg",
  ),
  platformStaticAssetUrl(
    "views/for-you/assets/share-insights-14f09242a083.svg",
  ),
  platformStaticAssetUrl(
    "views/for-you/assets/investigate-details-3a903d981cd9.svg",
  ),
] as const;
