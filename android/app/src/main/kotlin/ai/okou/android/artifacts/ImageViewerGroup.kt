package ai.okou.android.artifacts

import ai.okou.android.R
import ai.okou.android.state.ArtifactImageViewerState
import ai.okou.android.state.rememberArtifactImageViewerState
import ai.okou.android.state.rememberImageViewerExpanded
import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.PagerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.MotionDurationScale
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.LayoutDirection
import com.github.panpf.zoomimage.compose.ZoomState
import com.github.panpf.zoomimage.compose.rememberZoomState
import kotlinx.coroutines.launch

@Composable
internal fun ImageViewerGroup(
    pager: PagerState,
    wide: Boolean,
    back: () -> Unit,
    overlayStart: Dp? = null,
    toolbar: @Composable (ImageViewerPageNumber?, Boolean, () -> Unit) -> Unit,
    content: @Composable (Int, ZoomState?, ArtifactImageViewerState?, Modifier) -> Unit,
) {
    var expanded by rememberImageViewerExpanded()
    val count = pager.pageCount
    val selected = pager.settledPage
    val zoom = key(selected) { rememberZoomState() }
    val viewer = key(selected) { rememberArtifactImageViewerState(zoom.zoomable::viewpoint) }
    val scope = rememberCoroutineScope()
    val reducedMotion = scope.coroutineContext[MotionDurationScale]?.scaleFactor == 0f
    val previous = stringResource(R.string.artifact_image_previous_page)
    val next = stringResource(R.string.artifact_image_next_page)
    val rtl = LocalLayoutDirection.current == LayoutDirection.Rtl
    fun move(offset: Int): Boolean {
        val destination = selected + offset
        if (destination !in 0 until count || pager.isScrollInProgress) return false
        scope.launch {
            if (reducedMotion) pager.scrollToPage(destination)
            else pager.animateScrollToPage(destination)
        }
        return true
    }
    ImageViewerSurface(
        wide,
        expanded,
        { expanded = it },
        back,
        overlayStart,
        toolbar = { fullWindow, toggle ->
            toolbar(
                if (count > 1) ImageViewerPageNumber(selected + 1, count) else null,
                fullWindow,
                toggle,
            )
        },
    ) { modifier ->
        if (count == 1) {
            content(0, zoom, viewer, modifier)
        } else {
            val focus = remember { FocusRequester() }
            LaunchedEffect(focus) { focus.requestFocus() }
            HorizontalPager(
                state = pager,
                userScrollEnabled = !zoom.zoomable.isZoomed,
                modifier =
                    modifier
                        .fillMaxSize()
                        .testTag("image_viewer_pager")
                        .focusRequester(focus)
                        .onPreviewKeyEvent { event ->
                            if (event.type != KeyEventType.KeyDown || zoom.zoomable.isZoomed)
                                return@onPreviewKeyEvent false
                            when (event.key) {
                                Key.DirectionLeft -> move(if (rtl) 1 else -1)
                                Key.DirectionRight -> move(if (rtl) -1 else 1)
                                else -> false
                            }
                        }
                        .focusable(),
            ) { index ->
                val active = index == selected
                val semantics =
                    if (active)
                        Modifier.semantics {
                            customActions = buildList {
                                if (selected > 0)
                                    add(CustomAccessibilityAction(previous) { move(-1) })
                                if (selected + 1 < count)
                                    add(CustomAccessibilityAction(next) { move(1) })
                            }
                        }
                    else Modifier.clearAndSetSemantics {}
                Box(Modifier.fillMaxSize().then(semantics)) {
                    content(
                        index,
                        zoom.takeIf { active },
                        viewer.takeIf { active },
                        Modifier.fillMaxSize(),
                    )
                }
            }
        }
    }
}
