package ai.okou.android.preferences

import ai.okou.android.R
import android.icu.text.TimeZoneNames
import android.icu.util.TimeZone
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.res.stringResource
import kotlin.math.abs

@Composable
internal fun timezoneLabel(id: String): String {
    val zone = remember(id) { TimeZone.getFrozenTimeZone(id) }
    if (zone.id == TimeZone.UNKNOWN_ZONE_ID) return id

    val locale = LocalConfiguration.current.locales[0]
    val name =
        when (id) {
            "UTC",
            "Etc/UTC",
            "GMT" -> stringResource(R.string.settings_timezone_utc)
            else ->
                remember(id, locale) {
                    TimeZoneNames.getInstance(locale).getExemplarLocationName(id) ?: id
                }
        }
    val offsetMinutes = zone.getOffset(System.currentTimeMillis()) / 60_000
    val hours = abs(offsetMinutes) / 60
    val minutes = abs(offsetMinutes) % 60
    val sign = if (offsetMinutes < 0) "-" else "+"
    val offset =
        if (minutes == 0) "$sign$hours" else "$sign$hours:${minutes.toString().padStart(2, '0')}"
    return stringResource(R.string.settings_timezone_format, name, offset)
}
