#if DEBUG
  import SwiftUI
  import Textual

  struct OkouCatalogActionsPage: View {
    let close: (() -> Void)?

    var body: some View {
      OkouCatalogPage(.actions, close: close) {
        OkouCatalogSection("Buttons") {
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
        OkouCatalogSection("Compact pair") {
          HStack(spacing: OkouSpace.sm) {
            Button("Connect") {}.buttonStyle(OkouButtonStyle(isPrimary: true, isCompact: true))
            Button("Permissions") {}.buttonStyle(
              OkouButtonStyle(isPrimary: false, isCompact: true))
          }
        }
        OkouCatalogSection("Swipe actions") {
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
      }
    }
  }

  struct OkouCatalogSelectionPage: View {
    let close: (() -> Void)?
    @State private var email = ""
    @FocusState private var emailFocused: Bool
    @State private var enabled = true
    @State private var segment = 0

    var body: some View {
      OkouCatalogPage(.selectionAndInput, close: close) {
        OkouCatalogSection("Text field & switch") {
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
        OkouCatalogSection("Value picker") {
          Picker("Thinking effort", selection: .constant("high")) {
            Text("Medium").tag("medium")
            Text("High").tag("high")
          }
          .okouValuePicker()
          .padding(.horizontal, OkouSpace.lg)
          .frame(minHeight: OkouControl.minimumTarget)
          .modifier(OkouSurfaceStyle())
        }
        OkouCatalogSection("Segment control") {
          OkouSegmentControl(selection: $segment, options: [(0, "Discover"), (1, "Custom")])
        }
        OkouCatalogSection("Chips") {
          OkouChipRail(inset: 0) {
            OkouChip(title: Text("All"), isSelected: true) {}
            OkouChip(title: Text("Documents"), isSelected: false) {}
            OkouChip(title: Text("Engineering"), isSelected: false) {}
          }
        }
        OkouCatalogSection("Add") {
          // A card's trailing control: "+" adds at once; once added, a chevron opens the item.
          HStack(spacing: OkouSpace.md) {
            OkouAddIndicator(isAdded: false)
            OkouAddIndicator(isAdded: true)
          }
        }
      }
    }
  }

  struct OkouCatalogListsPage: View {
    let close: (() -> Void)?

    var body: some View {
      OkouCatalogPage(.listsAndRows, close: close) {
        OkouCatalogSection("Grouped rows") {
          Text("Section header").okouSectionHeader()
          VStack(spacing: 0) {
            OkouValueRow(value: Text(verbatim: "On")) {
              OkouRowLabel("Notifications", okouSymbol: "bell")
            }
            .frame(minHeight: OkouControl.groupedRow)
            Divider().padding(.leading, OkouControl.rowLeadingSlot + OkouSpace.md)
            OkouValueRow(value: Text(verbatim: "English")) {
              OkouRowLabel("Language", okouSymbol: "languages")
            }
            .frame(minHeight: OkouControl.groupedRow)
          }
          .padding(.horizontal, OkouSpace.lg)
          .modifier(OkouSurfaceStyle())
          Text("Footer notes explain the card above in supporting text.").okouSectionNote()
        }
        OkouCatalogSection("Chat rows") {
          // As the sidebar draws them: status emoji, the quiet glyph and the trailing states in
          // their order (unread, draft, pinned). A working chat's title shimmers, so it keeps its
          // trailing state.
          VStack(alignment: .leading, spacing: 0) {
            OkouChatRowLabel("Launch checklist", trailing: .pinned) {
              OkouChatStatusMark(emoji: nil)
            }
            OkouChatRowLabel("!36076 Share in two steps", isWorking: true, trailing: .draft) {
              OkouChatStatusMark(emoji: "✅")
            }
            OkouChatRowLabel("!45375 Sidebar entries open in one tap", trailing: .unread) {
              OkouChatStatusMark(emoji: "✅")
            }
            OkouChatRowLabel("Release notes", trailing: .draft) {
              OkouChatStatusMark(emoji: nil)
            }
            OkouChatRowLabel("Design tokens review") {
              OkouChatStatusMark(emoji: nil)
            }
            OkouChatRowLabel("A chat in a section without statuses")
          }
          .background(OkouColor.sidebar)
        }
        OkouCatalogSection("Action rows") {
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
        }
        OkouCatalogSection("Account rows") {
          // One mark size and one text edge for the account and its workspace.
          VStack(alignment: .leading, spacing: OkouSpace.md) {
            OkouAccountRowLabel(
              Text(verbatim: "Tong Xing"), detail: Text(verbatim: "tong@example.com")
            ) {
              OkouProfileAvatar(
                imageURL: nil, hasImage: false, size: OkouAvatarSize.account, name: "Tong")
            }
            OkouRowLabel(Text(verbatim: "Max & Zoe, Inc"), slot: OkouAvatarSize.account) {
              OkouWorkspaceLogo(
                workspaceID: "catalog", name: "Max & Zoe, Inc", size: OkouAvatarSize.account)
            }
          }
        }
      }
    }
  }

  struct OkouCatalogNavigationPage: View {
    let close: (() -> Void)?
    @State private var showsSearchPage = false
    @State private var query = ""
    @State private var filter = "All"

    var body: some View {
      OkouCatalogPage(.navigationAndSearch, close: close) {
        OkouCatalogSection("Search bar") {
          // The sidebar's button; the search page's system field takes the same glyphs.
          OkouSearchBar(prompt: "Search chats")
        }
        OkouCatalogSection("Search sheet") {
          // `OkouSearchPage`: the system field (no clear button, the app's ✕), filters and
          // results that move with the field, and an empty state centred above the keyboard.
          Button("Open search sheet") { showsSearchPage = true }
            .buttonStyle(.bordered)
        }
      }
      .sheet(isPresented: $showsSearchPage) {
        NavigationStack {
          OkouSearchPage(
            "Search", text: $query, prompt: "Search",
            close: {
              showsSearchPage = false
              query = ""
            }
          ) {
            OkouChipRail(inset: OkouSpace.lg) {
              ForEach(["All", "Chats", "Messages"], id: \.self) { name in
                OkouChip(title: Text(name), isSelected: filter == name) {
                  filter = name
                }
              }
            }
          } results: {
            ForEach(matches, id: \.self) { title in
              Label(title, okouSymbol: "message-circle")
            }
          } empty: {
            if matches.isEmpty {
              OkouEmptyState("No results", icon: "search", description: Text("Try another search."))
            }
          }
        }
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
        .okouSheetBackground(OkouColor.background)
      }
    }

    private var matches: [String] {
      let query = query.lowercased()
      return OkouCatalogSamples.chats.filter { query.isEmpty || $0.lowercased().contains(query) }
    }
  }

  struct OkouCatalogStatusPage: View {
    let close: (() -> Void)?

    var body: some View {
      OkouCatalogPage(.statusAndFeedback, close: close) {
        OkouCatalogSection("Running") {
          HStack(spacing: OkouSpace.md) {
            OkouRunningIndicator()
            Text("The transcript's working line").font(.okou(.footnote))
              .foregroundStyle(OkouColor.mutedForeground)
          }
        }
        OkouCatalogSection("Loading & failed reads") {
          OkouLoadingRow("Loading connectors…")
          OkouLoadErrorRow(message: "Connectors could not be loaded.") {}
        }
        OkouCatalogSection("Skeleton") {
          OkouChatSkeleton().frame(height: 280)
        }
        OkouCatalogSection("Banners") {
          OkouBanner(
            Text(verbatim: "Chats are taking longer than usual to update."), icon: "refresh-cw")
          OkouBanner(
            Text(verbatim: "Your draft could not be saved on this device."),
            icon: "circle-alert", tone: .problem, dismiss: {}
          ) {
            Button("Try again") {}
          }
        }
        OkouCatalogSection("Chat feedback") {
          ChatFeedbackSurface(
            message: "Chat archived", icon: "circle-check", actionTitle: "Undo", action: {},
            dismiss: {})
          NavigationLink {
            ChatSyncStatusGallery()
              .toolbar {
                if let close { OkouCloseToolbarItem(action: close) }
              }
          } label: {
            Text(verbatim: "Chat sync feedback")
          }
          NavigationLink {
            ComputerAuthorizationGallery()
              .toolbar {
                if let close { OkouCloseToolbarItem(action: close) }
              }
          } label: {
            Text(verbatim: "Computer access cards")
          }
        }
        OkouCatalogSection("Empty states") {
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
        OkouCatalogSection("Usage") {
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
        }
      }
    }
  }

  struct OkouCatalogContentPage: View {
    let close: (() -> Void)?

    var body: some View {
      OkouCatalogPage(.content, close: close) {
        OkouCatalogSection("Markdown") {
          // Parsed the way messages are, so inline code is drawn as the web's chip.
          StructuredText(
            OkouCatalogSamples.markdown,
            parser: PreparedMessageParser(
              content: (try? AttributedString(
                markdown: OkouCatalogSamples.markdown, including: \.textual))
                ?? AttributedString(),
              drawsInlineCode: true)
          )
          .modifier(OkouMarkdownStyle())
        }
        OkouCatalogSection("Transcript card") {
          // Web-style heading (glyph on the first line, one detail style) and card actions.
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
        }
        OkouCatalogSection("Media tiles") {
          // Camera, then picked and unpicked photos.
          HStack(spacing: OkouSpace.sm) {
            OkouActionTile(title: "Camera", icon: "camera")
            OkouMediaThumbnail(image: nil, isSelected: true)
            OkouMediaThumbnail(image: nil, isSelected: false)
          }
        }
        OkouCatalogSection("Results in the transcript") {
          // Every result style and state; also its own page with `--result-styles`.
          ResultStylesGallery()
        }
      }
    }
  }

  struct OkouCatalogIdentityPage: View {
    let close: (() -> Void)?

    var body: some View {
      OkouCatalogPage(.identity, close: close) {
        OkouCatalogSection("Agents") {
          HStack(spacing: OkouSpace.md) {
            OkouAgentAvatar(
              avatarURL: nil, name: "Okou", isDefault: true, size: OkouAvatarSize.greeting)
            ForEach(["Research", "Design", "Finance"], id: \.self) { name in
              OkouAgentAvatar(avatarURL: nil, name: name, size: OkouAvatarSize.greeting)
            }
          }
        }
        OkouCatalogSection("People") {
          HStack(spacing: OkouSpace.md) {
            OkouProfileAvatar(
              imageURL: nil, hasImage: false, size: OkouControl.minimumTarget, name: "Tong")
            OkouProfileAvatar(
              imageURL: nil, hasImage: false, size: OkouAvatarSize.account, name: "Tong")
          }
        }
        OkouCatalogSection("Workspaces") {
          LazyVGrid(columns: [GridItem(.adaptive(minimum: 56))]) {
            ForEach(0..<8) { index in
              Image("WorkspaceDefault-\(index)").resizable().scaledToFit()
                .frame(width: 40, height: 40).clipShape(RoundedRectangle(cornerRadius: 10))
            }
          }
          HStack(spacing: OkouSpace.md) {
            OkouWorkspaceLogo(
              workspaceID: "catalog", name: "Max & Zoe, Inc", size: OkouAvatarSize.account)
            OkouWorkspaceGlassLogo(workspaceID: "catalog", name: "Max & Zoe, Inc")
          }
        }
        OkouCatalogSection("Partner logos") {
          HStack(spacing: OkouSpace.md) {
            ForEach([OkouControl.logoTile, OkouControl.logoTileLarge], id: \.self) { size in
              OkouLogoTile(size: size) {
                OkouIcon("plug", size: OkouIconSize.standard)
                  .foregroundStyle(OkouColor.mutedForeground)
              }
            }
          }
        }
      }
    }
  }
#endif
