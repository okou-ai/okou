import SwiftUI

/// The new-chat greeting as the web draws it: the agent and a rotating tagline that arrive
/// word by word (opacity, an 8 pt blur and a 14 pt rise over 720 ms, 70 ms apart).
struct NewChatGreeting: View {
  let avatarURL: String?
  let agentName: String
  let isDefaultAgent: Bool
  let text: String
  /// The header has no title, so the agent's own avatar opens its profile.
  var openAgent: (() -> Void)? = nil
  @State private var revealed = false
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    let words = text.split(separator: " ", omittingEmptySubsequences: true).map(String.init)
    // Stacked on one centre line: it stays tidy at every width and greeting length.
    VStack(spacing: OkouSpace.md) {
      avatar
        .modifier(GreetingEntrance(revealed: revealed, delay: 0))
      GreetingWordFlow {
        ForEach(Array(words.enumerated()), id: \.offset) { index, word in
          Text(word)
            .font(.okou(.title2).weight(.semibold))
            .foregroundStyle(OkouColor.foreground)
            .modifier(
              GreetingEntrance(
                revealed: revealed, delay: Double(index + 1) * OkouMotion.greetingWordStep))
        }
      }
      .accessibilityElement(children: .ignore)
      .accessibilityLabel(text)
    }
    .onAppear {
      if reduceMotion {
        revealed = true
      } else {
        withAnimation { revealed = true }
      }
    }
  }
}

extension NewChatGreeting {
  @ViewBuilder fileprivate var avatar: some View {
    let image = OkouAgentAvatar(
      avatarURL: avatarURL, name: agentName, isDefault: isDefaultAgent,
      size: OkouAvatarSize.greeting)
    if let openAgent {
      Button(action: openAgent) { image }
        .buttonStyle(.plain)
        .accessibilityLabel(agentName)
        .accessibilityHint("Shows the agent")
        .accessibilityIdentifier("greeting-agent")
    } else {
      image
    }
  }
}

private struct GreetingEntrance: ViewModifier {
  let revealed: Bool
  let delay: Double
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  func body(content: Content) -> some View {
    content
      .opacity(revealed ? 1 : 0)
      .blur(radius: revealed || reduceMotion ? 0 : OkouMotion.greetingWordBlur)
      .offset(y: revealed || reduceMotion ? 0 : OkouMotion.greetingWordRise)
      .animation(
        reduceMotion ? nil : OkouMotion.greetingWord.delay(delay),
        value: revealed)
  }
}

/// Lays words out in centred lines and wraps whole words, so each word can animate on its
/// own while every line already has its final shape.
private struct GreetingWordFlow: Layout {
  var spacing: CGFloat = 6
  var lineSpacing: CGFloat = 2

  private struct Line {
    var indices: [Int] = []
    var width: CGFloat = 0
    var height: CGFloat = 0
  }

  private func lines(for subviews: Subviews, width: CGFloat) -> [Line] {
    var lines: [Line] = [Line()]
    for (index, subview) in subviews.enumerated() {
      let size = subview.sizeThatFits(.unspecified)
      let needed = lines[lines.count - 1].indices.isEmpty ? size.width : size.width + spacing
      if !lines[lines.count - 1].indices.isEmpty && lines[lines.count - 1].width + needed > width {
        lines.append(Line())
      }
      var line = lines[lines.count - 1]
      line.width += line.indices.isEmpty ? size.width : size.width + spacing
      line.height = max(line.height, size.height)
      line.indices.append(index)
      lines[lines.count - 1] = line
    }
    return lines
  }

  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
    let lines = lines(for: subviews, width: proposal.width ?? .infinity)
    let height = lines.reduce(0) { $0 + $1.height } + lineSpacing * CGFloat(max(0, lines.count - 1))
    return CGSize(width: lines.map(\.width).max() ?? 0, height: height)
  }

  func placeSubviews(
    in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()
  ) {
    var y = bounds.minY
    for line in lines(for: subviews, width: bounds.width) {
      var x = bounds.minX + (bounds.width - line.width) / 2
      for index in line.indices {
        let size = subviews[index].sizeThatFits(.unspecified)
        subviews[index].place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
        x += size.width + spacing
      }
      y += line.height + lineSpacing
    }
  }
}

/// The web's rotating new-chat taglines (chat.agentPage.taglines), in its order.
enum NewChatTagline {
  static func text(index: Int, name: String?) -> String {
    guard let name, !name.isEmpty else {
      let taglines = [
        String(localized: "Welcome back."), String(localized: "What's the move?"),
        String(localized: "Good to see you."), String(localized: "What's on your mind?"),
        String(localized: "Ready to roll?"), String(localized: "Ready to build something?"),
        String(localized: "What are we working on?"),
      ]
      return taglines[abs(index) % taglines.count]
    }
    let taglines = [
      String(localized: "Welcome back, \(name)."),
      String(localized: "What's the move, \(name)?"),
      String(localized: "Good to see you, \(name)."),
      String(localized: "What's on your mind, \(name)?"),
      String(localized: "Another win today, \(name)?"),
      String(localized: "Ready to build, \(name)?"),
      String(localized: "\(name) has entered the chat."),
      String(localized: "Saved your seat, \(name)."),
      String(localized: "Let's make today count, \(name)."),
      String(localized: "Coffee's ready, \(name)."),
      String(localized: "Knew you'd come back, \(name)."),
      String(localized: "What's cooking, \(name)?"),
      String(localized: "New ideas today, \(name)?"),
      String(localized: "Right on time, \(name)."),
      String(localized: "What are we working on, \(name)?"),
      String(localized: "The usual, \(name)?"),
    ]
    return taglines[abs(index) % taglines.count]
  }
}
