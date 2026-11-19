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
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle

@Composable
internal fun MemberPreferencesSettings(model: MemberPreferencesModel) {
    val state by model.uiState.collectAsStateWithLifecycle()
    val dark = state.theme.resolveDark(isSystemInDarkTheme())
    SettingsSection(stringResource(R.string.preferences_title)) {
        SettingsGroup {
            val appearanceTitle = stringResource(R.string.appearance)
            val colorTitle = stringResource(R.string.preference_color_theme)
            val languageTitle = stringResource(R.string.preference_language)
            SettingsPickerRow(
                appearanceTitle,
                value = stringResource(appearanceLabel(state.theme)),
                leading = { SettingsIcon(R.drawable.ic_brightness_6) },
                enabled = !state.busy,
            ) { dismiss ->
                SettingsSheet(appearanceTitle, dismiss) {
                    SettingsRadioOptions(
                        options = UserPreferencesTheme.entries,
                        selected = state.theme,
                        label = ::appearanceLabel,
                        enabled = !state.busy,
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
                leading = { PaletteSwatch(MaterialTheme.colorScheme) },
                enabled = !state.busy,
            ) { dismiss ->
                SettingsSheet(colorTitle, dismiss) {
                    PaletteOptions(state.colorTheme, dark, !state.busy) { palette ->
                        dismiss()
                        model.selectColorTheme(palette)
                    }
                }
            }
            HorizontalDivider()
            SettingsPickerRow(
                languageTitle,
                value = stringResource(languageLabel(state.locale)),
                leading = { SettingsIcon(R.drawable.ic_translate) },
                enabled = !state.busy && state.supportedLocales.size > 1,
            ) { dismiss ->
                SettingsSheet(languageTitle, dismiss) {
                    SettingsRadioOptions(
                        options = state.supportedLocales,
                        selected = state.locale,
                        label = ::languageLabel,
                        enabled = !state.busy,
                    ) { locale ->
                        dismiss()
                        model.selectLocale(locale)
                    }
                }
            }
        }
        PreferenceFeedback(state, model::retry, model::refresh)
    }
}

@Composable
private fun PreferenceFeedback(
    state: MemberPreferencesState,
    retry: () -> Unit,
    refresh: () -> Unit,
) {
    val message =
        when (state.status) {
            PreferenceStatus.Ready -> return
            PreferenceStatus.Saving -> R.string.preference_saving
            PreferenceStatus.Refreshing -> R.string.preference_loading
            PreferenceStatus.SaveFailed -> R.string.preference_save_failed
            PreferenceStatus.RefreshFailed -> R.string.preference_refresh_failed
        }
    val colors = MaterialTheme.colorScheme
    Column(Modifier.fillMaxWidth().semantics { liveRegion = LiveRegionMode.Polite }) {
        if (state.busy) LinearProgressIndicator(Modifier.fillMaxWidth(), color = colors.onSurface)
        Text(
            stringResource(message),
            color = if (state.busy) colors.onSurfaceVariant else colors.error,
        )
        if (!state.busy) {
            val buttonColors = ButtonDefaults.textButtonColors(contentColor = colors.onSurface)
            TextButton(onClick = retry, colors = buttonColors) {
                Text(stringResource(R.string.retry))
            }
            if (state.status == PreferenceStatus.SaveFailed)
                TextButton(onClick = refresh, colors = buttonColors) {
                    Text(stringResource(R.string.preference_refresh))
                }
        }
    }
}

@Composable
private fun PaletteOptions(
    selected: UserPreferencesColorTheme,
    dark: Boolean,
    enabled: Boolean,
    onSelect: (UserPreferencesColorTheme) -> Unit,
) {
    val context = LocalContext.current
    val configuration = LocalConfiguration.current
    Column(
        Modifier.fillMaxWidth().selectableGroup(),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        UserPreferencesColorTheme.entries.chunked(2).forEach { choices ->
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                choices.forEach { palette ->
                    val preview =
                        remember(context, configuration, dark, palette) {
                            resolvePalette(context, dark, palette).scheme
                        }
                    SettingsChoiceRow(
                        stringResource(paletteLabel(palette)),
                        selected = palette == selected,
                        enabled = enabled,
                        onClick = { onSelect(palette) },
                        modifier = Modifier.weight(1f),
                        leading = { PaletteSwatch(preview) },
                    )
                }
            }
        }
    }
}

@Composable
private fun PaletteSwatch(colors: ColorScheme) {
    Box(
        Modifier.size(20.dp)
            .background(
                Brush.linearGradient(listOf(colors.primary, colors.primaryContainer)),
                CircleShape,
            )
            .border(1.dp, colors.outlineVariant, CircleShape)
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
