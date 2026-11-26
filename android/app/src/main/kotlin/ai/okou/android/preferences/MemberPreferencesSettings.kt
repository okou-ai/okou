package ai.okou.android.preferences

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
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.compose.currentStateAsState
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.flow.collectLatest

@Composable
internal fun MemberPreferencesSettings(
    model: MemberPreferencesModel?,
    cachedAppearance: MemberAppearance? = null,
) {
    val state = model?.uiState?.collectAsStateWithLifecycle()?.value
    if (model != null) {
        val lifecycleState by LocalLifecycleOwner.current.lifecycle.currentStateAsState()
        val active = lifecycleState.isAtLeast(Lifecycle.State.RESUMED)
        DisposableEffect(model, active) {
            model.settingsVisibilityChanged(active)
            onDispose { model.settingsVisibilityChanged(false) }
        }
    }
    val theme = state?.theme ?: cachedAppearance?.theme
    val colorTheme = state?.colorTheme ?: cachedAppearance?.colorTheme
    val systemDark = isSystemInDarkTheme()
    val dark = theme?.resolveDark(systemDark) ?: systemDark
    SettingsSection(stringResource(R.string.settings_appearance_group)) {
        SettingsGroup {
            val appearanceTitle = stringResource(R.string.appearance)
            val colorTitle = stringResource(R.string.preference_color_theme)
            SettingsPickerRow(
                appearanceTitle,
                value = theme?.let { stringResource(appearanceLabel(it)) },
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
                value = colorTheme?.let { stringResource(paletteLabel(it)) },
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
            SettingsPickerRow(
                languageTitle,
                value = state?.let { stringResource(languageLabel(it.locale)) },
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
            TimezonePicker(state?.timezone, model?.let { owner -> { owner.selectTimezone(it) } })
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
internal fun MemberPreferenceSaveFeedback(
    model: MemberPreferencesModel,
    snackbar: SnackbarHostState,
) {
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val timezone by rememberUpdatedState(stringResource(R.string.settings_timezone_save_rejected))
    val rolledBack by
        rememberUpdatedState(stringResource(R.string.settings_preferences_save_rolled_back))
    val appearance by rememberUpdatedState(stringResource(R.string.settings_appearance_sync_failed))
    val unconfirmed by
        rememberUpdatedState(stringResource(R.string.settings_proactive_save_unconfirmed))
    LaunchedEffect(model, snackbar, lifecycle) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            model.notices.collectLatest { notice ->
                val message =
                    when (notice) {
                        null -> return@collectLatest
                        is PreferenceSaveNotice.Unconfirmed -> unconfirmed
                        is PreferenceSaveNotice.Rejected ->
                            buildList {
                                    if (notice.rolledBack)
                                        add(if (notice.timezoneOnly) timezone else rolledBack)
                                    if (notice.keptAppearance) add(appearance)
                                }
                                .joinToString(" ")
                    }
                snackbar.showSnackbar(message, duration = SnackbarDuration.Indefinite)
                model.dismissNotice(notice)
            }
        }
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
