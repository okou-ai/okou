"""Regenerate tiny, real font fixtures: pip install fonttools[woff]==4.60.1."""
from pathlib import Path
from fontTools import subset
from fontTools.ttLib import TTFont

output = Path(__file__).resolve().parent
app = output.parents[5]
source = output.parents[1] / "chat-message-pdf.test.tsx"
text = source.read_text() + "".join(chr(code) for code in range(32, 127))
fonts = [
    ("@fontpkg/noto-sans-cjk-sc/NotoSansCJKsc-Regular.otf", "Regular"),
    ("@fontpkg/noto-sans-cjk-sc/NotoSansCJKsc-Bold.otf", "Bold"),
    ("@fontpkg/sarasa-gothic-sc/sarasa-gothic-sc-italic.ttf", "Italic"),
    ("@fontpkg/sarasa-gothic-sc/sarasa-gothic-sc-bolditalic.ttf", "BoldItalic"),
    ("@fontsource/noto-emoji/files/noto-emoji-emoji-400-normal.woff", "Emoji"),
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
