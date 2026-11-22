import SwiftUI

/// A chat in the sidebar: its status column, one body line of title and its trailing state.
/// The status column holds the chat's status emoji or a quiet chat glyph when it has none;
/// a section without any status leaves the column out so its titles sit flush. The trailing
/// column draws the first of the chat's `states`, and VoiceOver reads them all. An unread chat's
/// title is medium weight, as on the web, so a finished chat reads before its dot.
struct OkouChatRowLabel<Status: View>: View {
  let title: String
  var states: OkouChatStates = []
  let status: Status?
  @ScaledMetric(relativeTo: .body) private var statusColumn = OkouControl.statusColumn

  init(_ title: String, states: OkouChatStates = [], @ViewBuilder status: () -> Status) {
    self.title = title
    self.states = states
    self.status = status()
  }

  var body: some View {
    HStack(spacing: OkouSpace.ten) {
      if let status {
        status.frame(width: statusColumn)
      }
      Text(verbatim: title)
        .font(.okou(.body).weight(states.contains(.unread) ? .medium : .regular))
        .lineLimit(1)
      Spacer(minLength: 0)
      if !states.isEmpty {
        OkouChatTrailingMark(trailing: states.trailing)
          .accessibilityElement(children: .ignore)
          .accessibilityLabel(states.accessibilityLabel)
      }
    }
    .frame(minHeight: OkouControl.listRow)
    .contentShape(Rectangle())
  }
}

/// Shared trailing status for a sidebar chat. Every mark is centred in
/// one `standard`-wide column, so spinners, dots, pencils and pins line up down the list.
struct OkouChatTrailingMark: View {
  let trailing: OkouChatTrailing

  var body: some View {
    Group {
      switch trailing {
      case .none:
        EmptyView()
      case .working:
        OkouRunningSpinner()
      case .muted:
        OkouIcon("bell-off", size: OkouIconSize.standard)
          .foregroundStyle(OkouColor.quietMark)
      case .unread:
        // Amber stays for a primary commit.
        Circle()
          .fill(OkouStatusColor.running)
          .frame(width: OkouControl.unreadDot, height: OkouControl.unreadDot)
      case .draft:
        OkouIcon("pencil", size: OkouIconSize.standard)
          .foregroundStyle(OkouColor.quietMark)
      case .pinned:
        OkouIcon("pin", size: OkouIconSize.standard)
          .foregroundStyle(OkouColor.quietMark)
      }
    }
    .frame(width: OkouIconSize.standard)
  }
}

extension OkouChatRowLabel where Status == EmptyView {
  /// A chat in a section where no chat has a status: no status column.
  init(_ title: String, states: OkouChatStates = []) {
    self.title = title
    self.states = states
    self.status = nil
  }
}

/// Every state a sidebar chat is in. The trailing column has room for one, so it draws the
/// first in the web's order: working, muted, unread, draft, then the pin a pinned chat rests
/// with. VoiceOver reads them all, so a draft or a pin under a working chat is still announced.
/// A muted chat is never unread, so those two never meet.
struct OkouChatStates: OptionSet {
  let rawValue: Int

  /// Okou is running in the chat.
  static let working = OkouChatStates(rawValue: 1 << 0)
  /// The chat sends no notifications and shows no unread dot.
  static let muted = OkouChatStates(rawValue: 1 << 1)
  /// A run finished (or failed) since the chat was last read.
  static let unread = OkouChatStates(rawValue: 1 << 2)
  /// Text or files typed here and not sent yet.
  static let draft = OkouChatStates(rawValue: 1 << 3)
  /// The chat leads its list or Project in its manual order.
  static let pinned = OkouChatStates(rawValue: 1 << 4)

  private struct Entry {
    let state: OkouChatStates
    let mark: OkouChatTrailing
    let label: LocalizedStringResource
  }

  private static let order = [
    Entry(state: .working, mark: .working, label: "Working"),
    Entry(state: .muted, mark: .muted, label: "Muted"),
    Entry(state: .unread, mark: .unread, label: "Unread"),
    Entry(state: .draft, mark: .draft, label: "Draft"),
    Entry(state: .pinned, mark: .pinned, label: "Pinned")
  ]

  /// The one mark the trailing column draws.
  var trailing: OkouChatTrailing {
    Self.order.first { contains($0.state) }?.mark ?? .none
  }

