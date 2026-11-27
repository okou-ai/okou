package ai.okou.android

import android.os.SystemClock
import kotlin.time.AbstractLongTimeSource
import kotlin.time.Duration
import kotlin.time.Duration.Companion.milliseconds
import kotlin.time.Duration.Companion.minutes
import kotlin.time.DurationUnit
import kotlin.time.TimeMark

private val memorySnapshotLifetime = 10.minutes

/** Snapshot age includes time spent in device sleep. */
internal object MemorySnapshotClock : AbstractLongTimeSource(DurationUnit.MILLISECONDS) {
    fun nowMillis(): Long = SystemClock.elapsedRealtime()

    override fun read(): Long = nowMillis()
}

/** Entry-time eligibility for a confirmed, scope-matched in-memory snapshot. */
internal fun Long?.isFreshMemorySnapshot(nowMillis: Long): Boolean =
    this != null && (nowMillis - this).milliseconds.isFreshMemorySnapshot()

internal fun TimeMark?.isFreshMemorySnapshot(): Boolean =
    this != null && elapsedNow().isFreshMemorySnapshot()

private fun Duration.isFreshMemorySnapshot(): Boolean =
    this >= Duration.ZERO && this < memorySnapshotLifetime
