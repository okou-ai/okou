import SwiftUI

/// Native status semantics have no matching Web semantic token yet.
/// Keep them centralized rather than inventing a second brand palette.
enum OkouStatusColor {
  static let success = Color(uiColor: .systemGreen)
  static let warning = Color(uiColor: .systemOrange)
  /// Tailwind `sky-600` (#0084D1), which Web's `RunningIndicator` uses in both appearances.
  /// It is a palette stop, not an exported role, so it lives here until Web publishes one.
  static let running = Color(.sRGB, red: 0.0, green: 0.518, blue: 0.820)
}

/// System-owned grouped list colours, used where native List/Form rows keep their own fill.
enum OkouGroupedColor {
  /// The neutral background behind grouped rows in sheets. The product grey ramp is warm
  /// and read as pink behind the system's white rows.
  static let background = Color(uiColor: .systemGroupedBackground)
}

/// Media controls must retain contrast over arbitrary imagery in both appearances.
enum OkouMediaColor {
  static let foreground = Color.white
  static let scrim = Color.black
  /// The scrim inside an open pick mark, so its white ring reads on a white photo.
  static let markScrimOpacity = 0.2
}

extension OkouColor {
  /// Placeholder text and the hint glyph beside it (the composer's "Message Okou", the sidebar's
  /// "Search chats"): gray-600, lighter than supporting text, so a hint never reads as content.
  static let placeholder = gray600
}

/// Swipe-action fills. The system always draws a swipe action's icon and label in white, so a
/// fill must carry white text in both appearances, and it says what kind of change it is: a
/// quiet dark neutral for moving a chat (Archive, Unarchive), the unread dot's sky blue for
/// read state. Amber stays for a primary commit and orange for warnings.
enum OkouSwipeTint {
  static let neutral = OkouColor.brandDarkGray
  static let readState = OkouStatusColor.running
}
