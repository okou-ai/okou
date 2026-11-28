import CCStateSwiftUI
import ChatDomain
import Photos
import SwiftUI
import UniformTypeIdentifiers

/// What the composer opens once "Add to chat" has closed: a sheet cannot present the camera or
/// a picker while it is still on screen.
enum ComposerAddAction {
  case camera, photos, scan, files, connectors
}

/// "Add to chat", in the manner of Manus and Claude: the camera and the latest photos in one
/// sideways strip (pick several, then Add), then the other ways in as rows, All photos first. The
/// close button stays in the toolbar's trailing corner, as on every sheet.
struct ComposerAddSheet: View {
  let attachments: AttachmentDraftStore
  let connectorSelection: ComposerConnectorStore?
  let clearDraft: (() -> Void)?
  let choose: (ComposerAddAction) -> Void
  /// Whether a connector write still needs confirmation, kept in the session Store.
  @ResolvedValue private var connectorStatus: ComposerConnectorStore.Status?
  @Environment(\.dismiss) private var dismiss
  @State private var library = RecentPhotoLibrary()
  @State private var picked: [String] = []
  @State private var cameraAvailable = false
  @State private var scannerAvailable = false

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: OkouSpace.lg) {
          strip
          VStack(spacing: 0) {
            OkouActionRow("All photos", icon: "images") { choose(.photos) }
              .accessibilityIdentifier("composer-photos")
            if scannerAvailable {
              OkouActionRow("Scan Document", icon: "scan-text") { choose(.scan) }
            }
            OkouActionRow("Choose Files", icon: "folder") { choose(.files) }
            if let connectorSelection {
              Divider().padding(.horizontal, OkouSpace.lg).padding(.vertical, OkouSpace.xs)
              connectorsRow(connectorSelection)
            }
            if let clearDraft {
              Divider().padding(.horizontal, OkouSpace.lg).padding(.vertical, OkouSpace.xs)
              OkouActionRow("Clear draft", icon: "trash-2", role: .destructive) {
                clearDraft()
                dismiss()
              }
            }
          }
        }
        .padding(.top, OkouSpace.xs)
        .padding(.bottom, OkouSpace.xl)
      }
      .background(OkouColor.background)
      .navigationTitle("Add to chat")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar { OkouCloseToolbarItem { dismiss() } }
      .safeAreaInset(edge: .bottom) {
        if !picked.isEmpty {
          Button {
            attachments.importLibraryPhotos(library.assets(for: picked))
            dismiss()
          } label: {
            Text("Add \(picked.count)")
          }
          .buttonStyle(OkouButtonStyle(isPrimary: true))
          .padding(.horizontal, OkouSpace.lg)
          .padding(.bottom, OkouSpace.sm)
          .accessibilityIdentifier("composer-add-photos")
        }
      }
      .task {
        cameraAvailable = ComposerCamera.isAvailable
        scannerAvailable = ComposerDocumentScanner.isAvailable
        await library.load()
      }
    }
    .presentationDetents([.medium, .large])
    .presentationDragIndicator(.visible)
    .okouSheetBackground(OkouColor.background)
  }

  /// Camera first, then the latest photos when the library is open to Okou; every photo is
  /// the first row under the strip, through the system picker.
  private var strip: some View {
    ScrollView(.horizontal) {
      LazyHStack(spacing: OkouSpace.sm) {
        Button {
          choose(.camera)
        } label: {
          OkouActionTile(title: "Camera", icon: "camera")
        }
        .buttonStyle(.plain)
        .disabled(!cameraAvailable)
        .opacity(cameraAvailable ? 1 : 0.4)
        .accessibilityIdentifier("composer-camera")
        ForEach(library.recent, id: \.localIdentifier) { asset in
          RecentPhotoTile(
            asset: asset, library: library, isSelected: picked.contains(asset.localIdentifier)
          ) {
            if let index = picked.firstIndex(of: asset.localIdentifier) {
              picked.remove(at: index)
            } else {
              picked.append(asset.localIdentifier)
            }
          }
        }
      }
      .padding(.horizontal, OkouSpace.lg)
    }
    .scrollIndicators(.hidden)
    .frame(height: OkouControl.mediaTile)
  }

  init(
    attachments: AttachmentDraftStore, connectorSelection: ComposerConnectorStore?,
    clearDraft: (() -> Void)?, choose: @escaping (ComposerAddAction) -> Void
  ) {
    self.attachments = attachments
    self.connectorSelection = connectorSelection
    self.clearDraft = clearDraft
    self.choose = choose
    _connectorStatus = ResolvedValue(ComposerConnectorStore.status(of: connectorSelection))
  }

  private func connectorsRow(_ store: ComposerConnectorStore) -> some View {
    OkouActionRow("Connectors", icon: "plug") {
      // Share the refresh with the destination while Add to chat dismisses.
      Task { await store.refresh() }
      choose(.connectors)
    } trailing: {
      if (connectorStatus ?? store.status).uncertain {
        // The draft cannot be sent until the connector settings are confirmed.
        Text("Confirm settings")
          .font(.okou(.subheadline))
          .foregroundStyle(OkouColor.mutedForeground)
        OkouIcon("circle-alert", size: OkouIconSize.inline)
          .foregroundStyle(OkouStatusColor.warning)
          .accessibilityHidden(true)
      }
    }
    .accessibilityIdentifier("composer-connectors")
  }
}

