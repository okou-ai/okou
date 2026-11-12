import SwiftUI

extension Path {
  /// A path from SVG path data (`d`), so artwork ported from Web keeps Web's own strings: every
  /// command, absolute and relative, including smooth curves and elliptical arcs.
  init(okouSVG data: String) {
    self.init()
    var scanner = SVGPathScanner(data)
    var current = CGPoint.zero
    var start = CGPoint.zero
    var cubicControl: CGPoint?
    var quadControl: CGPoint?
    var command: UInt8 = 0
    while true {
      if let next = scanner.command() {
        command = next
      } else if command == 0 || !scanner.hasNumber() {
        break
      }
      let relative = command >= UInt8(ascii: "a")
      let base = relative ? current : .zero
      func point() -> CGPoint {
        let x = scanner.number()
        return CGPoint(x: base.x + x, y: base.y + scanner.number())
      }
      var nextCubic: CGPoint?
      var nextQuad: CGPoint?
      switch command | 0x20 {
      case UInt8(ascii: "m"):
        current = point()
        start = current
        move(to: current)
        // Pairs after a move are lines.
        command = relative ? UInt8(ascii: "l") : UInt8(ascii: "L")
      case UInt8(ascii: "l"):
        current = point()
        addLine(to: current)
      case UInt8(ascii: "h"):
        current.x = base.x + scanner.number()
        addLine(to: current)
      case UInt8(ascii: "v"):
        current.y = (relative ? current.y : 0) + scanner.number()
        addLine(to: current)
      case UInt8(ascii: "c"):
        let first = point()
        let second = point()
        current = point()
        addCurve(to: current, control1: first, control2: second)
        nextCubic = second
      case UInt8(ascii: "s"):
        let first = cubicControl.map { reflect($0, about: current) } ?? current
        let second = point()
        current = point()
        addCurve(to: current, control1: first, control2: second)
        nextCubic = second
      case UInt8(ascii: "q"):
        let control = point()
        current = point()
        addQuadCurve(to: current, control: control)
        nextQuad = control
      case UInt8(ascii: "t"):
        let control = quadControl.map { reflect($0, about: current) } ?? current
        current = point()
        addQuadCurve(to: current, control: control)
        nextQuad = control
      case UInt8(ascii: "a"):
        let radii = CGSize(width: scanner.number(), height: scanner.number())
        let rotation = scanner.number()
        let largeArc = scanner.flag()
        let sweep = scanner.flag()
        let end = point()
        addSVGArc(
          from: current, to: end, radii: radii, rotation: rotation, largeArc: largeArc,
          sweep: sweep)
        current = end
      case UInt8(ascii: "z"):
        closeSubpath()
        current = start
        command = 0
      default:
        return
      }
      cubicControl = nextCubic
      quadControl = nextQuad
    }
  }

  private func reflect(_ point: CGPoint, about center: CGPoint) -> CGPoint {
    CGPoint(x: 2 * center.x - point.x, y: 2 * center.y - point.y)
  }

