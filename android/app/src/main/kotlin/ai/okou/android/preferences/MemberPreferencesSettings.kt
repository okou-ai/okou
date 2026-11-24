package ai.okou.android.preferences

import ai.okou.android.R
import ai.okou.android.SettingsChoiceRow
import ai.okou.android.SettingsGroup
import ai.okou.android.SettingsIcon
import ai.okou.android.SettingsPickerRow
import ai.okou.android.SettingsRadioOptions
import ai.okou.android.SettingsSection
import ai.okou.android.SettingsSheet
import ai.okou.android.SettingsSheetDescription
import ai.okou.android.SettingsSheetScroll
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
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
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
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.input.InputMode
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalInputModeManager
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
                value = colorTheme?.let { stringResource(paletteLabel(it)) },
                leading = { SettingsIcon(R.drawable.ic_palette) },
                enabled = state != null,
            ) { dismiss ->
                if (state == null || model == null) return@SettingsPickerRow
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
                value = state?.let { stringResource(languageLabel(it.locale)) },
                leading = { SettingsIcon(R.drawable.ic_translate) },
                enabled = state != null && state.supportedLocales.size > 1,
            ) { dismiss ->
                if (state == null || model == null) return@SettingsPickerRow
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
            TimezonePicker(state?.timezone, model?.let { owner -> { owner.selectTimezone(it) } })
        }
        if (model != null && state != null && state.pending?.cloudBrowser == null) {
            PreferenceFeedback(state, model::retry)
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
        SettingsSheet(title, dismiss, scroll = SettingsSheetScroll.None) {
            SettingsSheetDescription(stringResource(R.string.settings_timezone_hint))
            val locale = LocalConfiguration.current.locales[0]
            val utcName = stringResource(R.string.settings_timezone_utc)
            val options =
                remember(current, locale, utcName) { timezoneOptions(current, locale, utcName) }
            val initialZone = remember { current }
            val list =
                rememberLazyListState(
                    initialFirstVisibleItemIndex = options.indexOfFirst { it.id == current },
                )
            val focus = remember { FocusRequester() }
            val input = LocalInputModeManager.current
            var positioned by remember { mutableStateOf(false) }
            LaunchedEffect(positioned) {
                if (positioned && input.inputMode == InputMode.Keyboard) focus.requestFocus()
            }
            LazyColumn(Modifier.fillMaxWidth().selectableGroup(), state = list) {
                items(options, key = { it.id }) { zone ->
                    SettingsChoiceRow(
                        timezoneLabel(zone),
                        selected = zone.id == current,
                        enabled = true,
                        onClick = {
                            dismiss()
                            onSelect(zone.id)
                        },
                        modifier =
                            if (zone.id == initialZone)
                                Modifier.focusRequester(focus).onGloballyPositioned {
                                    positioned = true
                                }
                            else Modifier,
                    )
                }
            }
        }
    }
}

@Composable
internal fun TimezoneSaveFeedback(model: MemberPreferencesModel, snackbar: SnackbarHostState) {
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val message by rememberUpdatedState(stringResource(R.string.settings_timezone_save_rejected))
    LaunchedEffect(model, snackbar, lifecycle) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            model.timezoneNotices.collectLatest { notice ->
                if (notice == TimezoneSaveNotice.Rejected) {
                    snackbar.showSnackbar(message, duration = SnackbarDuration.Indefinite)
                }
            }
        }
    }
}

@Composable
internal fun PreferenceFeedback(
    state: MemberPreferencesState,
    retry: () -> Unit,
    modifier: Modifier = Modifier,
) {
    if (state.recovering) return
    val message =
        when (state.status) {
            PreferenceStatus.Ready,
            PreferenceStatus.Saving,
            PreferenceStatus.Refreshing -> return
            PreferenceStatus.SaveFailed ->
                when {
                    state.timezoneScheduleUpdatePending ->
                        R.string.settings_timezone_schedule_update_failed
                    state.pending?.timezone != null -> R.string.settings_proactive_save_unconfirmed
                    else -> R.string.preference_save_failed
                }
            PreferenceStatus.RefreshFailed -> R.string.preference_refresh_failed
        }
    val colors = MaterialTheme.colorScheme
    val textColor =
        if (message == R.string.settings_proactive_save_unconfirmed) colors.onSurfaceVariant
        else colors.error
    Column(modifier.fillMaxWidth().semantics { liveRegion = LiveRegionMode.Polite }) {
        Text(
            stringResource(message),
            color = textColor,
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
