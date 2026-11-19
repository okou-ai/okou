package ai.okou.android.preferences

import ai.okou.android.R
import ai.okou.android.SettingsGroup
import ai.okou.android.SettingsIcon
import ai.okou.android.SettingsPickerRow
import ai.okou.android.SettingsRadioOptions
import ai.okou.android.SettingsRow
import ai.okou.android.SettingsSection
import ai.okou.android.SettingsSheet
import ai.okou.android.api.generated.UserPreferencesColorTheme
import ai.okou.android.api.generated.UserPreferencesLocale
import ai.okou.android.resolvePalette
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle

@Composable
internal fun MemberPreferencesSettings(model: MemberPreferencesModel, dark: Boolean) {
    val state by model.uiState.collectAsStateWithLifecycle()
    SettingsSection(stringResource(R.string.preferences_title)) {
        SettingsGroup {
            val themeTitle = stringResource(R.string.preference_color_theme)
            val languageTitle = stringResource(R.string.preference_language)
            SettingsPickerRow(
                themeTitle,
                value = stringResource(paletteLabel(state.colorTheme)),
                leading = {
                    val colors = MaterialTheme.colorScheme
                    Surface(
                        Modifier.size(20.dp),
                        shape = CircleShape,
                        color = colors.primary,
                        border = BorderStroke(1.dp, colors.outline),
                    ) {}
                },
                enabled = !state.busy,
            ) { dismiss ->
                SettingsSheet(themeTitle, dismiss) {
                    Text(
                        stringResource(R.string.preference_color_theme_description),
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        style = MaterialTheme.typography.bodyMedium,
                    )
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
                leading = { SettingsIcon(R.drawable.ic_settings_language) },
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
            HorizontalDivider()
            SettingsRow(
                stringResource(R.string.preference_timezone),
                leading = { SettingsIcon(R.drawable.ic_settings_time_zone) },
                value = checkNotNull(state.confirmed.timezone),
            )
        }
        Text(
            stringResource(R.string.preferences_description),
            Modifier.padding(horizontal = 8.dp),
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            style = MaterialTheme.typography.bodySmall,
        )
        PreferenceFeedback(state, model::retry)
        TextButton(
            onClick = model::refresh,
            enabled = !state.busy,
            colors =
                ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.onSurface),
        ) {
            Text(stringResource(R.string.preference_refresh))
        }
    }
}

@Composable
private fun PreferenceFeedback(state: MemberPreferencesState, retry: () -> Unit) {
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
        if (!state.busy)
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
    enabled: Boolean,
    onSelect: (UserPreferencesColorTheme) -> Unit,
) {
    val context = LocalContext.current
    val configuration = LocalConfiguration.current
    val colors = MaterialTheme.colorScheme
    val shape = RoundedCornerShape(12.dp)
    FlowRow(
        Modifier.fillMaxWidth().selectableGroup(),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
        maxItemsInEachRow = 2,
    ) {
        UserPreferencesColorTheme.entries.forEach { palette ->
            val checked = palette == selected
            val preview =
                remember(context, configuration, dark, palette) {
                    resolvePalette(context, dark, palette).scheme
                }
            Surface(
                modifier =
                    Modifier.weight(1f)
                        .clip(shape)
                        .selectable(
                            selected = checked,
                            enabled = enabled,
                            role = Role.RadioButton,
                            onClick = { onSelect(palette) },
                        ),
                shape = shape,
                color = colors.background,
                border =
                    if (checked) BorderStroke(2.dp, colors.onSurface)
                    else BorderStroke(1.dp, colors.outlineVariant),
            ) {
                Column(Modifier.padding(6.dp)) {
                    PalettePreview(preview)
                    Row(
                        Modifier.fillMaxWidth()
                            .padding(start = 4.dp, end = 4.dp, top = 8.dp, bottom = 6.dp),
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            stringResource(paletteLabel(palette)),
                            Modifier.weight(1f),
                            style = MaterialTheme.typography.bodyMedium,
                        )
                        if (checked)
                            Icon(
                                painterResource(R.drawable.ic_settings_check),
                                contentDescription = null,
                                modifier = Modifier.size(16.dp),
                            )
                    }
                }
            }
        }
    }
}

@Composable
private fun PalettePreview(colors: ColorScheme) {
    Surface(
        Modifier.fillMaxWidth().height(52.dp).clearAndSetSemantics {},
        shape = RoundedCornerShape(8.dp),
        color = colors.background,
        contentColor = colors.onBackground,
        border = BorderStroke(1.dp, colors.outlineVariant),
    ) {
        Column(
            Modifier.padding(6.dp),
            verticalArrangement = Arrangement.spacedBy(3.dp, Alignment.CenterVertically),
        ) {
            Row(
                horizontalArrangement = Arrangement.spacedBy(4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Box(Modifier.size(6.dp).background(colors.primary, CircleShape))
                Text(
                    stringResource(R.string.app_name),
                    fontSize = 8.sp,
                    lineHeight = 9.sp,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 1,
                )
            }
            Box(
                Modifier.fillMaxWidth(0.55f)
                    .height(3.dp)
                    .background(colors.onBackground.copy(alpha = 0.18f), CircleShape)
            )
            Box(
                Modifier.fillMaxWidth()
                    .height(12.dp)
                    .border(1.dp, colors.outlineVariant, CircleShape)
                    .padding(horizontal = 2.dp),
                contentAlignment = Alignment.CenterEnd,
            ) {
                Icon(
                    painterResource(R.drawable.ic_settings_send),
                    contentDescription = null,
                    modifier =
                        Modifier.size(8.dp).background(colors.primary, CircleShape).padding(1.dp),
                    tint = colors.onPrimary,
                )
            }
        }
    }
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
