package ai.okou.android.chat

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animate
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.awaitDragOrCancellation
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.awaitHorizontalTouchSlopOrCancellation
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemGestures
import androidx.compose.material3.Icon
import androidx.compose.material3.ListItemDefaults
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
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.clipRect
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.PointerType
import androidx.compose.ui.input.pointer.changedToUpIgnoreConsumed
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInWindow
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlin.math.abs
import kotlin.math.roundToInt

private val swipeRevealLimit = 112.dp
private val swipeActionInset = 12.dp
private val swipeIconSize = 18.dp
private val swipeActionGap = 6.dp
private const val SwipeHorizontalRatio = 1.5f
private const val SwipeFeedbackMillis = 150
private val swipeReturn = tween<Float>(200, easing = ChatListMotionEasing)
private val swipeColorFeedback = tween<Color>(SwipeFeedbackMillis, easing = ChatListMotionEasing)
private val swipeIconFeedback = tween<Float>(SwipeFeedbackMillis, easing = ChatListMotionEasing)

private data class SwipeReveal(val offset: Float = 0f, val ready: Boolean = false) {
    val fromStart: Boolean
        get() = offset > 0f
}

private fun Offset.reachesSwipeThreshold(threshold: Float): Boolean =
    abs(x) >= maxOf(threshold, SwipeHorizontalRatio * abs(y))

@Composable
internal fun ChatRowSwipe(
    readAction: ChatRowAction?,
    archiveAction: ChatRowAction?,
    performAction: (ChatRowAction) -> Unit,
    content: @Composable (Modifier) -> Unit,
) {
    val action by rememberUpdatedState(performAction)
    val hapticFeedback by rememberUpdatedState(LocalHapticFeedback.current)
    var reveal by remember { mutableStateOf(SwipeReveal()) }
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
            animate(reveal.offset, 0f, animationSpec = swipeReturn) { value, _ ->
                reveal = SwipeReveal(offset = value)
            }
            returning = false
        }
    }
    val input =
        if (readAction == null && archiveAction == null) Modifier
        else
            Modifier.pointerInput(readAction, archiveAction, direction, leftEdge, rightEdge) {
                val directionSign = if (direction == LayoutDirection.Ltr) 1f else -1f
                val threshold = 72.dp.toPx()
                val limit = swipeRevealLimit.toPx()
                val minimum = if (archiveAction == null) 0f else -limit
                val maximum = if (readAction == null) 0f else limit
                fun updateReveal(delta: Offset) {
                    val offset = (delta.x * directionSign).coerceIn(minimum, maximum)
                    val next =
                        SwipeReveal(offset, offset != 0f && delta.reachesSwipeThreshold(threshold))
                    if (next.ready && (!reveal.ready || reveal.fromStart != next.fromStart)) {
                        hapticFeedback.performHapticFeedback(
                            HapticFeedbackType.GestureThresholdActivate,
                        )
                    }
                    reveal = next
                }
                awaitEachGesture {
                    val down = awaitFirstDown(requireUnconsumed = false)
                    val x = windowX + down.position.x
                    if (
                        returning ||
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
                            if (available && abs(delta.x) >= SwipeHorizontalRatio * abs(delta.y)) {
                                change.consume()
                            }
                        } ?: return@awaitEachGesture
                    try {
                        updateReveal(start.position - down.position)
                        while (true) {
                            val change = awaitDragOrCancellation(down.id) ?: break
                            if (change.id != down.id) break
                            val delta = change.position - down.position
                            if (change.changedToUpIgnoreConsumed()) {
                                val fromStart = delta.x * directionSign > 0f
                                val releasedAction = if (fromStart) readAction else archiveAction
                                if (
                                    releasedAction != null &&
                                        reveal.offset != 0f &&
                                        fromStart == reveal.fromStart &&
                                        delta.reachesSwipeThreshold(threshold)
                                ) {
                                    reveal = SwipeReveal()
                                    action(releasedAction)
                                }
                                break
                            }
                            updateReveal(delta)
                            change.consume()
                        }
                    } finally {
                        reveal = reveal.copy(ready = false)
                        returning = reveal.offset != 0f
                    }
                }
            }
    Box(
        Modifier.clip(ListItemDefaults.shapes().shape)
            .onGloballyPositioned { windowX = it.positionInWindow().x }
            .then(input),
    ) {
        val revealed = if (reveal.fromStart) readAction else archiveAction
        if (reveal.offset != 0f && revealed != null) {
            ChatSwipeAction(revealed, reveal, Modifier.matchParentSize())
        }
        content(Modifier.offset { IntOffset(reveal.offset.roundToInt(), 0) })
    }
}

@Composable
private fun ChatSwipeAction(action: ChatRowAction, reveal: SwipeReveal, modifier: Modifier) {
    val colors = MaterialTheme.colorScheme
    val background by
        animateColorAsState(
            if (reveal.ready) colors.primary else colors.secondaryContainer,
            animationSpec = swipeColorFeedback,
            label = "Swipe action background",
        )
    val foreground by
        animateColorAsState(
            if (reveal.ready) colors.onPrimary else colors.onSecondaryContainer,
            animationSpec = swipeColorFeedback,
            label = "Swipe action foreground",
        )
    val scale by
        animateFloatAsState(
            if (reveal.ready) 1.12f else 1f,
            animationSpec = swipeIconFeedback,
            label = "Swipe action icon scale",
        )
    val label = stringResource(action.label(short = true))
    val style =
        MaterialTheme.typography.labelMedium.copy(
            fontSize = 13.sp,
            lineHeight = 20.sp,
            letterSpacing = 0.sp,
        )
    val icon: @Composable () -> Unit = {
        Icon(
            painterResource(action.icon()),
            contentDescription = null,
            tint = foreground,
            modifier =
                Modifier.size(swipeIconSize).graphicsLayer {
                    scaleX = scale
                    scaleY = scale
                },
        )
    }
    Box(
        modifier
            .drawWithContent {
                // Use the same physical edge as the row's rounded, layout-relative offset.
                val width = abs(reveal.offset.roundToInt()).toFloat().coerceAtMost(size.width)
                val fromLeft = reveal.fromStart == (layoutDirection == LayoutDirection.Ltr)
                val left = if (fromLeft) 0f else size.width - width
                clipRect(left = left, right = left + width) { this@drawWithContent.drawContent() }
            }
            .background(background)
            .padding(horizontal = swipeActionInset)
            .clearAndSetSemantics {},
        contentAlignment = if (reveal.fromStart) Alignment.CenterStart else Alignment.CenterEnd,
    ) {
        Row(
            horizontalArrangement = Arrangement.spacedBy(swipeActionGap),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (reveal.fromStart) icon()
            Text(label, color = foreground, style = style, maxLines = 1, softWrap = false)
            if (!reveal.fromStart) icon()
        }
    }
}
