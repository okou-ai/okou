package ai.okou.android.preferences

import ai.okou.android.PaneFeedbackError
import ai.okou.android.PaneFeedbackMessage
import ai.okou.android.R
import ai.okou.android.SettingsChoicePanel
import ai.okou.android.SettingsChoiceRow
import ai.okou.android.SettingsChoiceSheet
import ai.okou.android.SettingsGroup
import ai.okou.android.SettingsIcon
import ai.okou.android.SettingsPickerRow
import ai.okou.android.SettingsRadioSheet
import ai.okou.android.SettingsSection
import ai.okou.android.api.generated.UserPreferencesColorTheme
import ai.okou.android.api.generated.UserPreferencesLocale
import ai.okou.android.api.generated.UserPreferencesTheme
import ai.okou.android.auth.initialLocale
import ai.okou.android.auth.initialTimezone
import ai.okou.android.resolveDark
import ai.okou.android.resolvePalette
import androidx.compose.foundation.background
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.grid.rememberLazyGridState
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.core.app.LocaleManagerCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import java.util.Locale

// The preference initialization endpoint uses this value when the device has no valid zone.
private const val defaultTimezone = "America/Los_Angeles"

@Composable
internal fun MemberPreferencesSettings(
    model: MemberPreferencesModel?,
    cachedPreferences: CachedMemberPreferences? = null,
) {
    val state = model?.uiState?.collectAsStateWithLifecycle()?.value
    val theme = state?.theme ?: cachedPreferences?.theme ?: UserPreferencesTheme.SYSTEM
    val colorTheme =
        state?.colorTheme ?: cachedPreferences?.colorTheme ?: UserPreferencesColorTheme.DEFAULT
    val systemDark = isSystemInDarkTheme()
    val dark = theme.resolveDark(systemDark)
    SettingsSection(stringResource(R.string.settings_appearance_group)) {
        SettingsGroup {
            val appearanceTitle = stringResource(R.string.appearance)
            val colorTitle = stringResource(R.string.preference_color_theme)
            SettingsPickerRow(
                appearanceTitle,
                value = stringResource(appearanceLabel(theme)),
                leading = { SettingsIcon(R.drawable.ic_brightness_6) },
                enabled = state != null,
            ) { dismiss ->
                if (state == null || model == null) return@SettingsPickerRow
                SettingsRadioSheet(
                    appearanceTitle,
                    dismiss,
                    options = UserPreferencesTheme.entries,
                    selected = state.theme,
                    label = ::appearanceLabel,
                    onSelect = model::selectTheme,
                )
            }
            HorizontalDivider()
            SettingsPickerRow(
                colorTitle,
                value = stringResource(paletteLabel(colorTheme)),
                leading = { SettingsIcon(R.drawable.ic_palette) },
                enabled = state != null,
            ) { dismiss ->
                if (state == null || model == null) return@SettingsPickerRow
                PaletteSelectionSheet(
                    colorTitle,
                    dismiss,
                    state.colorTheme,
                    dark,
                    model::selectColorTheme,
                )
            }
        }
    }
    SettingsSection(stringResource(R.string.settings_region)) {
        SettingsGroup {
            val languageTitle = stringResource(R.string.preference_language)
            val locale =
                state?.locale
                    ?: cachedPreferences?.locale
                    ?: run {
                        val deviceLocale =
                            LocaleManagerCompat.getSystemLocales(LocalContext.current)[0]
                        UserPreferencesLocale.valueOf(
                            initialLocale(deviceLocale ?: Locale.ROOT).name,
                        )
                    }
            SettingsPickerRow(
                languageTitle,
                value = stringResource(languageLabel(locale)),
                leading = { SettingsIcon(R.drawable.ic_translate) },
                enabled = state != null && state.supportedLocales.size > 1,
            ) { dismiss ->
                if (state == null || model == null) return@SettingsPickerRow
                SettingsRadioSheet(
                    languageTitle,
                    dismiss,
                    options = state.supportedLocales,
                    selected = state.locale,
                    label = ::languageLabel,
                    onSelect = model::selectLocale,
                )
            }
            HorizontalDivider()
            TimezonePicker(
                state?.timezone
                    ?: cachedPreferences?.timezone
                    ?: remember { initialTimezone() ?: defaultTimezone },
                model?.let { owner -> { owner.selectTimezone(it) } },
            )
        }
        if (model != null && state != null) {
            TimezoneScheduleFeedback(state, model::retry)
        }
    }
}

