package ai.okou.android.artifacts

import java.text.SimpleDateFormat
import java.time.Instant
import java.util.Locale
import java.util.TimeZone
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [24, 35])
class ArtifactDatesTest {
    @Test
    fun bothOccurrencesOfLocalMidnightBelongToTheSameDay() {
        val previousDate = Instant.parse("2024-11-03T03:59:59.999Z").toEpochMilli()
        val firstHalfPastMidnight = Instant.parse("2024-11-03T04:30:00Z").toEpochMilli()
        val secondHalfPastMidnight = Instant.parse("2024-11-03T05:30:00Z").toEpochMilli()
        val sameDay = havanaDatesAt("2024-11-03T15:00:00Z")
        val nextDay = havanaDatesAt("2024-11-04T15:00:00Z")

        assertEquals(ArtifactDay.Yesterday, sameDay.group(previousDate))
        assertEquals(ArtifactDay.Earlier, nextDay.group(previousDate))
        for (createdAt in listOf(firstHalfPastMidnight, secondHalfPastMidnight)) {
            assertEquals(ArtifactDay.Today, sameDay.group(createdAt))
            assertEquals("Today 00:30", sameDay.timestamp(createdAt, showDay = true))
            assertEquals(ArtifactDay.Yesterday, nextDay.group(createdAt))
            assertEquals("Yesterday 00:30", nextDay.timestamp(createdAt, showDay = true))
        }
    }

    private fun havanaDatesAt(now: String) =
        ArtifactDates(
            nowMillis = Instant.parse(now).toEpochMilli(),
            zone = TimeZone.getTimeZone("America/Havana"),
            formatTime = SimpleDateFormat("HH:mm", Locale.ROOT),
            formatDate = SimpleDateFormat("MMM d, yyyy", Locale.ROOT),
            formatMonthDay = SimpleDateFormat("MMM d", Locale.ROOT),
            todayLabel = "Today",
            yesterdayLabel = "Yesterday",
        )
}
