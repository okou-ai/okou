package ai.okou.android

import androidx.compose.runtime.Composable
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalWindowInfo
import androidx.compose.ui.unit.IntSize

internal fun isShortWindowHeight(heightDp: Int): Boolean = heightDp < 480

internal fun isAtLeastMediumWindowWidth(widthDp: Int): Boolean = widthDp >= 600

internal fun supportsWorkspacePanes(widthDp: Int, heightDp: Int): Boolean =
    widthDp >= 840 && !isShortWindowHeight(heightDp)

@Composable
internal fun isShortWindowHeight(): Boolean = isShortWindowHeight(currentWindowSizeDp().height)

@Composable
internal fun currentWindowSizeDp(): IntSize {
    val size = LocalWindowInfo.current.containerSize
    return with(LocalDensity.current) {
        IntSize(size.width.toDp().value.toInt(), size.height.toDp().value.toInt())
    }
}
