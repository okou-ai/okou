import SwiftUI

/// A chat in the sidebar: its status column, one body line of title and its trailing state.
/// The status column holds the chat's status emoji or a quiet chat glyph when it has none;
/// a section without any status leaves the column out so its titles sit flush. While the agent
/// works the title shimmers (`OkouShimmerText`), so working never competes with the trailing
/// state; an unread chat's title is medium weight, as on the web, so a finished chat reads
/// before its dot.
struct OkouChatRowLabel<Status: View>: View {
  let title: String
  var isWorking = false
  var trailing: OkouChatTrailing = .none
  let status: Status?
  @ScaledMetric(relativeTo: .body) private var statusColumn = OkouControl.statusColumn

  init(
    _ title: String, isWorking: Bool = false, trailing: OkouChatTrailing = .none,
    @ViewBuilder status: () -> Status
  ) {
    self.title = title
    self.isWorking = isWorking
    self.trailing = trailing
    self.status = status()
  }

  var body: some View {
    HStack(spacing: OkouSpace.ten) {
      if let status {
        status.frame(width: statusColumn)
      }
      Text(verbatim: title)
        .font(.okou(.body).weight(trailing == .unread ? .medium : .regular))
        .lineLimit(1)
        .okouShimmerText(isWorking)
      Spacer(minLength: 0)
      OkouChatTrailingMark(trailing: trailing)
    }
    .frame(minHeight: OkouControl.listRow)
    .contentShape(Rectangle())
  }
}

/// Shared trailing status for a chat or its Project's summary row. Every mark is centred in
/// one `standard`-wide column, so dots, pencils and pins line up down the list.
struct OkouChatTrailingMark: View {
  let trailing: OkouChatTrailing

  var body: some View {
    Group {
      switch trailing {
      case .none:
        EmptyView()
      case .unread:
        // Amber stays for a primary commit.
        Circle()
          .fill(OkouStatusColor.running)
          .frame(width: OkouControl.unreadDot, height: OkouControl.unreadDot)
          .frame(width: OkouIconSize.standard)
          .accessibilityLabel("Unread")
      case .draft:
        OkouIcon("pencil", size: OkouIconSize.standard)
          .foregroundStyle(OkouColor.quietMark)
          .frame(width: OkouIconSize.standard)
          .accessibilityElement()
          .accessibilityLabel("Draft")
      }
    }
  }
}

extension OkouChatRowLabel where Status == EmptyView {
  /// A chat in a section where no chat has a status: no status column.
  init(_ title: String, isWorking: Bool = false, trailing: OkouChatTrailing = .none) {
    self.title = title
    self.isWorking = isWorking
    self.trailing = trailing
    self.status = nil
  }
}

/// A chat row's trailing state, one at a time in the web's order: unread, then draft. Working is
/// not one of them: it shimmers the title, so a working chat keeps its draft in view. Pinned
/// chats are a section of the list (`OkouListHeading`), not a mark on the row.
enum OkouChatTrailing: Equatable {
  case none
  /// The web's 8 px sky-blue dot: a run finished (or failed) since the chat was last read.
  case unread
  /// The web's quiet pencil: text or files typed here and not sent yet.
  case draft
}

/// A list section's name (Pinned): subheadline in supporting text, the size Manus gives its
/// sections, read as a header. A section that folds (`isExpanded` set) ends its row with a
/// chevron that turns from down (open) to right (folded) with the fold. Folded, the heading
/// shows what its chats are doing: the name shimmers while one works, and `summary` (the
/// unread dot) sits before the chevron. The list wraps a folding heading in its toggle.
struct OkouListHeading: View {
  let title: LocalizedStringKey
  var isExpanded: Bool?
  var isWorking = false
  var summary: OkouChatTrailing = .none

  init(
    _ title: LocalizedStringKey, isExpanded: Bool? = nil, isWorking: Bool = false,
    summary: OkouChatTrailing = .none
  ) {
    self.title = title
    self.isExpanded = isExpanded
    self.isWorking = isWorking
    self.summary = summary
  }

  var body: some View {
    let text = Text(title).font(.okou(.subheadline)).lineLimit(1)
    HStack(spacing: OkouSpace.sm) {
      Group {
        if isWorking {
          text.okouShimmerText()
        } else {
          text.foregroundStyle(OkouColor.mutedForeground)
        }
      }
      .accessibilityAddTraits(.isHeader)
      if let isExpanded {
        Spacer(minLength: 0)
        OkouChatTrailingMark(trailing: summary)
        OkouIcon("chevron-down", size: OkouIconSize.standard)
          .foregroundStyle(OkouColor.quietMark)
          .rotationEffect(.degrees(isExpanded ? 0 : -90))
          .accessibilityHidden(true)
      }
    }
  }
}

/// A hairline between list sections (Pinned and the chats below it), in the border colour.
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
