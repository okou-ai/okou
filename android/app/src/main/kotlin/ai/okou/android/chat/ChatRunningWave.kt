package ai.okou.android.chat

import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.withInfiniteAnimationFrameNanos
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.LongState
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.MotionDurationScale
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.flow.collectLatest

internal const val STATIC_RUNNING_FRAME = -1L
private const val WAVE_ROWS = 12
private const val ROW_DELAY_NANOS = 200_000_000L
private const val CYCLE_NANOS = WAVE_ROWS * ROW_DELAY_NANOS
private val centerEasing = CubicBezierEasing(0.33f, 0f, 0.66f, 1f)
private val rippleEasing = CubicBezierEasing(0f, 0f, 0.58f, 1f)

@Composable
internal fun rememberRunningWaveFrame(
    listState: LazyListState,
    runningKeys: Set<String>,
): LongState {
    val frame = remember { mutableLongStateOf(STATIC_RUNNING_FRAME) }
    val keys = rememberUpdatedState(runningKeys)
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(listState, lifecycle) {
        val motion = coroutineContext[MotionDurationScale]
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            // Android starts its scale observer on first access, before snapshotFlow can read it.
            motion?.scaleFactor
            snapshotFlow {
                    val active = keys.value
                    motion?.scaleFactor != 0f &&
                        active.isNotEmpty() &&
                        listState.layoutInfo.visibleItemsInfo.any { it.key in active }
                }
                .collectLatest { animate ->
                    if (animate) {
                        try {
                            while (true) withInfiniteAnimationFrameNanos { frame.longValue = it }
                        } finally {
                            frame.longValue = STATIC_RUNNING_FRAME
                        }
                    }
                }
        }
    }
    return frame
}

internal fun runningWavePhase(frameNanos: Long, row: Int): Float {
    val rowDelay = row % WAVE_ROWS * ROW_DELAY_NANOS
    return Math.floorMod(frameNanos % CYCLE_NANOS - rowDelay, CYCLE_NANOS).toFloat() / CYCLE_NANOS
}

internal fun DrawScope.drawRunningWave(color: Color, frameNanos: Long, row: Int) {
    val stroke = Stroke(1.dp.toPx())
    if (frameNanos == STATIC_RUNNING_FRAME) {
        drawCircle(color, radius = 3.dp.toPx())
        drawCircle(color, radius = 6.dp.toPx(), style = stroke)
        return
    }
    val phase = runningWavePhase(frameNanos, row)
    val peak = 0.52f
    val centerAmount =
        if (phase < peak) centerEasing.transform(phase / peak)
        else 1f - centerEasing.transform((phase - peak) / (1f - peak))
    drawCircle(
        color,
        radius = 4.5.dp.toPx() * (0.64f + 0.24f * centerAmount),
        alpha = 0.34f + 0.18f * centerAmount,
    )
    val rippleStart = 0.45f
    if (phase < rippleStart) return
    val rippleProgress =
        if (phase < peak) 0f else rippleEasing.transform((phase - peak) / (1f - peak))
    val rippleAlpha =
        if (phase < peak)
            0.34f * rippleEasing.transform((phase - rippleStart) / (peak - rippleStart))
        else 0.34f * (1f - rippleProgress)
    drawCircle(
        color,
        radius = 5.5.dp.toPx() * (0.8f + 0.76f * rippleProgress) - stroke.width / 2f,
        alpha = rippleAlpha,
        style = stroke,
    )
}
