import CoreText
import Foundation
import Textual

typealias MessageTableLayouts = [AttributedString: StructuredText.PreparedTableLayout]

enum MessageTableLayout {
  struct Viewport: Hashable, Sendable {
    let width: CGFloat
    let fontSize: CGFloat
    let scale: CGFloat
  }

  struct Cache {
    private struct Key: Hashable {
      let viewport: Viewport
      let rows: [[AttributedString]]

      init(_ table: StructuredText.TableSource, viewport: Viewport) {
        self.viewport = viewport
        rows = table.rows.map { row in
          row.map { cell in
            var value = AttributedString(cell)
            // The parser assigns these identities within each document. They do not size the cell.
            value.presentationIntent = nil
            value.markdownSourcePosition = nil
            return value
          }
        }
      }
    }

    private var layouts: [Key: StructuredText.PreparedTableLayout] = [:]
    private var order: [Key] = []

    mutating func prepare(_ document: AttributedString, viewport: Viewport) -> MessageTableLayouts {
      guard viewport.width > 0, viewport.fontSize > 0, viewport.scale > 0 else { return [:] }
      var result: MessageTableLayouts = [:]
      for table in StructuredText.tables(in: document).prefix(2) {
        guard !Task.isCancelled else { return [:] }
        guard MessageTableLayout.supports(table) else { continue }
        let key = Key(table, viewport: viewport)
        if let existing = layouts[key] {
          let cells = zip(existing.cells, table.rows.joined()).map { geometry, content in
            StructuredText.PreparedTableLayout.Cell(
              content: content, row: geometry.row, column: geometry.column, frame: geometry.frame)
          }
          result[table.content] = .init(
            size: existing.size, contentWidth: existing.contentWidth,
            cells: cells, dividers: existing.dividers)
        } else if let layout = MessageTableLayout.prepare(table, viewport: viewport) {
          layouts[key] = layout
          order.append(key)
          if order.count > 32 { layouts.removeValue(forKey: order.removeFirst()) }
          result[table.content] = layout
        }
      }
      return result
    }
  }

  // Match the GitHub cell padding and the overflow table's one-point dividers.
  private static let horizontalPadding: CGFloat = 26
  private static let verticalPadding: CGFloat = 12
  private static let divider: CGFloat = 1
  private static let fontKey = NSAttributedString.Key(kCTFontAttributeName as String)

  static func prepare(_ document: AttributedString, viewport: Viewport) -> MessageTableLayouts {
    var cache = Cache()
    return cache.prepare(document, viewport: viewport)
  }

  private static func supports(_ table: StructuredText.TableSource) -> Bool {
    (3...6).contains(table.columnCount) && (8...35).contains(table.rows.count)
      && table.rows.count * table.columnCount <= 160
      && table.rows.allSatisfy { $0.count == table.columnCount }
      && table.content.characters.prefix(8_193).count <= 8_192
  }

