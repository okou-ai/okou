import SwiftUI

/// A chat in the sidebar: its status column, one body line of title and its trailing state.
/// The status column holds the chat's status emoji or a quiet chat glyph when it has none;
/// a section without any status leaves the column out so its titles sit flush.
struct OkouChatRowLabel<Status: View>: View {
  let title: String
  var trailing: OkouChatTrailing = .none
  let status: Status?
  @ScaledMetric(relativeTo: .body) private var statusColumn = OkouControl.statusColumn

  init(_ title: String, trailing: OkouChatTrailing = .none, @ViewBuilder status: () -> Status) {
    self.title = title
    self.trailing = trailing
    self.status = status()
  }

  var body: some View {
    HStack(spacing: OkouSpace.ten) {
      if let status {
        status.frame(width: statusColumn)
      }
      Text(verbatim: title)
        .font(.okou(.body))
        .lineLimit(1)
      Spacer(minLength: 0)
      switch trailing {
      case .none:
        EmptyView()
      case .running(let phase):
        OkouRunningIndicator(phaseOffset: phase)
          .frame(width: OkouIconSize.standard)
          .accessibilityElement()
          .accessibilityLabel("Working")
      case .unread:
        // Amber stays for a primary commit.
        Circle()
          .fill(OkouStatusColor.running)
          .frame(width: OkouControl.unreadDot, height: OkouControl.unreadDot)
          .frame(width: OkouIconSize.standard)
          .accessibilityLabel("Unread")
      case .pinned:
        OkouIcon("pin", size: OkouIconSize.inline)
          .foregroundStyle(OkouColor.mutedForeground)
          .accessibilityHidden(true)
      }
    }
    .frame(minHeight: OkouControl.listRow)
    .contentShape(Rectangle())
  }
}

extension OkouChatRowLabel where Status == EmptyView {
  /// A chat in a section where no chat has a status: no status column.
  init(_ title: String, trailing: OkouChatTrailing = .none) {
    self.title = title
    self.trailing = trailing
    self.status = nil
  }
}

/// A chat row's trailing state.
enum OkouChatTrailing: Equatable {
  case none
  /// The running indicator; rows trail each other by `phase` of a cycle.
  case running(phase: Double)
  /// The web's 8 px sky-blue dot.
  case unread
  /// A pin, where a list does not already group pinned chats.
  case pinned
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
        OkouIcon("message-circle", size: OkouIconSize.inline)
          .foregroundStyle(OkouColor.mutedForeground)
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
