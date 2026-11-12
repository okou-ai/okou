import SwiftUI
import Textual
import UIKit

/// Public renderer adapters keep content styling on the same roles as Web.
struct OkouMarkdownStyle: ViewModifier {
  func body(content: Content) -> some View {
    content
      // Closest to the content, so it wins over the GitHub style's own code block.
      .textual.codeBlockStyle(OkouCodeBlockStyle())
      .textual.inlineStyle(
        InlineStyle()
          // Web `.wmde-markdown :not(pre) > code`: gray-200 chip, foreground text, 85 %.
          .code(
            .font(.okou(.body, design: .monospaced)), .fontScale(0.85),
            .foregroundColor(OkouColor.foreground), .backgroundColor(OkouColor.gray200)
          )
          .strong(.fontWeight(.semibold))
          .link(.foregroundColor(OkouColor.link))
      )
      .textual.headingStyle(OkouMarkdownHeadingStyle())
      .textual.blockQuoteStyle(OkouMarkdownQuoteStyle())
      .textual.tableStyle(OkouMarkdownTableStyle())
      .textual.thematicBreakStyle(OkouMarkdownRuleStyle())
      .textual.structuredTextStyle(.gitHub)
  }
}

private struct OkouMarkdownHeadingStyle: StructuredText.HeadingStyle {
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .font(
        .okou(
          configuration.headingLevel == 1
            ? .title : configuration.headingLevel == 2 ? .title2 : .headline
        ).weight(.semibold)
      )
      .foregroundStyle(
        configuration.headingLevel >= 6 ? OkouColor.mutedForeground : OkouColor.foreground
      )
      .textual.blockSpacing(.init(top: OkouSpace.xxl, bottom: OkouSpace.lg))
  }
}

private struct OkouMarkdownQuoteStyle: StructuredText.BlockQuoteStyle {
  func makeBody(configuration: Configuration) -> some View {
    // Web: 3 px gray-300 rule, 10 px gap, muted-foreground text.
    HStack(spacing: OkouSpace.ten) {
      Rectangle().fill(OkouColor.gray300).frame(width: OkouSpace.three)
      configuration.label.foregroundStyle(OkouColor.mutedForeground)
    }
  }
}

private struct OkouMarkdownRuleStyle: StructuredText.ThematicBreakStyle {
  func makeBody(configuration: Configuration) -> some View {
    Rectangle().fill(OkouColor.border).frame(height: OkouSpace.hairline)
      .textual.blockSpacing(.init(top: OkouSpace.xxl, bottom: OkouSpace.xxl))
  }
}

/// Web `.wmde-markdown table`: gray-400 border with an 8 pt radius, gray-100 header row,
/// every second row at gray-100 / 50 %, and no cell dividers.
private struct OkouMarkdownTableStyle: StructuredText.TableStyle {
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .textual.tableCellSpacing(horizontal: 0, vertical: 0)
      .textual.tableBackground { layout in
        Canvas { context, _ in
          for row in layout.rowIndices {
            if row == layout.rowIndices.first {
              context.fill(Path(layout.rowBounds(row)), with: .color(OkouColor.stateSelected))
            } else if row.isMultiple(of: 2) {
              context.fill(
                Path(layout.rowBounds(row)), with: .color(OkouColor.stateHover))
            }
          }
        }
      }
      .clipShape(RoundedRectangle(cornerRadius: OkouRadius.small, style: .continuous))
      .overlay(
        RoundedRectangle(cornerRadius: OkouRadius.small, style: .continuous)
          .strokeBorder(OkouColor.gray400, lineWidth: OkouSpace.hairline)
      )
      .textual.blockSpacing(.init(top: 0, bottom: OkouSpace.lg))
  }
}

/// Inline code as the web draws it (`.wmde-markdown code`): 85 % Geist Mono on gray-200 with
/// 0.2 em × 0.4 em of padding and a 4 pt corner. Textual's inline style can set only font
/// and colours, so a short span is drawn by this attachment instead; its code stays the
/// description, so a selection copies the text. The size follows `OkouMarkdownStyle`'s code
/// font (body Geist Mono × 0.85) at the reader's Dynamic Type size.
struct OkouInlineCodeChip: Attachment {
  /// Longer spans (paths, commands) stay text so they can wrap across lines.
  static let maximumLength = 40

  let code: String

  var description: String { code }
  var selectionStyle: AttachmentSelectionStyle { .text }

  var body: some View {
    OkouInlineCodeChipView(code: code)
  }

  /// The placeholder reserves only the part above the baseline: SwiftUI adds a lowered
  /// placeholder's offset to the line height, so the chip instead draws past the bottom of its
  /// placeholder into the line's descent, and lines keep their usual spacing.
  func sizeThatFits(_ proposal: ProposedViewSize, in environment: TextEnvironmentValues) -> CGSize {
    let metrics = Metrics(code: code, dynamicTypeSize: environment.dynamicTypeSize)
    var width = metrics.size.width
    if let available = proposal.width, available < width {
      width = available
    }
    return CGSize(width: width, height: metrics.aboveBaseline)
  }

  /// The chip reaches at most the body line's ascent and descent, like the web's inline
  /// padding, which never grows the line box; the code sits on the sentence's baseline.
  struct Metrics {
    let font: UIFont
    let horizontalPadding: CGFloat
    let aboveBaseline: CGFloat
    let belowBaseline: CGFloat
    let size: CGSize

