package ai.okou.android.preferences

import ai.okou.android.R
import ai.okou.android.SettingsChoiceRow
import ai.okou.android.SettingsGroup
import ai.okou.android.SettingsIcon
import ai.okou.android.SettingsPickerRow
import ai.okou.android.SettingsRadioOptions
import ai.okou.android.SettingsSection
import ai.okou.android.SettingsSheet
import ai.okou.android.api.generated.UserPreferencesColorTheme
import ai.okou.android.api.generated.UserPreferencesLocale
import ai.okou.android.api.generated.UserPreferencesTheme
import ai.okou.android.resolveDark
import ai.okou.android.resolvePalette
import android.icu.text.TimeZoneNames
import androidx.compose.foundation.background
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.compose.currentStateAsState

@Composable
internal fun MemberPreferencesSettings(model: MemberPreferencesModel) {
    val state by model.uiState.collectAsStateWithLifecycle()
    val lifecycleState by LocalLifecycleOwner.current.lifecycle.currentStateAsState()
    val active = lifecycleState.isAtLeast(Lifecycle.State.RESUMED)
    DisposableEffect(model, active) {
        model.settingsVisibilityChanged(active)
        onDispose { model.settingsVisibilityChanged(false) }
    }
    val dark = state.theme.resolveDark(isSystemInDarkTheme())
    SettingsSection(stringResource(R.string.settings_appearance_group)) {
        SettingsGroup {
            val appearanceTitle = stringResource(R.string.appearance)
            val colorTitle = stringResource(R.string.preference_color_theme)
            SettingsPickerRow(
                appearanceTitle,
                value = stringResource(appearanceLabel(state.theme)),
                leading = { SettingsIcon(R.drawable.ic_brightness_6) },
            ) { dismiss ->
                SettingsSheet(appearanceTitle, dismiss) {
                    SettingsRadioOptions(
                        options = UserPreferencesTheme.entries,
                        selected = state.theme,
                        label = ::appearanceLabel,
                        enabled = true,
                    ) { mode ->
                        dismiss()
                        model.selectTheme(mode)
                    }
                }
            }
            HorizontalDivider()
            SettingsPickerRow(
                colorTitle,
                value = stringResource(paletteLabel(state.colorTheme)),
                leading = { SettingsIcon(R.drawable.ic_palette) },
            ) { dismiss ->
                SettingsSheet(colorTitle, dismiss) {
                    PaletteOptions(state.colorTheme, dark) { palette ->
                        dismiss()
                        model.selectColorTheme(palette)
                    }
                }
            }
        }
    }
    SettingsSection(stringResource(R.string.settings_region)) {
        SettingsGroup {
            val languageTitle = stringResource(R.string.preference_language)
            SettingsPickerRow(
                languageTitle,
                value = stringResource(languageLabel(state.locale)),
                leading = { SettingsIcon(R.drawable.ic_translate) },
                enabled = state.supportedLocales.size > 1,
            ) { dismiss ->
                SettingsSheet(languageTitle, dismiss) {
                    SettingsRadioOptions(
                        options = state.supportedLocales,
                        selected = state.locale,
                        label = ::languageLabel,
                        enabled = true,
                    ) { locale ->
                        dismiss()
                        model.selectLocale(locale)
                    }
                }
            }
            HorizontalDivider()
            TimezonePicker(state.timezone, model::selectTimezone)
        }
        if (state.pending?.cloudBrowser == null) PreferenceFeedback(state, model::retry)
    }
}

private val commonTimezones =
    listOf(
        "Asia/Shanghai",
        "Asia/Tokyo",
        "Asia/Singapore",
        "Europe/London",
        "America/Los_Angeles",
        "Etc/UTC",
        "America/New_York",
        "America/Chicago",
        "America/Denver",
        "America/Anchorage",
        "Pacific/Honolulu",
        "America/Toronto",
        "America/Vancouver",
        "America/Sao_Paulo",
        "Europe/Berlin",
        "Europe/Paris",
        "Europe/Moscow",
        "Asia/Dubai",
        "Asia/Kolkata",
        "Asia/Seoul",
        "Australia/Sydney",
        "Pacific/Auckland",
    )

@Composable
private fun TimezonePicker(current: String, onSelect: (String) -> Unit) {
    val title = stringResource(R.string.settings_timezone)
    val utc = stringResource(R.string.settings_timezone_utc)
    val locale = LocalConfiguration.current.locales[0]
    val labels = remember(locale) { TimeZoneNames.getInstance(locale) }
    fun label(id: String): String =
        when (id) {
            "UTC",
            "Etc/UTC" -> utc
            else -> labels.getExemplarLocationName(id) ?: id
        }
    SettingsPickerRow(
        title,
        value = label(current),
        leading = { SettingsIcon(R.drawable.ic_schedule) },
    ) { dismiss ->
        SettingsSheet(title, dismiss) {
            Text(
                stringResource(R.string.settings_timezone_hint),
                Modifier.padding(horizontal = 8.dp),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                style =
                    MaterialTheme.typography.bodyMedium.copy(fontSize = 13.sp, lineHeight = 20.sp),
            )
            val options =
                if (current in commonTimezones) commonTimezones
                else
                    listOf(current) +
                        commonTimezones.filterNot { current == "UTC" && it == "Etc/UTC" }
            Column(Modifier.fillMaxWidth().selectableGroup()) {
                options.forEach { zone ->
                    SettingsChoiceRow(
                        label(zone),
                        selected = zone == current,
                        enabled = true,
                        onClick = {
                            dismiss()
                            onSelect(zone)
                        },
                    )
                }
            }
        }
    }
}

