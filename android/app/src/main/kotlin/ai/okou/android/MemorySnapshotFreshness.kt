package ai.okou.android

import kotlin.time.Duration
import kotlin.time.Duration.Companion.milliseconds
import kotlin.time.Duration.Companion.minutes
import kotlin.time.TimeMark

private val memorySnapshotLifetime = 10.minutes

/** Entry-time eligibility for a confirmed, scope-matched in-memory snapshot. */
internal fun Long?.isFreshMemorySnapshot(nowMillis: Long): Boolean =
    this != null && (nowMillis - this).milliseconds.isFreshMemorySnapshot()

internal fun TimeMark?.isFreshMemorySnapshot(): Boolean =
    this != null && elapsedNow().isFreshMemorySnapshot()

private fun Duration.isFreshMemorySnapshot(): Boolean =
    this >= Duration.ZERO && this < memorySnapshotLifetime