  private static func prepare(
    _ table: StructuredText.TableSource, viewport: Viewport
  ) -> StructuredText.PreparedTableLayout? {
    let columnCount = table.columnCount
    guard let regular = CTFontCreateUIFontForLanguage(.system, viewport.fontSize, nil),
      let bold = CTFontCreateCopyWithSymbolicTraits(regular, 0, nil, .boldTrait, .boldTrait)
    else { return nil }

    var ideal = Array(repeating: CGFloat.zero, count: columnCount)
    var minimum = ideal
    var attributedRows: [[NSAttributedString]] = []
    for (row, cells) in table.rows.enumerated() {
      var attributedCells: [NSAttributedString] = []
      for (column, cell) in cells.enumerated() {
        let text = NSMutableAttributedString(string: "")
        for run in cell.runs {
          let intent = run.inlinePresentationIntent ?? []
          guard run.link == nil, run.imageURL == nil, run.textual.emojiURL == nil,
            run.textual.attachment == nil, intent.subtracting(.stronglyEmphasized).isEmpty
          else { return nil }
          let value = String(cell[run.range].characters)
          guard !value.contains(where: \.isNewline), !value.contains("\t") else { return nil }
          let font = row == 0 || intent.contains(.stronglyEmphasized) ? bold : regular
          text.append(NSAttributedString(string: value, attributes: [fontKey: font]))
        }
        let width = ceil(lineWidth(text)) + horizontalPadding
        ideal[column] = max(ideal[column], width)
        let widestWord =
          text.string.split(whereSeparator: \.isWhitespace).map {
            lineWidth(NSAttributedString(string: String($0), attributes: [fontKey: bold]))
          }.max() ?? 0
        minimum[column] = max(minimum[column], min(width, ceil(widestWord) + horizontalPadding))
        attributedCells.append(text)
      }
      attributedRows.append(attributedCells)
    }

    let gaps = CGFloat(columnCount - 1) * divider
    let viewportWidth = viewport.width * 1.5
    let available = floor(viewportWidth) - gaps
    guard ideal.reduce(0, +) > available else { return nil }
    let compact = ideal.map { $0 < available / CGFloat(columnCount) }
    for column in compact.indices where compact[column] {
      ideal[column] += 2
      minimum[column] = ideal[column]
    }
    let minWidth = minimum.reduce(0, +)
    guard minWidth < available else { return nil }
    let fraction = (available - minWidth) / (ideal.reduce(0, +) - minWidth)
    var widths = zip(ideal, minimum).map { floor($1 + ($0 - $1) * fraction) }

    // Keep compact labels on one line and let wrapped columns use their actual line widths.
    // The overflow viewport retains its original width even when the grid is narrower.
    let lineSpacing = viewport.fontSize * 0.25
    var leading: CGFloat = 0
    for column in widths.indices {
      if !compact[column] {
        let sizes = attributedRows.map {
          measure(
            $0[column], width: widths[column] - horizontalPadding, lineSpacing: lineSpacing,
            scale: viewport.scale, fallbackFont: regular)
        }
        let usedWidth = sizes.map(\.width).max() ?? 0
        widths[column] = min(widths[column], ceil(usedWidth) + horizontalPadding + 2)

        // Leave part of the next compact column visible if no cell needs another line.
        let visibleWidth = floor(viewport.width - leading - horizontalPadding - 2 * divider)
        if column + 1 < columnCount, compact[column + 1],
          visibleWidth >= minimum[column], visibleWidth < widths[column],
          zip(attributedRows, sizes).allSatisfy({
            measure(
              $0[column], width: visibleWidth - horizontalPadding, lineSpacing: lineSpacing,
              scale: viewport.scale, fallbackFont: regular
            ).height <= $1.height
          })
        {
          widths[column] = visibleWidth
        }
      }
      leading += widths[column] + divider
    }

    let gridWidth = widths.reduce(0, +) + gaps
    var cells: [StructuredText.PreparedTableLayout.Cell] = []
    var dividers: [CGRect] = []
    var y: CGFloat = 0
    for (row, attributedCells) in attributedRows.enumerated() {
      let height =
        zip(attributedCells, widths).map {
          measure(
            $0, width: $1 - horizontalPadding, lineSpacing: lineSpacing,
            scale: viewport.scale, fallbackFont: regular
          ).height + verticalPadding
        }.max() ?? 0
      guard height.isFinite else { return nil }
      var x: CGFloat = 0
      for (column, width) in widths.enumerated() {
        cells.append(
          .init(
            content: table.rows[row][column], row: row, column: column,
            frame: CGRect(x: x, y: y, width: width, height: height)))
        x += width + divider
      }
      y += height
      if row < attributedRows.count - 1 {
        dividers.append(CGRect(x: 0, y: y, width: gridWidth, height: divider))
        y += divider
      }
    }
    var x: CGFloat = 0
    for width in widths.dropLast() {
      x += width
      dividers.append(CGRect(x: x, y: 0, width: divider, height: y))
      x += divider
    }
    return .init(
      size: CGSize(width: gridWidth, height: y), contentWidth: viewportWidth,
      cells: cells, dividers: dividers)
  }

  private static func lineWidth(_ text: NSAttributedString) -> CGFloat {
    CGFloat(
      CTLineGetTypographicBounds(
        CTLineCreateWithAttributedString(text as CFAttributedString), nil, nil, nil))
  }

  private static func measure(
    _ text: NSAttributedString, width: CGFloat, lineSpacing: CGFloat, scale: CGFloat,
    fallbackFont: CTFont
  ) -> CGSize {
    let typesetter = CTTypesetterCreateWithAttributedString(text as CFAttributedString)
    var result = CGSize.zero
    var offset = 0
    repeat {
      if offset > 0 { result.height += lineSpacing }
      let length = CTTypesetterSuggestLineBreak(typesetter, offset, width)
      if length == 0 {
        let height =
          CTFontGetAscent(fallbackFont) + CTFontGetDescent(fallbackFont)
          + CTFontGetLeading(fallbackFont)
        guard text.length == 0 else {
          return CGSize(width: CGFloat.infinity, height: CGFloat.infinity)
        }
        result.height = ceil(height * scale) / scale
        break
      }
      let line = CTTypesetterCreateLine(typesetter, CFRange(location: offset, length: length))
      var ascent: CGFloat = 0
      var descent: CGFloat = 0
      var leading: CGFloat = 0
      let measuredWidth = CTLineGetTypographicBounds(line, &ascent, &descent, &leading)
      result.width = max(result.width, CGFloat(measuredWidth))
      result.height += ceil((ascent + descent + leading) * scale) / scale
      offset += length
    } while offset < text.length
    return result
  }
}
