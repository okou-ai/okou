"""Regenerate tiny, real font fixtures: pip install fonttools[woff]==4.60.1."""
from pathlib import Path
import re
from fontTools import subset
from fontTools.ttLib import TTFont

output = Path(__file__).resolve().parent
app = output.parents[1]
sources = [
    app / "src/views/okou-page/__tests__/chat-message-pdf.test.tsx",
    app / "src/views/okou-page/__tests__/markdown-artifact-export.test.tsx",
    app / "scripts/check-build-config.node.ts",
]
text = "".join(source.read_text() for source in sources) + "".join(chr(code) for code in range(32, 127))
text += "".join(chr(int(code, 16)) for code in re.findall(r"\\u([0-9a-fA-F]{4})", text))
fonts = [
    ("@fontpkg/noto-sans-cjk-sc/NotoSansCJKsc-Regular.otf", "Regular"),
    ("@fontpkg/noto-sans-cjk-sc/NotoSansCJKsc-Bold.otf", "Bold"),
    ("@fontpkg/sarasa-gothic-sc/sarasa-gothic-sc-italic.ttf", "Italic"),
    ("@fontpkg/sarasa-gothic-sc/sarasa-gothic-sc-bolditalic.ttf", "BoldItalic"),
    ("@fontsource/noto-emoji/files/noto-emoji-emoji-400-normal.woff", "Emoji"),
    ("@expo-google-fonts/noto-sans/400Regular/NotoSans_400Regular.ttf", "UnicodeRegular"),
    ("@expo-google-fonts/noto-sans/700Bold/NotoSans_700Bold.ttf", "UnicodeBold"),
    ("@expo-google-fonts/noto-sans/400Regular_Italic/NotoSans_400Regular_Italic.ttf", "UnicodeItalic"),
    ("@expo-google-fonts/noto-sans/700Bold_Italic/NotoSans_700Bold_Italic.ttf", "UnicodeBoldItalic"),
]
notices = []
for relative, style in fonts:
    font = TTFont(app / "node_modules" / relative)
    notices.extend(record.toUnicode() for record in font["name"].names if record.nameID in (0, 13, 14))
    options = subset.Options()
    options.layout_features = ["*"]
    options.name_IDs = ["*"]
    options.name_legacy = True
    options.name_languages = ["*"]
    sub = subset.Subsetter(options=options)
    sub.populate(text=text)
    sub.subset(font)
    family = "PDF Regression Fixture"
    full_name = f"{family} {style}"
    postscript = f"PDFRegressionFixture-{style}"
    # The subsets are modified test-only fonts, with distinct family names.
    for record in font["name"].names:
        value = {1: family, 2: style, 3: postscript, 4: full_name, 6: postscript, 16: family, 17: style}.get(record.nameID)
        if value:
            record.string = value.encode(record.getEncoding())
    if "CFF " in font:
        cff = font["CFF "].cff
        cff.fontNames[0] = postscript
        cff.topDictIndex[0].FamilyName = family
        cff.topDictIndex[0].FullName = full_name
    path = output / Path(relative).name
    font.save(path)
    print(path.name, path.stat().st_size)
(output / "NOTICE.txt").write_text("Subsets of the production font packages listed in generate.py.\n\n" + "\n\n".join(dict.fromkeys(notices)) + "\n")
