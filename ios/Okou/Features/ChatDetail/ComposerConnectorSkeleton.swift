import SwiftUI

struct ComposerConnectorSkeletonRow: View {
  var showsDescription = false

  var body: some View {
    HStack(spacing: OkouSpace.md) {
      let logoSize = showsDescription ? OkouControl.logoTile : OkouControl.rowLeadingSlot
      OkouSkeletonBlock(width: logoSize, height: logoSize)
      VStack(alignment: .leading, spacing: OkouSpace.xs) {
        OkouSkeletonBlock(height: OkouControl.skeletonLine)
          .frame(maxWidth: OkouControl.logoTile * 3)
        if showsDescription {
          OkouSkeletonBlock(height: OkouSpace.md)
          OkouSkeletonBlock(height: OkouSpace.md)
            .frame(maxWidth: OkouControl.logoTile * 4)
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      if showsDescription {
        OkouSkeletonBlock(
          width: OkouControl.addControl, height: OkouControl.addControl, radius: OkouRadius.card)
      } else {
        OkouSkeletonBlock(width: OkouControl.logoTile, height: OkouControl.skeletonLine)
      }
    }
    .allowsHitTesting(false)
    .accessibilityHidden(true)
  }
}

/// Native list rows with a single accessible loading announcement.
struct ComposerConnectorSkeletonRows: View {
  let label: LocalizedStringKey
  let count: Int

  init(_ label: LocalizedStringKey, count: Int = 1) {
    self.label = label
    self.count = count
  }

  var body: some View {
    ForEach(0..<count, id: \.self) { index in
      ComposerConnectorSkeletonRow()
        .okouShimmer()
        .accessibilityRepresentation {
          if index == 0 { ProgressView(label) }
        }
    }
  }
}

struct ComposerConnectorDirectorySkeleton: View {
  var body: some View {
    LazyVStack(spacing: OkouSpace.sm) {
      ForEach(0..<6, id: \.self) { _ in
        ComposerConnectorSkeletonRow(showsDescription: true)
          .padding(.leading, OkouSpace.lg)
          .padding(.trailing, OkouSpace.six)
          .padding(.vertical, OkouSpace.md)
          .modifier(OkouSurfaceStyle())
      }
    }
    .padding(.horizontal, OkouSpace.lg)
    .okouShimmer()
    .accessibilityRepresentation { ProgressView("Loading connectors…") }
  }
}
