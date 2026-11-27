package ai.okou.android

import android.os.SystemClock
import java.time.Duration
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowSystemClock

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = TestOkouApplication::class)
class MemorySnapshotFreshnessTest {
    @Test
    fun bothTimestampFormsExpireAfterTenMinutesOfDeepSleep() {
        val millis = MemorySnapshotClock.nowMillis()
        val mark = MemorySnapshotClock.markNow()
        val uptime = SystemClock.uptimeMillis()

        ShadowSystemClock.simulateDeepSleep(Duration.ofMillis(599_999))
        assertTrue(millis.isFreshMemorySnapshot(MemorySnapshotClock.nowMillis()))
        assertTrue(mark.isFreshMemorySnapshot())

        ShadowSystemClock.simulateDeepSleep(Duration.ofMillis(1))
        assertFalse(millis.isFreshMemorySnapshot(MemorySnapshotClock.nowMillis()))
        assertFalse(mark.isFreshMemorySnapshot())
        assertEquals(uptime, SystemClock.uptimeMillis())
    }
}