/// A recent photo in the strip: tapping picks it (or unpicks it) for the Add button.
private struct RecentPhotoTile: View {
  let asset: PHAsset
  let library: RecentPhotoLibrary
  let isSelected: Bool
  let toggle: () -> Void
  @State private var image: UIImage?
  @Environment(\.displayScale) private var displayScale

  var body: some View {
    Button(action: toggle) {
      OkouMediaThumbnail(image: image.map { Image(uiImage: $0) }, isSelected: isSelected)
    }
    .buttonStyle(.plain)
    .accessibilityLabel("Photo")
    .accessibilityValue(
      asset.creationDate.map { Text($0, format: .dateTime.month().day().hour().minute()) }
        ?? Text(verbatim: "")
    )
    .accessibilityAddTraits(isSelected ? .isSelected : [])
    .task(id: asset.localIdentifier) {
      let thumbnail = await library.thumbnail(
        for: asset, side: OkouControl.mediaTile * displayScale)
      guard !Task.isCancelled else { return }
      image = thumbnail
    }
  }
}

/// The newest photos in the library, once the reader lets Okou see it (all or a chosen few).
/// Without that the strip keeps Camera and All photos, which needs no access.
@MainActor @Observable
final class RecentPhotoLibrary {
  private typealias Snapshot = (assets: [PHAsset], images: PhotoLibraryImageManager?)
  private(set) var recent: [PHAsset] = []
  @ObservationIgnored private var images: PhotoLibraryImageManager?

  func load() async {
    let snapshot = await Self.readRecentPhotos()
    guard !Task.isCancelled else { return }
    images = snapshot.images
    recent = snapshot.assets
  }

  /// PhotoKit's synchronous setup and fetch must not hold up the sheet's first frames.
  /// A sending result transfers the immutable assets to this presentation's main-actor owner.
  @concurrent
  private nonisolated static func readRecentPhotos() async -> sending Snapshot {
    guard !Task.isCancelled else { return ([], nil) }
    var status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
    if status == .notDetermined {
      status = await PHPhotoLibrary.requestAuthorization(for: .readWrite)
    }
    guard !Task.isCancelled, status == .authorized || status == .limited else { return ([], nil) }
    let options = PHFetchOptions()
    options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
    options.fetchLimit = 24
    let result = PHAsset.fetchAssets(with: .image, options: options)
    return (
      result.objects(at: IndexSet(integersIn: 0..<result.count)), PhotoLibraryImageManager()
    )
  }

  /// The picked photos, in the order they were picked.
  func assets(for identifiers: [String]) -> [PHAsset] {
    var picked: [PHAsset] = []
    for identifier in identifiers {
      if let asset = recent.first(where: { $0.localIdentifier == identifier }) {
        picked.append(asset)
      }
    }
    return picked
  }

  func thumbnail(for asset: PHAsset, side: CGFloat) async -> UIImage? {
    guard let images else { return nil }
    let options = PHImageRequestOptions()
    options.deliveryMode = .highQualityFormat
    options.resizeMode = .fast
    options.isNetworkAccessAllowed = true
    // A missing thumbnail keeps the existing placeholder; cancellation never updates the tile.
    return try? await images.read { manager, complete in
      manager.requestImage(
        for: asset, targetSize: CGSize(width: side, height: side), contentMode: .aspectFill,
        options: options
      ) { image, _ in
        complete(.success(image))
      }
    }
  }

  /// The importer owns all files; edited photos keep their original encoded bytes and extension.
  static func attachment(for asset: PHAsset) async throws -> ImportedAttachmentFile {
    let options = PHImageRequestOptions()
    options.isNetworkAccessAllowed = true
    options.version = .current
    options.deliveryMode = .highQualityFormat
    let images = PhotoLibraryImageManager(PHImageManager.default())
    let (data, typeIdentifier): (Data, String?) = try await images.read { manager, complete in
      manager.requestImageDataAndOrientation(
        for: asset, options: options
      ) { data, typeIdentifier, _, _ in
        if let data {
          complete(.success((data, typeIdentifier)))
        } else {
          complete(
            .failure(
              ChatError.invalidContract(
                "This photo or video could not be loaded. Select it again.")))
        }
      }
    }
    try Task.checkCancellation()
    var name = PHAssetResource.assetResources(for: asset).first?.originalFilename ?? "Photo"
    if let typeIdentifier, let fileExtension = UTType(typeIdentifier)?.preferredFilenameExtension {
      name = (name as NSString).deletingPathExtension + "." + fileExtension
    }
    return try await AttachmentFileImporter.shared.photo(data, filename: name)
  }
}
