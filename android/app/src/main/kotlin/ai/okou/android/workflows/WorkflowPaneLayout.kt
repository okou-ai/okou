package ai.okou.android.workflows

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.nestedscroll.NestedScrollConnection
import androidx.compose.ui.input.nestedscroll.NestedScrollSource
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

internal val WorkflowPaneMaxContentWidth = 730.dp

internal fun workflowPaneHorizontalInset(wide: Boolean) = if (wide) 32.dp else 20.dp

/** Keep controls in place while there is room for a usable content viewport. */
@Composable
internal fun WorkflowPaneLayout(
    feedback: @Composable () -> Unit,
    minimumBodyHeight: Dp,
    modifier: Modifier = Modifier,
    controlsAtTop: Boolean = false,
    scrollEnabled: Boolean = true,
    body: @Composable () -> Unit,
    controls: @Composable () -> Unit,
) {
    val scroll = rememberScrollState()
    val bodyScroll =
        if (controlsAtTop && scrollEnabled) {
            val connection =
                remember(scroll) {
                    object : NestedScrollConnection {
                        override fun onPreScroll(
                            available: Offset,
                            source: NestedScrollSource,
                        ): Offset {
                            if (available.y >= 0f || !scroll.canScrollForward) return Offset.Zero
                            // Expose the results viewport before scrolling rows inside it.
                            return Offset(0f, -scroll.dispatchRawDelta(-available.y))
                        }
                    }
                }
            Modifier.nestedScroll(connection)
        } else Modifier
    BoxWithConstraints(modifier.fillMaxSize(), contentAlignment = Alignment.TopCenter) {
        val viewportHeight = constraints.maxHeight
        val controlsGroup: @Composable () -> Unit = {
            Column(Modifier.fillMaxWidth()) { controls() }
        }
        Layout(
            content = {
                if (controlsAtTop) controlsGroup()
                Box(Modifier.fillMaxSize().then(bodyScroll)) { body() }
                if (!controlsAtTop) controlsGroup()
                Box { feedback() }
            },
            modifier =
                Modifier.widthIn(max = WorkflowPaneMaxContentWidth)
                    .fillMaxWidth()
                    .verticalScroll(scroll, overscrollEffect = null, enabled = scrollEnabled),
        ) { children, constraints ->
            val loose = constraints.copy(minHeight = 0)
            val controlsIndex = if (controlsAtTop) 0 else 1
            val group = children[controlsIndex].measure(loose)
            val bodyHeight =
                maxOf(
                    viewportHeight - group.height,
                    minimumBodyHeight.roundToPx().coerceAtMost(viewportHeight),
                )
            val content =
                children[1 - controlsIndex].measure(
                    loose.copy(minHeight = bodyHeight, maxHeight = bodyHeight),
                )
            val notice = children[2].measure(loose.copy(maxHeight = viewportHeight))
            val bodyTop = if (controlsAtTop) group.height else 0
            val controlsTop = if (controlsAtTop) 0 else content.height
            layout(constraints.maxWidth, content.height + group.height) {
                group.placeRelative(0, controlsTop)
                content.placeRelative(0, bodyTop)
                if (notice.height > 0) {
                    // Keep the overlay inside the pane without giving it scroll extent.
                    val viewportTop = scroll.value
                    val visibleBodyBottom =
                        minOf(bodyTop + content.height, viewportTop + viewportHeight)
                    notice.placeRelative(
                        (constraints.maxWidth - notice.width) / 2,
                        (visibleBodyBottom - notice.height).coerceAtLeast(viewportTop),
                    )
                }
            }
        }
    }
}
