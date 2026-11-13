#if DEBUG
  import SwiftUI

  struct OkouCatalogChatPage: View {
    let close: (() -> Void)?

    var body: some View {
      OkouCatalogPage(.chat, close: close) {
        OkouCatalogSection("Header") {
          // The menu circle on the left, the chat's "…" on the right; no title. The model
          // control is a quiet note above the open composer.
          HStack(spacing: OkouSpace.md) {
            OkouToolbarIcon("menu").modifier(OkouGlassControl(shape: .circle))
            Spacer(minLength: 0)
            OkouToolbarIcon("ellipsis").modifier(OkouGlassControl(shape: .circle))
          }
        }
        OkouCatalogSection("Composer") {
          OkouComposerSurface {
            Text("Message Okou").font(.okou(.body)).foregroundStyle(OkouColor.placeholder)
              .frame(maxWidth: .infinity, alignment: .leading)
          } leading: {
            Button {
            } label: {
              OkouToolbarIcon("plus")
                .frame(width: OkouControl.minimumTarget, height: OkouControl.minimumTarget)
            }
            .buttonStyle(.plain).accessibilityLabel("Add attachments and tools")
          } trailing: {
            Button {
            } label: {
              OkouToolbarIcon("arrow-up").foregroundStyle(OkouColor.primaryForeground)
            }
            .buttonStyle(.glassProminent).buttonBorderShape(.circle).tint(OkouColor.primary)
            .accessibilityLabel("Send message")
            .frame(width: OkouControl.minimumTarget, height: OkouControl.minimumTarget)
            .contentShape(Circle())
          }
          VStack(alignment: .trailing, spacing: 0) {
            Button {
            } label: {
              OkouComposerValueLabel(title: "GPT 6.1 Sol", isFast: true)
            }
            .buttonStyle(.plain).accessibilityLabel("Model settings")
            .accessibilityValue("GPT 6.1 Sol · Fast mode")
            OkouComposerSurface(isExpanded: true) {
              Text("Message Okou").font(.okou(.body)).foregroundStyle(OkouColor.placeholder)
                .frame(maxWidth: .infinity, alignment: .leading)
            } leading: {
              Button {
              } label: {
                OkouToolbarIcon("plus")
                  .frame(width: OkouControl.minimumTarget, height: OkouControl.minimumTarget)
              }
              .buttonStyle(.plain).accessibilityLabel("Add attachments and tools")
            } trailing: {
              HStack(spacing: OkouSpace.xs) {
                Button {
                } label: {
                  OkouToolbarIcon("mic")
                    .frame(width: OkouControl.minimumTarget, height: OkouControl.minimumTarget)
                }
                .buttonStyle(.plain).accessibilityLabel("Voice input")
                Button {
                } label: {
                  OkouToolbarIcon("arrow-up").foregroundStyle(OkouColor.primaryForeground)
                }
                .buttonStyle(.glassProminent).buttonBorderShape(.circle).tint(OkouColor.primary)
                .accessibilityLabel("Send message")
                .frame(width: OkouControl.minimumTarget, height: OkouControl.minimumTarget)
                .contentShape(Circle())
              }
            }
          }
        }
        OkouCatalogSection("Composer suggestions") {
          OkouSuggestionPanel(
            title: "Chats",
            availableHeight: OkouControl.suggestionListHeight + OkouControl.minimumTarget,
            dismissLabel: "Dismiss chat suggestions", dismissIdentifier: "catalog-dismiss-chats",
            dismiss: {}
          ) { _ in
            VStack(alignment: .leading, spacing: 0) {
              ForEach(["iOS CCState", "storage 退役", "📅 iOS CI", "Axiom review"], id: \.self) {
                title in
                OkouSuggestionRow(title: title)
                  .padding(.horizontal, OkouSpace.lg)
                  .padding(.vertical, OkouSpace.sm)
              }
            }
            .padding(.bottom, OkouSpace.sm)
          }
          OkouSuggestionPanel(
            title: "Workflows",
            availableHeight: OkouControl.suggestionListHeight + OkouControl.minimumTarget,
            dismissLabel: "Dismiss Workflow suggestions",
            dismissIdentifier: "catalog-dismiss-workflows", dismiss: {}
          ) { _ in
            OkouSuggestionRow(
              title: "Daily error review", detail: "Review production errors",
              command: "/error-review"
            )
            .padding(.horizontal, OkouSpace.lg)
            .padding(.vertical, OkouSpace.sm)
            .padding(.bottom, OkouSpace.sm)
          }
        }
        OkouCatalogSection("Dictation") {
          // A frozen sample of the live strip: dots before audio, then speech.
          HStack(spacing: OkouSpace.xs) {
            OkouToolbarIcon("x").frame(width: OkouControl.minimumTarget)
            OkouLiveWaveform(
              levels: OkouCatalogSamples.levels, lastSampleAt: .distantPast,
              interval: OkouMotion.waveformSample, isLive: false
            )
            .frame(height: OkouControl.waveformHeight)
            OkouIcon("square", size: OkouIconSize.inline).frame(width: OkouControl.minimumTarget)
          }
          .padding(OkouSpace.six)
          .glassEffect(.regular, in: Capsule())
        }
        OkouCatalogSection("Add to chat") {
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
        }
        OkouCatalogSection("New chat greeting") {
          NewChatGreeting(
            avatarURL: nil, agentName: "Okou", isDefaultAgent: true,
            text: "What are we working on, Tong?"
          )
          .frame(maxWidth: .infinity)
        }
      }
    }
  }

  struct OkouCatalogSidebarPage: View {
    let close: (() -> Void)?
    @State private var workspace = "catalog"

    var body: some View {
      OkouCatalogPage(.sidebar, close: close) {
        OkouCatalogSection("Header") {
          // The switcher: the workspace's logo as a glass button with its name beside it and
          // no arrow (the menu lists each workspace's logo beside its name, a check on the
          // current one), then the chat list menu and back to the chat grouped in one glass
          // capsule.
          let name = OkouCatalogSamples.workspaces.first { $0.id == workspace }?.name ?? ""
          HStack(spacing: OkouSpace.md) {
            Menu {
              Picker("Workspace", selection: $workspace) {
                ForEach(OkouCatalogSamples.workspaces, id: \.id) { workspace in
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
              OkouWorkspaceGlassLogo(workspaceID: workspace, name: name)
            }
            .buttonStyle(.plain)
            Text(verbatim: name).font(.okou(.headline))
              .frame(maxWidth: .infinity, alignment: .leading)
            HStack(spacing: 0) {
              Button {
              } label: {
                OkouToolbarIcon("list-filter")
                  .frame(width: OkouControl.minimumTarget, height: OkouControl.minimumTarget)
              }
              .accessibilityLabel("Chat list")
              Button {
              } label: {
                OkouToolbarIcon("arrow-right")
                  .frame(width: OkouControl.minimumTarget, height: OkouControl.minimumTarget)
              }
              .accessibilityLabel("Close sidebar")
            }
            .buttonStyle(.plain)
            .modifier(OkouGlassControl(shape: .capsule))
          }
        }
        OkouCatalogSection("Chats") {
          VStack(spacing: 0) {
            OkouChatRowLabel("!45375 Sidebar entries open in one tap", trailing: .unread) {
              OkouChatStatusMark(emoji: "✅")
            }
            OkouChatRowLabel("Design tokens review", isWorking: true) {
              OkouChatStatusMark(emoji: nil)
            }
          }
          .background(OkouColor.sidebar)
        }
        OkouCatalogSection("Bottom bar") {
          // Account, search capsule, new chat: every bar control is the same clear glass.
          HStack(spacing: OkouSpace.md) {
            OkouProfileAvatar(
              imageURL: nil, hasImage: false, size: OkouControl.minimumTarget, name: "Tong")
            OkouSearchBar(prompt: "Search chats")
            Button {
            } label: {
              OkouToolbarIcon("square-pen")
                .modifier(OkouGlassControl(shape: .circle))
            }
            .buttonStyle(.plain)
            .accessibilityLabel("New chat")
          }
        }
      }
    }
  }

  struct OkouCatalogSignInPage: View {
    let close: (() -> Void)?
    @State private var email = ""
    @FocusState private var emailFocused: Bool

    var body: some View {
      OkouCatalogPage(.signInAndAccount, close: close) {
        OkouCatalogSection("Sign-in") {
          // Each provider's own mark ships in the app; the title sits on one centre line. The
          // email field and one Continue sit under them, on the same screen.
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
            TextField("you@example.com", text: $email)
              .keyboardType(.emailAddress)
              .textContentType(.emailAddress)
              .textInputAutocapitalization(.never)
              .autocorrectionDisabled()
              .textFieldStyle(OkouTextFieldStyle(isFocused: emailFocused)).focused($emailFocused)
              .accessibilityLabel("Email address")
            Button("Continue") {}.buttonStyle(OkouButtonStyle(isPrimary: true))
          }
        }
        OkouCatalogSection("Settings account") {
          VStack(alignment: .leading, spacing: OkouSpace.md) {
            OkouAccountRowLabel(
              Text(verbatim: "Tong Xing"), detail: Text(verbatim: "tong@example.com")
            ) {
              OkouProfileAvatar(
                imageURL: nil, hasImage: false, size: OkouAvatarSize.account, name: "Tong")
            }
            Divider()
            OkouRowLabel(Text(verbatim: "Max & Zoe, Inc"), slot: OkouAvatarSize.account) {
              OkouWorkspaceLogo(
                workspaceID: "catalog", name: "Max & Zoe, Inc", size: OkouAvatarSize.account)
            }
          }
          .padding(OkouSpace.lg)
          .modifier(OkouSurfaceStyle())
        }
      }
    }
  }

  struct OkouCatalogConnectorsPage: View {
    let close: (() -> Void)?
    @State private var segment = 0

    var body: some View {
      OkouCatalogPage(.connectors, close: close) {
        OkouCatalogSection("Directory") {
          OkouSegmentControl(selection: $segment, options: [(0, "Discover"), (1, "Custom")])
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
        }
      }
    }
  }
#endif