  /// Every state, in order, as one phrase ("Working, Muted and Pinned").
  var accessibilityLabel: String {
    ListFormatter.localizedString(
      byJoining: Self.order.filter { contains($0.state) }.map { String(localized: $0.label) })
  }
}

/// The one mark a chat row's trailing column draws.
enum OkouChatTrailing: Equatable {
  case none
  /// `OkouRunningSpinner`: Okou is working.
  case working
  /// A quiet `bell-off`: the chat is muted.
  case muted
  /// The web's 8 px sky-blue dot: a run finished (or failed) since the chat was last read.
  case unread
  /// The web's quiet pencil: text or files typed here and not sent yet.
  case draft
  /// The web's resting pin: the chat leads its list or Project in its manual order.
  case pinned
}

/// A hairline between list sections (the projects and the chats below them), in the border
/// colour.
struct OkouListDivider: View {
  var body: some View {
    Rectangle()
      .fill(OkouColor.border)
      .frame(height: OkouSpace.hairline)
      .accessibilityHidden(true)
  }
}

/// What a chat's status column shows: its status emoji (✅ Done, ⏳ Waiting, …) on the
/// column's leading edge, or a quiet chat glyph when it has none.
struct OkouChatStatusMark: View {
  let emoji: String?

  var body: some View {
    Group {
      if let emoji {
        Text(verbatim: emoji).font(.okou(.body))
      } else {
        // The same size and grey as the trailing marks, so one row draws one line weight.
        OkouIcon("message-circle", size: OkouIconSize.standard)
          .foregroundStyle(OkouColor.quietMark)
          .accessibilityHidden(true)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

/// A row that does something in a plain sheet (Add to chat): the shared row label in body
/// text, 48 pt tall on the page's 16 pt edge, the whole row tappable. A destructive role turns
/// it red; an optional trailing note sits at the row's end ("Confirm settings").
struct OkouActionRow<Trailing: View>: View {
  let title: LocalizedStringKey
  let icon: String
  var role: ButtonRole?
  let action: () -> Void
  let trailing: Trailing

  init(
    _ title: LocalizedStringKey, icon: String, role: ButtonRole? = nil,
    action: @escaping () -> Void, @ViewBuilder trailing: () -> Trailing
  ) {
    self.title = title
    self.icon = icon
    self.role = role
    self.action = action
    self.trailing = trailing()
  }

  var body: some View {
    Button(role: role, action: action) {
      HStack(spacing: OkouSpace.sm) {
        OkouRowLabel(title, okouSymbol: icon)
        Spacer(minLength: 0)
        trailing
      }
      .font(.okou(.body))
      .foregroundStyle(role == .destructive ? OkouColor.destructive : OkouColor.foreground)
      .frame(minHeight: OkouControl.listRow)
      .padding(.horizontal, OkouSpace.lg)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
  }
}

extension OkouActionRow where Trailing == EmptyView {
  init(
    _ title: LocalizedStringKey, icon: String, role: ButtonRole? = nil,
    action: @escaping () -> Void
  ) {
    self.init(title, icon: icon, role: role, action: action) { EmptyView() }
  }
}

/// The account at the top of Settings: its 40 pt mark, the name in body medium and the
/// email under it in footnote supporting text. The workspace card below gives its rows the
/// same slot (`OkouRowLabel(slot: OkouAvatarSize.account)`), so both names share one edge.
struct OkouAccountRowLabel<Mark: View>: View {
  let title: Text
  let detail: Text?
  let mark: Mark

  init(_ title: Text, detail: Text? = nil, @ViewBuilder mark: () -> Mark) {
    self.title = title
    self.detail = detail
    self.mark = mark()
  }

  var body: some View {
    HStack(spacing: OkouSpace.md) {
      mark.frame(width: OkouAvatarSize.account, height: OkouAvatarSize.account)
      VStack(alignment: .leading, spacing: OkouSpace.one) {
        title.font(.okou(.body).weight(.medium))
        if let detail {
          detail
            .font(.okou(.footnote))
            .foregroundStyle(OkouColor.mutedForeground)
            .textSelection(.enabled)
        }
      }
    }
    .accessibilityElement(children: .combine)
  }
}
