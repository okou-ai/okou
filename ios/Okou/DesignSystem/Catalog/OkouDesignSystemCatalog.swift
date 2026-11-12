#if DEBUG
  import SwiftUI

  /// A local reference surface; it never creates accounts or starts product services.
  ///
  /// It is organised as the design system is, after Apple's Human Interface Guidelines and
  /// Material 3: foundations first, then components grouped by what they do, then patterns,
  /// the product's assemblies of them. Each topic is one page, and the source folders under
  /// `DesignSystem/` follow the same groups.
  struct OkouDesignSystemCatalog: View {
    /// Closes whatever pushed the catalog (Settings), from the index and from every page.
    var close: (() -> Void)? = nil
    /// `--composer-preview` opens the Chat page, where the composer is, on launch.
    @State private var opensComposerPreview = ProcessInfo.processInfo.arguments.contains(
      "--composer-preview")

    var body: some View {
      List {
        Section {
          VStack(alignment: .leading, spacing: OkouSpace.sm) {
            OkouWordmark()
            Text("Mobile Design System").font(.okou(.title).weight(.semibold))
            Text("Shared brand. Native controls. One source of truth.")
              .foregroundStyle(OkouColor.mutedForeground)
          }
          .listRowBackground(Color.clear)
          // On the section headers' text edge, not the cards' edge.
          .listRowInsets(
            EdgeInsets(top: 0, leading: OkouSpace.lg, bottom: OkouSpace.sm, trailing: OkouSpace.lg))
        }
        ForEach(OkouCatalogTopic.Group.allCases, id: \.self) { group in
          Section {
            ForEach(group.topics) { topic in
              NavigationLink {
                topic.page(close: close)
              } label: {
                OkouRowLabel(Text(verbatim: topic.title)) {
                  OkouIcon(topic.icon, size: OkouIconSize.standard)
                }
              }
            }
          } header: {
            Text(verbatim: group.title).okouSectionHeader()
          } footer: {
            Text(verbatim: group.summary).okouSectionNote()
          }
        }
      }
      .okouGroupedBackground()
      .navigationTitle("Design system")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        if let close { OkouCloseToolbarItem(action: close) }
      }
      .navigationDestination(isPresented: $opensComposerPreview) {
        OkouCatalogTopic.chat.page(close: close)
      }
      .modifier(OkouAppearance())
    }
  }

  /// One page of the catalog, in the order the index lists them.
  enum OkouCatalogTopic: CaseIterable, Identifiable {
    case color, typography, iconography, materials
    case actions, selectionAndInput, listsAndRows, navigationAndSearch, statusAndFeedback
    case content, identity
    case chat, sidebar, signInAndAccount, connectors

    enum Group: CaseIterable {
      case foundations, components, patterns

      var title: String {
        switch self {
        case .foundations: "Foundations"
        case .components: "Components"
        case .patterns: "Patterns"
        }
      }

      var summary: String {
        switch self {
        case .foundations: "Tokens every component is built from. Code: DesignSystem/Foundations."
        case .components:
          "Reusable views, grouped by what they do. Code: DesignSystem/Components/<group>."
        case .patterns: "How the product assembles components on its screens."
        }
      }

      var topics: [OkouCatalogTopic] {
        OkouCatalogTopic.allCases.filter { $0.group == self }
      }
    }

    var id: Self { self }

    var group: Group {
      switch self {
      case .color, .typography, .iconography, .materials: .foundations
      case .actions, .selectionAndInput, .listsAndRows, .navigationAndSearch, .statusAndFeedback,
        .content, .identity:
        .components
      case .chat, .sidebar, .signInAndAccount, .connectors: .patterns
      }
    }

    var title: String {
      switch self {
      case .color: "Color"
      case .typography: "Typography"
      case .iconography: "Iconography"
      case .materials: "Materials & surfaces"
      case .actions: "Actions"
      case .selectionAndInput: "Selection & input"
      case .listsAndRows: "Lists & rows"
      case .navigationAndSearch: "Navigation & search"
      case .statusAndFeedback: "Status & feedback"
      case .content: "Content"
      case .identity: "Identity"
      case .chat: "Chat"
      case .sidebar: "Sidebar"
      case .signInAndAccount: "Sign-in & account"
      case .connectors: "Connectors"
      }
    }

    var icon: String {
      switch self {
      case .color: "sun-moon"
      case .typography: "quote"
      case .iconography: "layout-grid"
      case .materials: "layers"
      case .actions: "zap"
      case .selectionAndInput: "sliders-horizontal"
      case .listsAndRows: "table"
      case .navigationAndSearch: "search"
      case .statusAndFeedback: "circle-alert"
      case .content: "file-text"
      case .identity: "users"
      case .chat: "message-circle"
      case .sidebar: "menu"
      case .signInAndAccount: "circle-user-round"
      case .connectors: "plug"
      }
    }

    var summary: String {
      switch self {
      case .color: "Semantic roles shared with the web, each with a light and a dark value."
      case .typography: "Geist and Geist Mono on the native type scale, with Dynamic Type."
      case .iconography: "Lucide at native optical size, calibrated against SF Symbols."
      case .materials: "Cards, floating panels, glass and the sheet ground."
      case .actions: "Buttons and their states, compact pairs and swipe actions."
      case .selectionAndInput: "Text fields, switches, value pickers, chips, segments and add."
      case .listsAndRows: "Grouped rows with section text, and the app's own row layouts."
      case .navigationAndSearch: "The search button and the search sheet built on it."
      case .statusAndFeedback:
        "Running, loading, failed reads, banners, chat feedback, empty states and usage."
      case .content: "Markdown, transcript cards, media tiles and results in a chat."
      case .identity: "Okou and its moods, people, workspaces and partner logos."
      case .chat: "The chat header, composer, suggestions, dictation, Add to chat and the greeting."
      case .sidebar: "Workspace switcher, chats, and the bottom bar."
      case .signInAndAccount: "The one sign-in screen and the Settings account card."
      case .connectors: "The connector directory: segments, category chips and cards."
      }
    }

    @MainActor @ViewBuilder
    func page(close: (() -> Void)?) -> some View {
      switch self {
      case .color: OkouCatalogColorPage(close: close)
      case .typography: OkouCatalogTypographyPage(close: close)
      case .iconography: OkouCatalogIconographyPage(close: close)
      case .materials: OkouCatalogMaterialsPage(close: close)
      case .actions: OkouCatalogActionsPage(close: close)
      case .selectionAndInput: OkouCatalogSelectionPage(close: close)
      case .listsAndRows: OkouCatalogListsPage(close: close)
      case .navigationAndSearch: OkouCatalogNavigationPage(close: close)
      case .statusAndFeedback: OkouCatalogStatusPage(close: close)
      case .content: OkouCatalogContentPage(close: close)
      case .identity: OkouCatalogIdentityPage(close: close)
      case .chat: OkouCatalogChatPage(close: close)
      case .sidebar: OkouCatalogSidebarPage(close: close)
      case .signInAndAccount: OkouCatalogSignInPage(close: close)
      case .connectors: OkouCatalogConnectorsPage(close: close)
      }
    }
  }

  /// A catalog page: what the topic covers, then its sections, on the page canvas, with the
  /// catalog's ✕ when Settings pushed it.
  struct OkouCatalogPage<Content: View>: View {
    let topic: OkouCatalogTopic
    let close: (() -> Void)?
    let content: Content

    init(
      _ topic: OkouCatalogTopic, close: (() -> Void)?, @ViewBuilder content: () -> Content
    ) {
      self.topic = topic
      self.close = close
      self.content = content()
    }

    var body: some View {
      ScrollView {
        VStack(alignment: .leading, spacing: OkouSpace.xxxl) {
          Text(verbatim: topic.summary).foregroundStyle(OkouColor.mutedForeground)
          content
        }
        .frame(maxWidth: OkouControl.readableWidth, alignment: .leading)
        .padding(OkouControl.pageInset).frame(maxWidth: .infinity)
      }
      .background(OkouColor.background)
      .navigationTitle(Text(verbatim: topic.title))
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        if let close { OkouCloseToolbarItem(action: close) }
      }
      .modifier(OkouAppearance())
    }
  }

  /// A titled block of specimens on a catalog page.
  struct OkouCatalogSection<Content: View>: View {
    let title: String
    let content: Content

    init(_ title: String, @ViewBuilder content: () -> Content) {
      self.title = title
      self.content = content()
    }

    var body: some View {
      VStack(alignment: .leading, spacing: OkouSpace.lg) {
        Text(title).font(.okou(.title3).weight(.semibold)).accessibilityAddTraits(.isHeader)
        content
      }
      .frame(maxWidth: .infinity, alignment: .leading)
    }
  }

  /// Sample content the catalog's pages share.
  enum OkouCatalogSamples {
    static let markdown = """
      ### Content heading
      Body text with **emphasis**, `inline code`, and a [content link](https://example.invalid).

      > Quoted content uses supporting text and a neutral rule.

      | Item | Status |
      | --- | --- |
      | Design tokens | Shared |
      | Native geometry | Mobile |

      ```bash
      ✗ Hosted-site asset must carry a content hash in its file name
      npm run build && npm run deploy
      ```
      """
    static let levels: [Float] = [
      0.2, 0.5, 0.8, 0.6, 0.3, 0.7, 0.9, 0.5, 0.2, 0.1, 0.4, 0.75, 0.55, 0.3, 0.6, 0.85, 0.4, 0.2,
    ]
    static let workspaces = [
      (id: "catalog", name: "Max & Zoe, Inc"), (id: "catalog-2", name: "Okou Labs"),
    ]
    static let chats = [
      "Trip to Kyoto", "Quarterly report", "Launch checklist", "Brand colours", "Weekly sync notes",
    ]
  }

  #Preview("Mobile / Light") {
    NavigationStack { OkouDesignSystemCatalog() }.preferredColorScheme(.light)
  }

  #Preview("Mobile / Dark") {
    NavigationStack { OkouDesignSystemCatalog() }.preferredColorScheme(.dark)
  }

  #Preview("Mobile / Large text") {
    NavigationStack { OkouDesignSystemCatalog() }.dynamicTypeSize(.accessibility3)
  }
#endif
