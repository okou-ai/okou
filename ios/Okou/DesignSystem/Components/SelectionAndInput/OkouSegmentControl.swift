import SwiftUI

/// The page-level switch (Discover / Custom): the large segmented control's shape — a full
/// width 48 pt capsule track with equal segments and the selected one inset 2 pt — in the
/// web segment control's colours: a `segment-track` track, the selected segment raised in
/// `segment-selected` with the web's soft shadow, supporting text for the others.
struct OkouSegmentControl<Value: Hashable>: View {
  @Binding var selection: Value
  let options: [(value: Value, title: LocalizedStringKey)]

  var body: some View {
    HStack(spacing: 0) {
      ForEach(options.indices, id: \.self) { index in
        segment(options[index])
      }
    }
    .padding(OkouSpace.two)
    .frame(height: OkouControl.segmentHeight)
    .background(OkouColor.segmentTrack, in: Capsule())
  }

  private func segment(_ option: (value: Value, title: LocalizedStringKey)) -> some View {
    let isSelected = option.value == selection
    return Button {
      selection = option.value
    } label: {
      Text(option.title)
        .font(.okou(.subheadline).weight(.medium))
        .foregroundStyle(isSelected ? OkouColor.foreground : OkouColor.mutedForeground)
        .lineLimit(1)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background {
          if isSelected {
            Capsule().fill(OkouColor.segmentSelected)
              .shadow(
                color: .black.opacity(OkouElevation.segmentOpacity),
                radius: OkouElevation.segmentRadius, y: OkouElevation.segmentY)
          }
        }
        .contentShape(Capsule())
    }
    .buttonStyle(.plain)
    .accessibilityAddTraits(isSelected ? .isSelected : [])
  }
}
