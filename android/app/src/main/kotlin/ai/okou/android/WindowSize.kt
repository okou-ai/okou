package ai.okou.android

import androidx.compose.runtime.Composable
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalWindowInfo
import androidx.compose.ui.unit.IntSize

@Composable
internal fun currentWindowSizeDp(): IntSize {
    val size = LocalWindowInfo.current.containerSize
    return with(LocalDensity.current) {
        IntSize(size.width.toDp().value.toInt(), size.height.toDp().value.toInt())
    }
}
