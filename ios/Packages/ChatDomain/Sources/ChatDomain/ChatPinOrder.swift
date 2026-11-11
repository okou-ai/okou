import Foundation

/// fractional-indexing's base-62 keys, which the PWA and the pin API use to rank
/// pinned chats (`generateKeyBetween` and `generateNKeysBetween`). Keys compare by
/// their bytes, never by locale collation.
public enum ChatPinOrder {
  private typealias Key = [UInt8]

  private static let digits = Key(
    "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz".utf8)
  private static let zero = digits[0]
  private static let last = digits[digits.count - 1]
  private static let smallestInteger = [UInt8(ascii: "A")] + Key(repeating: zero, count: 26)

  /// A key strictly between `lower` and `upper`; nil leaves that side open.
  public static func key(between lower: String?, and upper: String?) throws -> String {
    String(decoding: try key(lower.map { Key($0.utf8) }, upper.map { Key($0.utf8) }), as: UTF8.self)
  }

  /// `count` ascending keys strictly between `lower` and `upper`.
  public static func keys(between lower: String?, and upper: String?, count: Int) throws
    -> [String]
  {
    try keys(lower.map { Key($0.utf8) }, upper.map { Key($0.utf8) }, count).map {
      String(decoding: $0, as: UTF8.self)
    }
  }

  private static func key(_ lower: Key?, _ upper: Key?) throws -> Key {
    if let lower { try validate(lower) }
    if let upper { try validate(upper) }
    if let lower, let upper, !lower.lexicographicallyPrecedes(upper) { throw invalid }
    guard let lower else {
      guard let upper else { return [UInt8(ascii: "a"), zero] }
      let integer = try integerPart(upper)
      let fraction = Key(upper.dropFirst(integer.count))
      if integer == smallestInteger { return integer + (try midpoint([], fraction)) }
      // The integer alone sorts first when the upper key has a fraction.
      if integer.count < upper.count { return integer }
      guard let decremented = try decrement(integer) else { throw invalid }
      return decremented
    }
    let lowerInteger = try integerPart(lower)
    let lowerFraction = Key(lower.dropFirst(lowerInteger.count))
    guard let upper else {
      if let incremented = try increment(lowerInteger) { return incremented }
      return lowerInteger + (try midpoint(lowerFraction, nil))
    }
    let upperInteger = try integerPart(upper)
    if lowerInteger == upperInteger {
      return lowerInteger
        + (try midpoint(lowerFraction, Key(upper.dropFirst(upperInteger.count))))
    }
    guard let incremented = try increment(lowerInteger) else { throw invalid }
    if incremented.lexicographicallyPrecedes(upper) { return incremented }
    return lowerInteger + (try midpoint(lowerFraction, nil))
  }

  private static func keys(_ lower: Key?, _ upper: Key?, _ count: Int) throws -> [Key] {
    if count <= 0 { return [] }
    if count == 1 { return [try key(lower, upper)] }
    if upper == nil {
      var current = try key(lower, upper)
      var result = [current]
      for _ in 1..<count {
        current = try key(current, upper)
        result.append(current)
      }
      return result
    }
    if lower == nil {
      var current = try key(lower, upper)
      var result = [current]
      for _ in 1..<count {
        current = try key(lower, current)
        result.append(current)
      }
      return result.reversed()
    }
    let middle = count / 2
    let pivot = try key(lower, upper)
    return try keys(lower, pivot, middle) + [pivot] + keys(pivot, upper, count - middle - 1)
  }

  /// The shortest fraction strictly between two fractions; nil is the open upper end.
  private static func midpoint(_ lower: Key, _ upper: Key?) throws -> Key {
    if let upper, !lower.lexicographicallyPrecedes(upper) { throw invalid }
    if lower.last == zero || upper?.last == zero { throw invalid }
    if let upper, !upper.isEmpty {
      // Drop the common prefix, reading a missing lower digit as zero.
      var shared = 0
      while shared < upper.count, (shared < lower.count ? lower[shared] : zero) == upper[shared] {
        shared += 1
      }
      if shared > 0 {
        return Key(upper.prefix(shared))
          + (try midpoint(Key(lower.dropFirst(shared)), Key(upper.dropFirst(shared))))
      }
    }
    let lowerDigit = try lower.first.map(index) ?? 0
    let upperDigit: Int
    if let upper {
      guard let first = upper.first else { throw invalid }
      upperDigit = try index(first)
    } else {
      upperDigit = digits.count
    }
    if upperDigit - lowerDigit > 1 {
      // JavaScript's Math.round(0.5 * sum) rounds a half up.
      return [digits[(lowerDigit + upperDigit + 1) / 2]]
    }
    if let upper, upper.count > 1 { return [upper[0]] }
    return [digits[lowerDigit]] + (try midpoint(Key(lower.dropFirst()), nil))
  }

  private static func increment(_ integer: Key) throws -> Key? {
    try validateInteger(integer)
    let head = integer[0]
    var body = Key(integer.dropFirst())
    var carry = true
    var position = body.count - 1
    while carry, position >= 0 {
      let digit = try index(body[position]) + 1
      if digit == digits.count {
        body[position] = zero
      } else {
        body[position] = digits[digit]
        carry = false
      }
      position -= 1
    }
    guard carry else { return [head] + body }
    if head == UInt8(ascii: "Z") { return [UInt8(ascii: "a"), zero] }
    if head == UInt8(ascii: "z") { return nil }
    let next = head + 1
    if next > UInt8(ascii: "a") { body.append(zero) } else { body.removeLast() }
    return [next] + body
  }

  private static func decrement(_ integer: Key) throws -> Key? {
    try validateInteger(integer)
    let head = integer[0]
    var body = Key(integer.dropFirst())
    var borrow = true
    var position = body.count - 1
    while borrow, position >= 0 {
      let digit = try index(body[position]) - 1
      if digit == -1 {
        body[position] = last
      } else {
        body[position] = digits[digit]
        borrow = false
      }
      position -= 1
    }
    guard borrow else { return [head] + body }
    if head == UInt8(ascii: "a") { return [UInt8(ascii: "Z"), last] }
    if head == UInt8(ascii: "A") { return nil }
    let next = head - 1
    if next < UInt8(ascii: "Z") { body.append(last) } else { body.removeLast() }
    return [next] + body
  }

  private static func validate(_ key: Key) throws {
    guard key != smallestInteger, key.dropFirst().allSatisfy(digits.contains) else {
      throw invalid
    }
    let integer = try integerPart(key)
    if key.count > integer.count, key.last == zero { throw invalid }
  }

  private static func validateInteger(_ integer: Key) throws {
    guard let head = integer.first, integer.count == (try integerLength(head)) else {
      throw invalid
    }
  }

  private static func integerPart(_ key: Key) throws -> Key {
    guard let head = key.first else { throw invalid }
    let length = try integerLength(head)
    guard length <= key.count else { throw invalid }
    return Key(key.prefix(length))
  }

  private static func integerLength(_ head: UInt8) throws -> Int {
    switch head {
    case UInt8(ascii: "a")...UInt8(ascii: "z"): Int(head - UInt8(ascii: "a")) + 2
    case UInt8(ascii: "A")...UInt8(ascii: "Z"): Int(UInt8(ascii: "Z") - head) + 2
    default: throw invalid
    }
  }

  private static func index(_ digit: UInt8) throws -> Int {
    guard let index = digits.firstIndex(of: digit) else { throw invalid }
    return index
  }

  private static var invalid: ChatError { .invalidContract("Invalid pin order.") }
}
