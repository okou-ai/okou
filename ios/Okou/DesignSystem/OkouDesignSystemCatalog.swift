#if DEBUG
  import SwiftUI
  import Textual

  /// A local reference surface; it never creates accounts or starts product services.
  struct OkouDesignSystemCatalog: View {
    static let contentSample = """
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
    static let sampleLevels: [Float] = [
      0.2, 0.5, 0.8, 0.6, 0.3, 0.7, 0.9, 0.5, 0.2, 0.1, 0.4, 0.75, 0.55, 0.3, 0.6, 0.85, 0.4, 0.2,
    ]
    @State private var email = ""
    @FocusState private var emailFocused: Bool
    @State private var enabled = true
    @State private var showsSheet = false
    static let sampleWorkspaces = [
      (id: "catalog", name: "Max & Zoe, Inc"), (id: "catalog-2", name: "Okou Labs"),
    ]
    @State private var catalogWorkspace = "catalog"
    @State private var showsSearchPage = false
    @State private var catalogQuery = ""
    @State private var catalogFilter = "All"
    static let sampleChats = [
      "Trip to Kyoto", "Quarterly report", "Launch checklist", "Brand colours", "Weekly sync notes",
    ]

    var body: some View {
      ScrollView {
        VStack(alignment: .leading, spacing: OkouSpace.xxxl) {
          OkouWordmark()
          Text("Mobile Design System").font(.okou(.largeTitle).weight(.semibold))
          Text("Shared brand. Native controls. One source of truth.")
            .foregroundStyle(OkouColor.mutedForeground)
          OkouNativeIconComparison()
          section("Native sheets") {
            Button("Open native scrolling sheet") { showsSheet = true }
              .buttonStyle(.bordered)
          }
          section("Navigation & composer actions") {
            // Every glass control is drawn on the exact 44 pt shape.
            HStack(spacing: OkouSpace.md) {
              ForEach(["menu", "chevrons-right"], id: \.self) { icon in
                Button {
                } label: {
                  OkouToolbarIcon(icon)
                    .modifier(OkouUnreadBadge(isVisible: icon == "menu"))
                    .modifier(OkouGlassControl(shape: .circle))
                }
                .buttonStyle(.plain)
                .accessibilityLabel(icon)
              }
            }
            // The header's model control: name in the text colour, effort in grey.
            HStack(spacing: OkouSpace.six) {
              Text(verbatim: "GPT 6.1 Sol").font(.okou(.callout).weight(.medium))
              Text(verbatim: "High").font(.okou(.callout))
                .foregroundStyle(OkouColor.mutedForeground)
            }
            .padding(.horizontal, OkouSpace.lg)
            .modifier(OkouGlassControl(shape: .capsule))
            // The sidebar's bottom bar: account, search capsule, prominent new chat.
            HStack(spacing: OkouSpace.md) {
              OkouProfileAvatar(imageURL: nil, hasImage: false, size: OkouControl.minimumTarget)
              HStack(spacing: OkouSpace.sm) {
                OkouIcon("search", size: OkouIconSize.standard)
                Text("Search chats")
                Spacer(minLength: 0)
              }
              .foregroundStyle(OkouColor.placeholder)
              .padding(.horizontal, OkouSpace.lg)
              .frame(maxWidth: .infinity)
              .modifier(OkouGlassControl(shape: .capsule))
              Button {
              } label: {
                OkouToolbarIcon("square-pen")
                  .modifier(OkouGlassControl(shape: .circle))
              }
              .buttonStyle(.plain)
              .accessibilityLabel("New chat")
            }
            HStack(spacing: OkouSpace.xs) {
              Button {
              } label: {
                OkouToolbarIcon("plus")
              }
              .buttonStyle(.plain).accessibilityLabel("Add attachments and tools")
              Text("Ask Okou").font(.okou(.body)).foregroundStyle(OkouColor.mutedForeground)
                .frame(maxWidth: .infinity, alignment: .leading)
              Button {
              } label: {
                OkouToolbarIcon("arrow-up").foregroundStyle(OkouColor.primaryForeground)
              }
              .buttonStyle(.glassProminent).buttonBorderShape(.circle).tint(OkouColor.primary)
              .accessibilityLabel("Send message")
            }.padding(OkouSpace.six).glassEffect(.regular, in: RoundedRectangle(cornerRadius: 28))
          }
          section("Chat rows") {
            // Chat rows, as the sidebar draws them: status emoji, the quiet glyph,
            // and the trailing states.
            VStack(spacing: 0) {
              OkouChatRowLabel("!45375 Sidebar entries open in one tap", trailing: .unread) {
                OkouChatStatusMark(emoji: "✅")
              }
              OkouChatRowLabel("!36076 Share in two steps", trailing: .running(phase: 0)) {
                OkouChatStatusMark(emoji: "✅")
              }
              OkouChatRowLabel("Design tokens review", trailing: .pinned) {
                OkouChatStatusMark(emoji: nil)
              }
              OkouChatRowLabel("A chat in a section without statuses")
            }
            .background(OkouColor.sidebar)
          }
          section("Dictation") {
            // A frozen sample of the live strip: dots before audio, then speech.
            HStack(spacing: OkouSpace.xs) {
              OkouToolbarIcon("x").frame(width: OkouControl.minimumTarget)
              OkouLiveWaveform(
                levels: Self.sampleLevels, lastSampleAt: .distantPast,
                interval: OkouMotion.waveformSample, isLive: false
              )
              .frame(height: OkouControl.waveformHeight)
              OkouIcon("square", size: OkouIconSize.inline).frame(width: OkouControl.minimumTarget)
            }
            .padding(OkouSpace.six)
            .glassEffect(.regular, in: Capsule())
          }
          section("Add to chat") {
            // Camera, then picked and unpicked photos, then the sheet's action rows.
            HStack(spacing: OkouSpace.sm) {
              OkouActionTile(title: "Camera", icon: "camera")
              OkouMediaThumbnail(image: nil, isSelected: true)
              OkouMediaThumbnail(image: nil, isSelected: false)
            }
            VStack(spacing: 0) {
              OkouActionRow("All photos", icon: "images") {}
              OkouActionRow("Connectors", icon: "plug") {
              } trailing: {
                Text("Confirm settings")
                  .font(.okou(.subheadline)).foregroundStyle(OkouColor.mutedForeground)
              }
              OkouActionRow("Clear draft", icon: "trash-2", role: .destructive) {}
            }
            .padding(.horizontal, -OkouSpace.lg)
            HStack(spacing: OkouSpace.sm) {
              ForEach(
                Array([OkouSwipeTint.readState, OkouSwipeTint.neutral].enumerated()), id: \.offset
              ) {
                index, tint in
                Label(
                  index == 0 ? "Mark as unread" : "Archive",
                  okouSymbol: index == 0 ? "mail" : "archive"
                )
                .font(.okou(.subheadline).weight(.medium))
                .foregroundStyle(OkouColor.onFilled)
                .padding(.horizontal, OkouSpace.lg)
                .frame(height: OkouControl.minimumTarget)
                .background(tint, in: Capsule())
              }
            }
          }
          section("Catalog cards") {
            OkouSegmentControl(
              selection: .constant(0), options: [(0, "Discover"), (1, "Custom")])
            OkouChipRail(inset: 0) {
              OkouChip(title: Text("All"), isSelected: true) {}
              OkouChip(title: Text("Documents"), isSelected: false) {}
              OkouChip(title: Text("Engineering"), isSelected: false) {}
            }
            ForEach([false, true], id: \.self) { added in
              HStack(spacing: OkouSpace.md) {
                OkouLogoTile(size: OkouControl.logoTile) {
                  OkouIcon("plug", size: OkouIconSize.standard)
                    .foregroundStyle(OkouColor.mutedForeground)
                }
                VStack(alignment: .leading, spacing: OkouSpace.two) {
                  Text("Connector").font(.okou(.body).weight(.medium))
                  Text(added ? "Connected" : "What it lets the agent do, in two lines at most.")
                    .font(.okou(.footnote)).foregroundStyle(OkouColor.mutedForeground)
                }
                Spacer(minLength: 0)
                OkouAddIndicator(isAdded: added)
              }
              .padding(.leading, OkouSpace.lg).padding(.trailing, OkouSpace.six)
              .padding(.vertical, OkouSpace.md)
              .modifier(OkouSurfaceStyle())
            }
            HStack(spacing: OkouSpace.sm) {
              Button("Connect") {}.buttonStyle(OkouButtonStyle(isPrimary: true, isCompact: true))
              Button("Permissions") {}.buttonStyle(
                OkouButtonStyle(isPrimary: false, isCompact: true))
            }
          }
          section("Running & greeting") {
            HStack(spacing: OkouSpace.md) {
              ForEach(0..<4) { row in
                OkouRunningIndicator(phaseOffset: Double(row) / OkouMotion.runningWaveRows)
              }
              Text("Rows trail by 1/12 of a cycle").font(.okou(.footnote))
                .foregroundStyle(OkouColor.mutedForeground)
            }
            NewChatGreeting(
              avatarURL: nil, agentName: "Okou", isDefaultAgent: true,
              text: "What are we working on, Tong?"
            )
            .frame(maxWidth: .infinity)
          }
          section("Settings account") {
            // One mark size and one text edge for the account and its workspace.
            VStack(alignment: .leading, spacing: OkouSpace.md) {
              OkouAccountRowLabel(
                Text(verbatim: "Tong Xing"), detail: Text(verbatim: "tong@example.com")
              ) {
                OkouProfileAvatar(imageURL: nil, hasImage: false, size: OkouAvatarSize.account)
              }
              OkouRowLabel(Text(verbatim: "Max & Zoe, Inc"), slot: OkouAvatarSize.account) {
                OkouWorkspaceLogo(
                  workspaceID: "catalog", name: "Max & Zoe, Inc", size: OkouAvatarSize.account)
              }
            }
          }
          section("Usage & grouped rows") {
            VStack(alignment: .leading, spacing: 0) {
              OkouUsageMeter(
                title: "5-hour limit", remaining: 64, resetsAt: .now.addingTimeInterval(7_800))
              Divider()
              OkouUsageMeter(
                title: "Weekly limit", remaining: 18, resetsAt: .now.addingTimeInterval(300_000))
              Divider()
              OkouUsageMeter(title: "Weekly limit", remaining: 0)
            }
            .padding(OkouSpace.lg)
            .modifier(OkouSurfaceStyle())
            Text("Section header").okouSectionHeader()
            Picker("Thinking effort", selection: .constant("high")) {
              Text("Medium").tag("medium")
              Text("High").tag("high")
            }
            .okouValuePicker()
            .padding(.horizontal, OkouSpace.lg)
            .frame(minHeight: OkouControl.minimumTarget)
            .modifier(OkouSurfaceStyle())
            Text("Footer notes explain the card above in supporting text.").okouSectionNote()
          }
          section("Floating panels & card actions") {
            VStack(alignment: .leading, spacing: 0) {
              Text("Workflows").font(.okou(.footnote).weight(.medium))
                .foregroundStyle(OkouColor.mutedForeground)
                .padding(.horizontal, OkouSpace.lg).padding(.vertical, OkouSpace.sm)
              ForEach(["Daily brief", "Release notes"], id: \.self) { name in
                Label(name, okouSymbol: "workflow").font(.okou(.subheadline).weight(.medium))
                  .padding(.horizontal, OkouSpace.lg)
                  .frame(
                    maxWidth: .infinity, minHeight: OkouControl.minimumTarget, alignment: .leading)
              }
            }
            .padding(.bottom, OkouSpace.sm)
            .modifier(OkouFloatingPanelStyle())
            // A transcript card: web-style heading (glyph on the first line, one detail style).
            VStack(alignment: .leading, spacing: OkouSpace.md) {
              ChatCardHeader(title: "Quarterly update for the board", icon: "mail") {
                Text(verbatim: "To: board@example.com")
                Text(verbatim: "Draft · waiting for you")
              }
              HStack(spacing: OkouSpace.md) {
                Button("Send") {}.buttonStyle(ChatCardButtonStyle(emphasis: .primary))
                Button("Discard", role: .destructive) {}.buttonStyle(ChatCardButtonStyle())
              }
            }
            .padding(.horizontal, OkouSpace.lg)
            .padding(.vertical, OkouSpace.md)
            .modifier(ChatCardSurface())
            OkouLoadingRow("Loading connectors…")
            OkouLoadErrorRow(message: "Connectors could not be loaded.") {}
            OkouBanner(
              Text(verbatim: "Chats are taking longer than usual to update."), icon: "refresh-cw")
            OkouBanner(
              Text(verbatim: "Your draft could not be saved on this device."),
              icon: "circle-alert", tone: .problem, dismiss: {}
            ) {
              Button("Try again") {}
            }
            ChatFeedbackSurface(
              message: "Chat archived", icon: "circle-check", actionTitle: "Undo", action: {},
              dismiss: {})
          }
          section("Workspace identities") {
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 56))]) {
              ForEach(0..<8) { index in
                Image("WorkspaceDefault-\(index)").resizable().scaledToFit()
                  .frame(width: 40, height: 40).clipShape(RoundedRectangle(cornerRadius: 10))
              }
            }
          }
          section("Search bar") {
            // The sidebar's button; the search page's system field takes the same glyphs.
            OkouSearchBar(prompt: "Search chats")
          }
          section("Search page") {
            // `OkouSearchPage`: the system field (no clear button, the app's ✕), filters and
            // results that move with the field, and an empty state centred above the keyboard.
            Button("Open search page") { showsSearchPage = true }
              .buttonStyle(.bordered)
          }
          section("Sign-in providers") {
            // Each provider's own mark ships in the app; the title sits on one centre line.
            VStack(spacing: OkouSpace.md) {
              ForEach(
                [
                  ("apple", "Apple"), ("google", "Google"), ("microsoft", "Microsoft"),
                  ("slack", "Slack"),
                ],
                id: \.0
              ) { provider in
                Button {
                } label: {
                  OkouProviderLabel(Text(verbatim: "Continue with \(provider.1)")) {
                    Image("AuthProvider-\(provider.0)").resizable().scaledToFit()
                      .foregroundStyle(OkouColor.foreground)
                  }
                }
                .buttonStyle(OkouProviderButtonStyle())
              }
            }
          }
          section("Results in the transcript") {
            // Every result style and state; also its own page with `--result-styles`.
            ResultStylesGallery()
          }
          section("Workspace menu") {
            // The sidebar's switcher: the workspace's logo as a glass button, its name beside
            // it with no arrow; the menu lists each workspace's logo beside its name, a check
            // on the current one.
            let name = Self.sampleWorkspaces.first { $0.id == catalogWorkspace }?.name ?? ""
            HStack(spacing: OkouSpace.md) {
              Menu {
                Picker("Workspace", selection: $catalogWorkspace) {
                  ForEach(Self.sampleWorkspaces, id: \.id) { workspace in
                    Label {
                      Text(verbatim: workspace.name)
                    } icon: {
                      OkouWorkspaceMenuLogos.image(
                        workspaceID: workspace.id, hasImage: false, cachedImage: nil)
                    }
                    .tag(workspace.id)
                  }
                }
                .pickerStyle(.inline)
                .labelsHidden()
              } label: {
                OkouWorkspaceGlassLogo(workspaceID: catalogWorkspace, name: name)
              }
              .buttonStyle(.plain)
              Text(verbatim: name).font(.okou(.headline))
            }
          }
          section("Agent identities") {
            HStack(spacing: OkouSpace.md) {
              OkouAgentAvatar(
                avatarURL: nil, name: "Okou", isDefault: true, size: OkouAvatarSize.greeting)
              ForEach(["Research", "Design", "Finance"], id: \.self) { name in
                OkouAgentAvatar(avatarURL: nil, name: name, size: OkouAvatarSize.greeting)
              }
            }
          }
          section("Colors") {
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 120))], spacing: OkouSpace.md) {
              swatch("Primary", OkouColor.primary)
              swatch("Brand text", OkouColor.brandText)
              swatch("Foreground", OkouColor.foreground)
              swatch("Muted", OkouColor.muted)
              swatch("Border", OkouColor.border)
              swatch("Destructive", OkouColor.destructive)
            }
          }
          section("Typography") {
            Text("Geist · Title").font(.okou(.title))
            Text("Headline · 17 pt").font(.okou(.headline))
            Text("Body · 17 pt · Dynamic Type").font(.okou(.body))
            Text("Supporting text · 13 pt").font(.okou(.footnote))
              .foregroundStyle(OkouColor.mutedForeground)
            Text("Geist Mono · code").font(.okou(.body, design: .monospaced))
            Text("Keep going · run-section label")
              .font(.okou(.subheadline, design: .serif).italic())
              .foregroundStyle(OkouColor.mutedForeground.opacity(0.5))
          }
          section("Buttons & states") {
            Button("Continue", okouSymbol: "arrow-up-right") {}
              .buttonStyle(OkouButtonStyle(isPrimary: true))
            Button("Secondary action") {}.buttonStyle(OkouButtonStyle(isPrimary: false))
            Button("Unavailable") {}.buttonStyle(OkouButtonStyle(isPrimary: true)).disabled(true)
            Button {
            } label: {
              HStack {
                ProgressView()
                Text("Working…")
              }
            }
            .buttonStyle(OkouButtonStyle(isPrimary: false)).disabled(true)
            Button("Remove", role: .destructive) {}
              .buttonStyle(OkouButtonStyle(isPrimary: false))
          }
          section("Input") {
            Text("Email address").font(.okou(.subheadline).weight(.medium))
            TextField("you@example.com", text: $email)
              .keyboardType(.emailAddress)
              .textContentType(.emailAddress)
              .textInputAutocapitalization(.never)
              .autocorrectionDisabled()
              .textFieldStyle(OkouTextFieldStyle(isFocused: emailFocused)).focused($emailFocused)
              .accessibilityLabel("Email address")
            Toggle("Example preference", isOn: $enabled).tint(OkouColor.primary400)
          }
          section("Surfaces & empty states") {
            VStack(alignment: .leading, spacing: OkouSpace.sm) {
              Label("Card title", okouSymbol: "file-text").font(.okou(.headline))
              Text("Use semantic colors and native radius tokens.")
                .foregroundStyle(OkouColor.mutedForeground)
            }
            .padding(OkouSpace.lg).frame(maxWidth: .infinity, alignment: .leading)
            .modifier(OkouSurfaceStyle())
            OkouEmptyState("No results", icon: "search", description: Text("Try another search."))
              .frame(height: 260)
            OkouEmptyState(
              "Unable to load chat", icon: "message-circle-warning",
              description: Text("Check your connection and try again. Your draft is still here.")
            ) {
              Button("Try again") {}.buttonStyle(OkouButtonStyle(isPrimary: false, isCompact: true))
            }
            .frame(height: 320)
          }
          section("Content & links") {
            // Parsed the way messages are, so inline code is drawn as the web's chip.
            StructuredText(
              Self.contentSample,
              parser: PreparedMessageParser(
                content: (try? AttributedString(
                  markdown: Self.contentSample, including: \.textual)) ?? AttributedString(),
                drawsInlineCode: true)
            )
            .modifier(OkouMarkdownStyle())
          }
          section("Lucide · native optical sizing") {
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 92))], spacing: OkouSpace.lg) {
              ForEach(OkouIconAssets.names, id: \.self) { name in
                VStack(spacing: OkouSpace.sm) {
                  OkouIcon(name, size: OkouIconSize.large)
                  Text(name).font(.okou(.caption2)).multilineTextAlignment(.center)
                }
                .frame(maxWidth: .infinity, minHeight: 72)
                .accessibilityElement(children: .ignore).accessibilityLabel(name)
              }
            }
          }
        }
        .frame(maxWidth: OkouControl.readableWidth, alignment: .leading)
        .padding(OkouControl.pageInset).frame(maxWidth: .infinity)
      }
      .fullScreenCover(isPresented: $showsSearchPage) {
        NavigationStack {
          OkouSearchPage(
            "Search", text: $catalogQuery, prompt: "Search",
            close: {
              showsSearchPage = false
              catalogQuery = ""
            }
          ) {
            OkouChipRail(inset: OkouSpace.lg) {
              ForEach(["All", "Chats", "Messages"], id: \.self) { name in
                OkouChip(title: Text(name), isSelected: catalogFilter == name) {
                  catalogFilter = name
                }
              }
            }
          } results: {
            ForEach(catalogMatches, id: \.self) { title in
              Label(title, okouSymbol: "message-circle")
            }
          } empty: {
            if catalogMatches.isEmpty {
              OkouEmptyState("No results", icon: "search", description: Text("Try another search."))
            }
          }
        }
      }
      .sheet(isPresented: $showsSheet) {
        NavigationStack {
          List {
            Section("Native scroll transition") {
              ForEach(1..<25) { index in
                Label("Example row \(index)", okouSymbol: "message-circle")
              }
            }
          }
          // Every sheet's grouped ground, so this sheet presents as the product's do.
          .okouGroupedBackground()
          .navigationTitle("Component reference")
          .navigationBarTitleDisplayMode(.inline)
          .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
              OkouCloseButton { showsSheet = false }
            }
          }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .okouSheetBackground()
      }
      .background(OkouColor.background)
      .navigationTitle("Design system")
      .navigationBarTitleDisplayMode(.inline)
      .modifier(OkouAppearance())
    }

    private var catalogMatches: [String] {
      let query = catalogQuery.lowercased()
      return Self.sampleChats.filter { query.isEmpty || $0.lowercased().contains(query) }
    }

    private func section<Content: View>(_ title: String, @ViewBuilder content: () -> Content)
      -> some View
    {
      VStack(alignment: .leading, spacing: OkouSpace.lg) {
        Text(title).font(.okou(.title3).weight(.semibold)).accessibilityAddTraits(.isHeader)
        content()
      }
      .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func swatch(_ name: String, _ color: Color) -> some View {
      VStack(alignment: .leading, spacing: OkouSpace.sm) {
        RoundedRectangle(cornerRadius: OkouRadius.small).fill(color).frame(height: 48)
          .overlay {
            RoundedRectangle(cornerRadius: OkouRadius.small).strokeBorder(
              OkouColor.border, lineWidth: 1)
          }
        Text(name).font(.okou(.caption))
      }
    }
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
