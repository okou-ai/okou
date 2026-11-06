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
  @Environment(\.dismiss) private var dismiss
  @State private var library = RecentPhotoLibrary()
  @State private var picked: [String] = []

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: OkouSpace.lg) {
          strip
          VStack(spacing: 0) {
            OkouActionRow("All photos", icon: "images") { choose(.photos) }
              .accessibilityIdentifier("composer-photos")
            if ComposerDocumentScanner.isAvailable {
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
      .task { await library.load() }
    }
    .presentationDetents([.medium, .large])
    .presentationDragIndicator(.visible)
    .okouSheetBackground(OkouColor.background)
  }

  /// Camera first, then the latest photos when the library is open to Okou; every photo is
  /// the first row under the strip, through the system picker.
  private var strip: some View {
    OkouChipRail {
      Button {
        choose(.camera)
      } label: {
        OkouActionTile(title: "Camera", icon: "camera")
      }
      .buttonStyle(.plain)
      .disabled(!ComposerCamera.isAvailable)
      .opacity(ComposerCamera.isAvailable ? 1 : 0.4)
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
    .frame(height: OkouControl.mediaTile)
  }

  private func connectorsRow(_ store: ComposerConnectorStore) -> some View {
    OkouActionRow("Connectors", icon: "plug") {
      choose(.connectors)
    } trailing: {
      if store.uncertain {
        // The draft cannot be sent until the connector settings are confirmed.
        Text("Confirm settings")
          .font(.okou(.subheadline))
          .foregroundStyle(OkouColor.mutedForeground)
        OkouIcon("circle-alert", size: OkouIconSize.inline)
          .foregroundStyle(OkouStatusColor.warning)
          .accessibilityHidden(true)
      }
    }
    .disabled(store.agentID == nil)
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
      image = await library.thumbnail(for: asset, side: OkouControl.mediaTile * displayScale)
    }
  }
}

/// The newest photos in the library, once the reader lets Okou see it (all or a chosen few).
/// Without that the strip keeps Camera and All photos, which needs no access.
@MainActor @Observable
final class RecentPhotoLibrary {
  private(set) var recent: [PHAsset] = []
  @ObservationIgnored private let images = PHCachingImageManager()

  func load() async {
    var status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
    if status == .notDetermined {
      status = await PHPhotoLibrary.requestAuthorization(for: .readWrite)
    }
    guard status == .authorized || status == .limited else { return }
    let options = PHFetchOptions()
    options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
    options.fetchLimit = 24
    let result = PHAsset.fetchAssets(with: .image, options: options)
    recent = result.objects(at: IndexSet(integersIn: 0..<result.count))
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
    let options = PHImageRequestOptions()
    options.deliveryMode = .highQualityFormat
    options.resizeMode = .fast
    options.isNetworkAccessAllowed = true
    return await withCheckedContinuation { continuation in
      images.requestImage(
        for: asset, targetSize: CGSize(width: side, height: side), contentMode: .aspectFill,
        options: options
      ) { image, _ in
        continuation.resume(returning: image)
      }
    }
  }

  /// The photo as a file under its own name, ready for the draft's usual import. An edited
  /// photo keeps its edits and takes the extension of the data it now has.
  static func file(for asset: PHAsset) async throws -> URL {
    let options = PHImageRequestOptions()
    options.isNetworkAccessAllowed = true
    options.version = .current
    options.deliveryMode = .highQualityFormat
    let (data, typeIdentifier): (Data, String?) = try await withCheckedThrowingContinuation {
      continuation in
      PHImageManager.default().requestImageDataAndOrientation(for: asset, options: options) {
        data, typeIdentifier, _, _ in
        if let data {
          continuation.resume(returning: (data, typeIdentifier))
        } else {
          continuation.resume(
            throwing: ChatError.invalidContract(
              "This photo or video could not be loaded. Select it again."))
        }
      }
    }
    var name = PHAssetResource.assetResources(for: asset).first?.originalFilename ?? "Photo"
    if let typeIdentifier, let fileExtension = UTType(typeIdentifier)?.preferredFilenameExtension {
      name = (name as NSString).deletingPathExtension + "." + fileExtension
    }
    let folder = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    let url = folder.appending(path: name)
    try data.write(to: url, options: .atomic)
    return url
  }
}
