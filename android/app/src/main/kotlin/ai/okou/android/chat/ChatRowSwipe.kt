package ai.okou.android.chat

import androidx.compose.animation.core.animate
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.awaitHorizontalTouchSlopOrCancellation
import androidx.compose.foundation.gestures.horizontalDrag
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.systemGestures
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.input.pointer.PointerType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChange
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInWindow
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlin.math.abs
import kotlin.math.roundToInt

private val swipeReveal = 112.dp
private val swipeLabelInset = 12.dp

@Composable
internal fun ChatRowSwipe(
    readAction: ChatRowAction?,
    archiveAction: ChatRowAction?,
    performAction: (ChatRowAction) -> Unit,
    content: @Composable (Modifier) -> Unit,
) {
    val action by rememberUpdatedState(performAction)
    var offset by remember { mutableFloatStateOf(0f) }
    var returning by remember { mutableStateOf(false) }
    var windowX by remember { mutableFloatStateOf(0f) }
    val density = LocalDensity.current
    val direction = LocalLayoutDirection.current
    val view = LocalView.current
    val gestures = WindowInsets.systemGestures
    val leftEdge = gestures.getLeft(density, direction)
    val rightEdge = gestures.getRight(density, direction)
    LaunchedEffect(returning) {
        if (returning) {
            animate(offset, 0f, animationSpec = tween(160)) { value, _ -> offset = value }
            returning = false
        }
    }
    val input =
        if (readAction == null && archiveAction == null) Modifier
        else
            Modifier.pointerInput(readAction, archiveAction, direction, leftEdge, rightEdge) {
                val directionSign = if (direction == LayoutDirection.Ltr) 1f else -1f
                val threshold = 72.dp.toPx()
                val reveal = swipeReveal.toPx()
                awaitEachGesture {
                    val down = awaitFirstDown(requireUnconsumed = false)
                    val x = windowX + down.position.x
                    if (
                        down.type != PointerType.Touch ||
                            x < leftEdge ||
                            x >= view.width - rightEdge
                    )
                        return@awaitEachGesture
                    val start =
                        awaitHorizontalTouchSlopOrCancellation(down.id) { change, _ ->
                            if (change.id != down.id) return@awaitHorizontalTouchSlopOrCancellation
                            val delta = change.position - down.position
                            val logical = delta.x * directionSign
                            val available =
                                if (logical > 0) readAction != null else archiveAction != null
                            if (available && abs(delta.x) > abs(delta.y)) change.consume()
                        } ?: return@awaitEachGesture
                    returning = false
                    val minimum = if (archiveAction == null) 0f else -reveal
                    val maximum = if (readAction == null) 0f else reveal
                    var distance = (start.position.x - down.position.x) * directionSign
                    offset = distance.coerceIn(minimum, maximum)
                    try {
                        val released =
                            horizontalDrag(start.id) { change ->
                                if (change.id == down.id) {
                                    distance += change.positionChange().x * directionSign
                                    offset = distance.coerceIn(minimum, maximum)
                                    change.consume()
                                }
                            }
                        if (released) {
                            val selected =
                                when {
                                    distance >= threshold -> readAction
                                    distance <= -threshold -> archiveAction
                                    else -> null
                                }
                            selected?.let(action)
                        }
                    } finally {
                        returning = offset != 0f
                    }
                }
            }
    Box(
        Modifier.clip(RoundedCornerShape(8.dp))
            .onGloballyPositioned { windowX = it.positionInWindow().x }
            .then(input)
    ) {
        val revealed = if (offset > 0) readAction else archiveAction
        if (offset != 0f && revealed != null) {
            val colors = MaterialTheme.colorScheme
            Box(
                Modifier.matchParentSize()
                    .background(colors.secondaryContainer)
                    .padding(horizontal = swipeLabelInset)
                    .clearAndSetSemantics {},
                contentAlignment = if (offset > 0) Alignment.CenterStart else Alignment.CenterEnd,
            ) {
                Text(
                    stringResource(revealed.label()),
                    modifier = Modifier.widthIn(max = swipeReveal - swipeLabelInset),
                    color = colors.onSecondaryContainer,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                    style =
                        MaterialTheme.typography.labelMedium.copy(
                            fontSize = 13.sp,
                            lineHeight = 20.sp,
                            letterSpacing = 0.sp,
                        ),
                )
            }
        }
        content(Modifier.offset { IntOffset(offset.roundToInt(), 0) })
    }
}
