package ai.okou.android

import ai.okou.android.chat.composerHorizontalInset
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import org.junit.Assert.assertEquals
import org.junit.Test

class WindowSizeTest {
    @Test
    fun composerInsetsHonorWidthAndShortHeightBoundaries() {
        assertEquals(12.dp, composerHorizontalInset(IntSize(600, 479)))
        assertEquals(20.dp, composerHorizontalInset(IntSize(599, 480)))
        assertEquals(24.dp, composerHorizontalInset(IntSize(600, 480)))
    }
}