@Composable
internal fun PreferenceFeedback(state: MemberPreferencesState, retry: () -> Unit) {
    if (state.recovering) return
    val message =
        when (state.status) {
            PreferenceStatus.Ready,
            PreferenceStatus.Saving,
            PreferenceStatus.Refreshing -> return
            PreferenceStatus.SaveFailed -> R.string.preference_save_failed
            PreferenceStatus.RefreshFailed -> R.string.preference_refresh_failed
        }
    val colors = MaterialTheme.colorScheme
    Column(Modifier.fillMaxWidth().semantics { liveRegion = LiveRegionMode.Polite }) {
        Text(
            stringResource(message),
            color = colors.error,
            style = MaterialTheme.typography.bodyMedium,
        )
        TextButton(
            onClick = retry,
            colors = ButtonDefaults.textButtonColors(contentColor = colors.onSurface),
        ) {
            Text(stringResource(R.string.retry))
        }
    }
}

@Composable
private fun PaletteOptions(
    selected: UserPreferencesColorTheme,
    dark: Boolean,
    onSelect: (UserPreferencesColorTheme) -> Unit,
) {
    BoxWithConstraints(Modifier.fillMaxWidth().selectableGroup()) {
        val columns = if (maxWidth < 312.dp || LocalDensity.current.fontScale > 1.3f) 1 else 2
        Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            UserPreferencesColorTheme.entries.chunked(columns).forEach { choices ->
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    choices.forEach { palette ->
                        SettingsChoiceRow(
                            stringResource(paletteLabel(palette)),
                            selected = palette == selected,
                            enabled = true,
                            onClick = { onSelect(palette) },
                            modifier = Modifier.weight(1f),
                            leading = { PaletteSwatch(palette, dark) },
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun PaletteSwatch(palette: UserPreferencesColorTheme, dark: Boolean) {
    val context = LocalContext.current
    val configuration = LocalConfiguration.current
    val preview =
        remember(context, configuration, dark, palette) { resolvePalette(context, dark, palette) }
    Box(
        Modifier.size(24.dp)
            .background(
                Brush.linearGradient(listOf(preview.scheme.primary, preview.swatchCompanion)),
                CircleShape,
            )
    )
}

private fun appearanceLabel(theme: UserPreferencesTheme): Int =
    when (theme) {
        UserPreferencesTheme.SYSTEM -> R.string.appearance_system
        UserPreferencesTheme.LIGHT -> R.string.appearance_light
        UserPreferencesTheme.DARK -> R.string.appearance_dark
    }

private fun paletteLabel(palette: UserPreferencesColorTheme): Int =
    when (palette) {
        UserPreferencesColorTheme.DEFAULT -> R.string.palette_default
        UserPreferencesColorTheme.GOLDEN_HOUR -> R.string.palette_golden_hour
        UserPreferencesColorTheme.CITRUS_SPARK -> R.string.palette_citrus_spark
        UserPreferencesColorTheme.BERRY_BLUSH -> R.string.palette_berry_blush
        UserPreferencesColorTheme.COTTON_SKY -> R.string.palette_cotton_sky
        UserPreferencesColorTheme.BLUE_HORIZON -> R.string.palette_blue_horizon
        UserPreferencesColorTheme.DAYDREAM -> R.string.palette_daydream
        UserPreferencesColorTheme.DEEP_LAGOON -> R.string.palette_deep_lagoon
    }

private fun languageLabel(locale: UserPreferencesLocale): Int =
    when (locale) {
        UserPreferencesLocale.EN_US -> R.string.language_en_us
        UserPreferencesLocale.PT_BR -> R.string.language_pt_br
        UserPreferencesLocale.JA_JP -> R.string.language_ja_jp
        UserPreferencesLocale.KO_KR -> R.string.language_ko_kr
        UserPreferencesLocale.ID_ID -> R.string.language_id_id
        UserPreferencesLocale.DE_DE -> R.string.language_de_de
        UserPreferencesLocale.ES_ES -> R.string.language_es_es
        UserPreferencesLocale.IT_IT -> R.string.language_it_it
        UserPreferencesLocale.FR_FR -> R.string.language_fr_fr
        UserPreferencesLocale.HI_IN -> R.string.language_hi_in
        UserPreferencesLocale.ZH_HANS -> R.string.language_zh_hans
        UserPreferencesLocale.ZH_HANT -> R.string.language_zh_hant
    }
