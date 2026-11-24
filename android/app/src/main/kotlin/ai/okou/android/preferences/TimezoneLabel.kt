package ai.okou.android.preferences

import ai.okou.android.R
import android.icu.text.TimeZoneNames
import android.icu.util.TimeZone
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.res.stringResource
import java.text.Collator
import java.util.Locale
import kotlin.math.abs

private const val utcTimezone = "Etc/UTC"
private const val gmtTimezone = "Etc/GMT"

private val locationTimezones by lazy {
    TimeZone.getAvailableIDs()
        .asSequence()
        .mapNotNull { TimeZone.getCanonicalID(it) }
        .distinct()
        // ICU uses the world region for zones without a named location.
        .filter { TimeZone.getRegion(it) != "001" }
        .toSet() + utcTimezone
}

internal data class TimezoneOption(val id: String, val name: String?, val offsetMinutes: Int?)

internal fun timezoneOptions(
    current: String,
    locale: Locale,
    utcName: String,
    atMillis: Long = System.currentTimeMillis(),
): List<TimezoneOption> {
    val canonical = TimeZone.getCanonicalID(current)
    val selectedZone = if (isUtcTimezone(canonical)) utcTimezone else canonical
    val regions = locationTimezones.map { if (it == selectedZone) current else it }
    val ids = if (current in regions) regions else regions + current
    val names = TimeZoneNames.getInstance(locale)
    val collator = Collator.getInstance(locale)
    return ids.map { timezoneOption(it, names, utcName, atMillis) }
        .sortedWith(
            compareBy<TimezoneOption> { it.offsetMinutes ?: Int.MAX_VALUE }
                .thenComparator { left, right ->
                    collator.compare(left.name ?: left.id, right.name ?: right.id)
                }
                .thenBy { it.id },
        )
}

private fun isUtcTimezone(canonical: String?) = canonical == utcTimezone || canonical == gmtTimezone

private fun timezoneOption(
    id: String,
    names: TimeZoneNames,
    utcName: String,
    atMillis: Long,
): TimezoneOption {
    val zone = TimeZone.getFrozenTimeZone(id)
    if (zone.id == TimeZone.UNKNOWN_ZONE_ID) return TimezoneOption(id, null, null)
    val canonical = TimeZone.getCanonicalID(id)
    val name =
        if (isUtcTimezone(canonical)) utcName else names.getExemplarLocationName(canonical ?: id)
    return TimezoneOption(id, name, zone.getOffset(atMillis) / 60_000)
}

@Composable
internal fun timezoneLabel(id: String): String {
    val locale = LocalConfiguration.current.locales[0]
    val names = remember(locale) { TimeZoneNames.getInstance(locale) }
    val utcName = stringResource(R.string.settings_timezone_utc)
    return timezoneLabel(timezoneOption(id, names, utcName, System.currentTimeMillis()))
}

@Composable
internal fun timezoneLabel(option: TimezoneOption): String {
    val name = option.name ?: return option.id
    val offsetMinutes = option.offsetMinutes ?: return option.id
    val hours = abs(offsetMinutes) / 60
    val minutes = abs(offsetMinutes) % 60
    val sign = if (offsetMinutes < 0) "-" else "+"
    val offset =
        if (minutes == 0) "$sign$hours" else "$sign$hours:${minutes.toString().padStart(2, '0')}"
    return stringResource(R.string.settings_timezone_format, name, offset)
}