    init(code: String, dynamicTypeSize: DynamicTypeSize) {
      let traits = UITraitCollection(
        preferredContentSizeCategory: UIContentSizeCategory(dynamicTypeSize))
      let bodySize = UIFontMetrics(forTextStyle: .body).scaledValue(for: 17, compatibleWith: traits)
      let body = OkouTypography.font(ofSize: bodySize)
      let pointSize = bodySize * 0.85
      font = OkouTypography.font(ofSize: pointSize, monospaced: true)
      horizontalPadding = (pointSize * 0.4).rounded()
      let padding = pointSize * 0.2
      aboveBaseline = min(font.ascender + padding, body.ascender)
      belowBaseline = min(-font.descender + padding, -body.descender)
      let text = (code as NSString).size(withAttributes: [.font: font])
      size = CGSize(
        width: ceil(text.width) + horizontalPadding * 2, height: aboveBaseline + belowBaseline)
    }
  }
}

private struct OkouInlineCodeChipView: View {
  let code: String
  @Environment(\.dynamicTypeSize) private var dynamicTypeSize

  var body: some View {
    let metrics = OkouInlineCodeChip.Metrics(code: code, dynamicTypeSize: dynamicTypeSize)
    Text(verbatim: code)
      .font(.custom(OkouTypography.mono, fixedSize: metrics.font.pointSize))
      .foregroundStyle(OkouColor.foreground)
      .lineLimit(1)
      .truncationMode(.middle)
      .padding(.horizontal, metrics.horizontalPadding)
      // The text's descent line sits this far above the chip's bottom edge.
      .padding(.bottom, metrics.belowBaseline + metrics.font.descender)
      .frame(width: metrics.size.width, height: metrics.size.height, alignment: .bottom)
      .background(
        OkouColor.gray200,
        in: RoundedRectangle(cornerRadius: OkouRadius.inline, style: .continuous)
      )
      // Laid out at the placeholder's height; the rest hangs below into the descent.
      .frame(width: metrics.size.width, height: metrics.aboveBaseline, alignment: .top)
  }
}

extension AttributedString {
  /// Short inline code spans drawn as `OkouInlineCodeChip`s. A span inside a link stays text so
  /// it keeps the link's colour and tap; a long one stays text so it can wrap.
  func withInlineCodeChips() -> AttributedString {
    var result = self
    var spans: [(Range<AttributedString.Index>, String)] = []
    for run in result.runs {
      guard run.inlinePresentationIntent?.contains(.code) == true, run.link == nil,
        run.textual.attachment == nil
      else { continue }
      let code = String(result[run.range].characters)
      if code.count > OkouInlineCodeChip.maximumLength || code.contains("\n") { continue }
      spans.append((run.range, code))
    }
    // Attributes only: the characters, and so every collected range, stay put.
    for (range, code) in spans {
      result[range].textual.attachment = AnyAttachment(OkouInlineCodeChip(code: code))
    }
    return result
  }
}

/// A fenced code block as the web draws it (`.wmde-markdown pre`): a quiet neutral fill with a
/// hairline edge and an 8 pt corner, 85 % Geist Mono at the web's 1.45 line height, 12 pt of
/// padding. A slim header holds only the language and a copy glyph that turns into a check.
struct OkouCodeBlockStyle: StructuredText.CodeBlockStyle {
  func makeBody(configuration: Configuration) -> some View {
    let shape = RoundedRectangle(cornerRadius: OkouRadius.small, style: .continuous)
    VStack(alignment: .leading, spacing: 0) {
      HStack(spacing: OkouSpace.sm) {
        if let language = configuration.languageHint, !language.isEmpty {
          Text(verbatim: language)
            .font(.okou(.caption).weight(.medium))
            .foregroundStyle(OkouColor.mutedForeground)
        }
        Spacer(minLength: 0)
        OkouCodeCopyButton { configuration.codeBlock.copyToPasteboard() }
      }
      .padding(.leading, OkouSpace.md)
      .frame(height: OkouControl.codeHeaderHeight)
      // Textual's overflow container keeps text selection local to this code block.
      Overflow {
        configuration.label
          .textual.fontScale(0.85)
          .textual.lineSpacing(.fontScaled(0.15))
          .font(.okou(.body, design: .monospaced))
          .foregroundStyle(OkouColor.foreground)
          .fixedSize(horizontal: false, vertical: true)
          .padding(.horizontal, OkouSpace.md)
          .padding(.bottom, OkouSpace.md)
      }
    }
    .background(OkouColor.stateHover, in: shape)
    .overlay { shape.strokeBorder(OkouColor.border, lineWidth: OkouSpace.hairline) }
    .textual.blockSpacing(.init(top: 0, bottom: 16))
  }
}

/// Copies a code block and confirms in place: the glyph becomes a check for a moment.
private struct OkouCodeCopyButton: View {
  let copy: () -> Void
  @State private var copied = false
  @State private var copyCount = 0

  var body: some View {
    Button {
      copy()
      copyCount += 1
      copied = true
      Task {
        try? await Task.sleep(for: OkouMotion.confirmation)
        copied = false
      }
    } label: {
      OkouIcon(copied ? "check" : "copy", size: OkouIconSize.inline)
        .foregroundStyle(OkouColor.gray600)
        .frame(width: OkouControl.minimumTarget, height: OkouControl.codeHeaderHeight)
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .sensoryFeedback(.success, trigger: copyCount)
    .accessibilityLabel(copied ? "Copied" : "Copy code")
  }
}