  /// SVG's endpoint arc, as cubic curves of at most a quarter turn each (SVG 1.1, F.6.5).
  private mutating func addSVGArc(
    from start: CGPoint, to end: CGPoint, radii: CGSize, rotation: CGFloat, largeArc: Bool,
    sweep: Bool
  ) {
    guard start != end else { return }
    var rx = abs(radii.width)
    var ry = abs(radii.height)
    guard rx > 0, ry > 0 else {
      addLine(to: end)
      return
    }
    let phi = rotation * .pi / 180
    let (cosPhi, sinPhi) = (cos(phi), sin(phi))
    let dx = (start.x - end.x) / 2
    let dy = (start.y - end.y) / 2
    let x1 = cosPhi * dx + sinPhi * dy
    let y1 = -sinPhi * dx + cosPhi * dy
    let lambda = x1 * x1 / (rx * rx) + y1 * y1 / (ry * ry)
    if lambda > 1 {
      rx *= lambda.squareRoot()
      ry *= lambda.squareRoot()
    }
    let numerator = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1
    let denominator = rx * rx * y1 * y1 + ry * ry * x1 * x1
    let coefficient =
      (largeArc == sweep ? -1 : 1) * max(0, numerator / denominator).squareRoot()
    let cx1 = coefficient * rx * y1 / ry
    let cy1 = -coefficient * ry * x1 / rx
    let center = CGPoint(
      x: cosPhi * cx1 - sinPhi * cy1 + (start.x + end.x) / 2,
      y: sinPhi * cx1 + cosPhi * cy1 + (start.y + end.y) / 2)
    func angle(_ ux: CGFloat, _ uy: CGFloat, _ vx: CGFloat, _ vy: CGFloat) -> CGFloat {
      atan2(ux * vy - uy * vx, ux * vx + uy * vy)
    }
    let ux = (x1 - cx1) / rx
    let uy = (y1 - cy1) / ry
    let theta = angle(1, 0, ux, uy)
    var delta = angle(ux, uy, (-x1 - cx1) / rx, (-y1 - cy1) / ry)
    if !sweep, delta > 0 {
      delta -= 2 * .pi
    } else if sweep, delta < 0 {
      delta += 2 * .pi
    }
    let segments = max(1, Int((abs(delta) / (.pi / 2)).rounded(.up)))
    let step = delta / CGFloat(segments)
    let handle = 4 / 3 * tan(step / 4)
    func map(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
      CGPoint(
        x: center.x + rx * cosPhi * x - ry * sinPhi * y,
        y: center.y + rx * sinPhi * x + ry * cosPhi * y)
    }
    for index in 0..<segments {
      let a1 = theta + CGFloat(index) * step
      let a2 = a1 + step
      addCurve(
        to: index == segments - 1 ? end : map(cos(a2), sin(a2)),
        control1: map(cos(a1) - handle * sin(a1), sin(a1) + handle * cos(a1)),
        control2: map(cos(a2) + handle * sin(a2), sin(a2) - handle * cos(a2)))
    }
  }
}

/// Reads SVG path data: command letters, numbers in any of SVG's compact spellings, and the
/// single-digit flags of an arc.
private struct SVGPathScanner {
  private let bytes: [UInt8]
  private var index = 0

  init(_ data: String) {
    bytes = Array(data.utf8)
  }

  mutating func command() -> UInt8? {
    skipSeparators()
    guard index < bytes.count else { return nil }
    let byte = bytes[index]
    let isLetter = (byte | 0x20) >= UInt8(ascii: "a") && (byte | 0x20) <= UInt8(ascii: "z")
    guard isLetter, (byte | 0x20) != UInt8(ascii: "e") else { return nil }
    index += 1
    return byte
  }

  mutating func hasNumber() -> Bool {
    skipSeparators()
    guard index < bytes.count else { return false }
    let byte = bytes[index]
    return isDigit(byte) || byte == UInt8(ascii: "-") || byte == UInt8(ascii: "+")
      || byte == UInt8(ascii: ".")
  }

  mutating func number() -> CGFloat {
    skipSeparators()
    let begin = index
    if index < bytes.count, bytes[index] == UInt8(ascii: "-") || bytes[index] == UInt8(ascii: "+") {
      index += 1
    }
    while index < bytes.count, isDigit(bytes[index]) { index += 1 }
    if index < bytes.count, bytes[index] == UInt8(ascii: ".") {
      index += 1
      while index < bytes.count, isDigit(bytes[index]) { index += 1 }
    }
    if index < bytes.count, bytes[index] | 0x20 == UInt8(ascii: "e") {
      var exponent = index + 1
      if exponent < bytes.count,
        bytes[exponent] == UInt8(ascii: "-") || bytes[exponent] == UInt8(ascii: "+")
      {
        exponent += 1
      }
      if exponent < bytes.count, isDigit(bytes[exponent]) {
        index = exponent
        while index < bytes.count, isDigit(bytes[index]) { index += 1 }
      }
    }
    return CGFloat(Double(String(decoding: bytes[begin..<index], as: UTF8.self)) ?? 0)
  }

  mutating func flag() -> Bool {
    skipSeparators()
    guard index < bytes.count else { return false }
    defer { index += 1 }
    return bytes[index] == UInt8(ascii: "1")
  }

  private mutating func skipSeparators() {
    while index < bytes.count,
      [UInt8(ascii: " "), UInt8(ascii: ","), 0x0A, 0x0D, 0x09].contains(bytes[index])
    {
      index += 1
    }
  }

  private func isDigit(_ byte: UInt8) -> Bool {
    byte >= UInt8(ascii: "0") && byte <= UInt8(ascii: "9")
  }
}