@Composable
internal fun TimezonePicker(
    current: String?,
    onSelect: ((String) -> Unit)?,
    visible: Boolean = true,
    fallbackFocus: FocusRequester? = null,
) {
    val title = stringResource(R.string.settings_timezone)
    SettingsPickerRow(
        title,
        value = current?.let { timezoneLabel(it) },
        leading = { SettingsIcon(R.drawable.ic_schedule) },
        enabled = current != null && onSelect != null,
        visible = visible,
        fallbackFocus = fallbackFocus,
    ) { dismiss ->
        if (current == null || onSelect == null) return@SettingsPickerRow
        TimezoneSelectionSheet(current, title, dismiss, onSelect)
    }
}

@Composable
internal fun TimezoneSelectionSheet(
    current: String,
    title: String,
    dismiss: () -> Unit,
    onSelect: (String) -> Unit,
) {
    val locale = LocalConfiguration.current.locales[0]
    val utcName = stringResource(R.string.settings_timezone_utc)
    val openingTime = remember { System.currentTimeMillis() }
    val options =
        remember(current, locale, utcName) {
            timezoneOptions(current, locale, utcName, atMillis = openingTime)
        }
    SettingsChoiceSheet(
        title,
        dismiss,
        options,
        options.indexOfFirst { it.id == current },
        { it.id },
    ) { zone, position ->
        SettingsChoiceRow(
            timezoneLabel(zone),
            selected = zone.id == current,
            enabled = true,
            onClick = {
                dismiss()
                onSelect(zone.id)
            },
            modifier = position,
        )
    }
}

@Composable
internal fun memberPreferenceSaveError(
    model: MemberPreferencesModel,
    snackbar: SnackbarHostState,
): PaneFeedbackError? {
    val notice = model.notices.collectAsStateWithLifecycle().value.firstOrNull() ?: return null
    return PaneFeedbackError(notice.order) {
        val message =
            when (notice) {
                is PreferenceSaveNotice.Unconfirmed ->
                    stringResource(R.string.settings_proactive_save_unconfirmed)
                is PreferenceSaveNotice.Rejected ->
                    buildList {
                            if (notice.rolledBack)
                                add(
                                    stringResource(
                                        if (notice.timezoneOnly)
                                            R.string.settings_timezone_save_rejected
                                        else R.string.settings_preferences_save_rolled_back,
                                    ),
                                )
                            if (notice.keptAppearance)
                                add(stringResource(R.string.settings_appearance_sync_failed))
                        }
                        .joinToString(" ")
            }
        PaneFeedbackMessage(snackbar, notice.order, message) { model.dismissNotice(notice.order) }
    }
}

@Composable
internal fun TimezoneScheduleFeedback(
    state: MemberPreferencesState,
    retry: () -> Unit,
    modifier: Modifier = Modifier,
) {
    if (
        state.status != PreferenceStatus.SaveFailed ||
            state.recovering ||
            !state.timezoneScheduleUpdatePending
    )
        return
    val colors = MaterialTheme.colorScheme
    Column(modifier.fillMaxWidth().semantics { liveRegion = LiveRegionMode.Polite }) {
        Text(
            stringResource(R.string.settings_timezone_schedule_update_failed),
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
private fun PaletteSelectionSheet(
    title: String,
    dismiss: () -> Unit,
    selected: UserPreferencesColorTheme,
    dark: Boolean,
    onSelect: (UserPreferencesColorTheme) -> Unit,
) {
    val palettes = UserPreferencesColorTheme.entries
    val scroll = rememberLazyGridState(initialFirstVisibleItemIndex = selected.ordinal)
    SettingsChoicePanel(
        title,
        dismiss,
        initialKey = selected.name,
        isAvailable = { name -> palettes.any { it.name == name } },
    ) { position ->
        BoxWithConstraints(Modifier.fillMaxWidth()) {
            val columns = if (maxWidth < 312.dp || LocalDensity.current.fontScale > 1.3f) 1 else 2
            LazyVerticalGrid(
                columns = GridCells.Fixed(columns),
                modifier = Modifier.fillMaxWidth().selectableGroup(),
                state = scroll,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                items(palettes, key = { it.name }) { palette ->
                    SettingsChoiceRow(
                        stringResource(paletteLabel(palette)),
                        selected = palette == selected,
                        enabled = true,
                        onClick = {
                            dismiss()
                            onSelect(palette)
                        },
                        modifier = position(palette.name),
                        leading = { PaletteSwatch(palette, dark) },
                    )
                }
            }
        }
    }
}

@Composable
private fun PaletteSwatch(palette: UserPreferencesColorTheme, dark: Boolean) {
    val preview = remember(dark, palette) { resolvePalette(palette, dark) }
    Box(
        Modifier.size(24.dp)
            .background(
                Brush.linearGradient(listOf(preview.primary, preview.tertiary)),
                CircleShape,
            ),
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
