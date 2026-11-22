package ai.okou.android

import android.util.Log
import android.view.MotionEvent
import androidx.compose.ui.geometry.Offset

/** Temporary device-test diagnostics. Samples are printed only after the gesture. */
internal object NativeSwipeTrace {
    private data class MotionSample(
        val action: Int,
        val time: Long,
        val x: Float,
        val rawX: Float,
        val historicalX: Float?,
        val historicalTime: Long?,
    )

    private data class RowSample(
        val phase: String,
        val time: Long,
        val position: Offset,
        val previous: Offset,
        val windowX: Float,
    )

    private var active = false
    private val motion = ArrayList<MotionSample>(32)
    private val row = ArrayList<RowSample>(32)

    fun start() {
        motion.clear()
        row.clear()
        active = true
    }

    fun motion(event: MotionEvent) {
        if (!active) return
        val history = (event.historySize - 1).takeIf { it >= 0 }
        motion.add(
            MotionSample(
                event.actionMasked,
                event.eventTime,
                event.x,
                event.rawX,
                history?.let { event.getHistoricalX(it) },
                history?.let { event.getHistoricalEventTime(it) },
            )
        )
    }

    fun row(phase: String, time: Long, position: Offset, previous: Offset, windowX: Float) {
        if (active) row.add(RowSample(phase, time, position, previous, windowX))
    }

    fun finish() {
        if (!active) return
        active = false
        motion.forEach { Log.i("OkouSwipeTrace", "dispatch $it") }
        row.forEach { Log.i("OkouSwipeTrace", "row $it") }
    }
}
