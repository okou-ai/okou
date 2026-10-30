/** Known complete platform faces, not an inventory of arbitrary local glyphs. */
const cjkFaces = [
  "NotoSansCJKsc-Regular",
  "NotoSerifCJKsc-Regular",
  "NotoSansCJKtc-Regular",
  "NotoSerifCJKtc-Regular",
  "NotoSansCJKjp-Regular",
  "NotoSerifCJKjp-Regular",
  "NotoSansCJKkr-Regular",
  "NotoSerifCJKkr-Regular",
  "NotoSansCJKhk-Regular",
  "SourceHanSansSC-Regular",
  "SourceHanSerifSC-Regular",
] as const;

export interface FontScript {
  readonly name: string;
  readonly localFaces: readonly string[];
  readonly families: readonly string[];
  readonly prefix: string;
  readonly ranges: readonly (readonly [number, number])[];
}

/** Only missing scripts enter the prefix; Latin and native scripts stay native. */
export const fontScripts: readonly FontScript[] = [
  {
    name: "Han",
    localFaces: [
      ...cjkFaces,
      "PingFangSC-Regular",
      "PingFangTC-Regular",
      "PingFangHK-Regular",
      "MicrosoftYaHei",
      "MicrosoftYaHeiUI",
      "MicrosoftJhengHeiRegular",
      "SimSun",
      "SongtiSC-Regular",
      "SongtiTC-Regular",
      "STSong",
      "DroidSansFallback",
      "ArialUnicodeMS",
    ],
    families: ["Noto Sans SC", "Noto Sans TC", "Noto Sans JP", "Noto Sans KR"],
    prefix: "var(--font-fallback-han)",
    ranges: [
      [0x2e_80, 0x30_3f],
      [0x34_00, 0x4d_bf],
      [0x4e_00, 0x9f_ff],
      [0xf9_00, 0xfa_ff],
      [0xff_00, 0xff_60],
      [0xff_e0, 0xff_ef],
      [0x2_00_00, 0x3_23_af],
    ],
  },
  {
    name: "Kana",
    localFaces: [
      ...cjkFaces,
      "HiraginoSans-W3",
      "HiraKakuProN-W3",
      "HiraMinProN-W3",
      "YuGothic-Regular",
      "YuMincho-Regular",
      "Meiryo",
      "MS-Gothic",
      "MS-Mincho",
      "ArialUnicodeMS",
    ],
    families: ["Noto Sans JP"],
    prefix: '"Okou Fallback Kana Noto Sans JP"',
    ranges: [
      [0x30_40, 0x30_ff],
      [0x31_f0, 0x31_ff],
      [0xff_61, 0xff_9f],
      [0x1_af_f0, 0x1_af_ff],
      [0x1_b0_00, 0x1_b1_6f],
    ],
  },
  {
    name: "Hangul",
    localFaces: [
      ...cjkFaces,
      "AppleSDGothicNeo-Regular",
      "AppleMyungjo",
      "MalgunGothic",
      "Gulim",
      "Dotum",
      "Batang",
      "NanumGothic",
      "UnDotum",
      "ArialUnicodeMS",
    ],
    families: ["Noto Sans KR"],
    prefix: '"Okou Fallback Hangul Noto Sans KR"',
    ranges: [
      [0x11_00, 0x11_ff],
      [0x31_30, 0x31_8f],
      [0xa9_60, 0xa9_7f],
      [0xac_00, 0xd7_ff],
    ],
  },
  {
    name: "Devanagari",
    localFaces: [
      "NotoSansDevanagari-Regular",
      "NotoSerifDevanagari-Regular",
      "KohinoorDevanagari-Regular",
      "DevanagariSangamMN",
      "DevanagariSangamMN-Regular",
      "DevanagariMT",
      "NirmalaUI",
      "Mangal",
      "Lohit-Devanagari",
      "ArialUnicodeMS",
    ],
    families: ["Noto Sans Devanagari"],
    prefix: '"Okou Fallback Devanagari Noto Sans Devanagari"',
    ranges: [
      [0x09_00, 0x09_7f],
      [0xa8_e0, 0xa8_ff],
      [0x1_1b_00, 0x1_1b_5f],
    ],
  },
];
