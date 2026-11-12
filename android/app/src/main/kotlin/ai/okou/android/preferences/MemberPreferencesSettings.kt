package ai.okou.android.preferences

import ai.okou.android.R
import ai.okou.android.api.generated.UserPreferencesColorTheme
import ai.okou.android.api.generated.UserPreferencesLocale
import ai.okou.android.resolvePalette
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.sizeIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.RadioButton
import androidx.compose.material3.RadioButtonDefaults
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle

@Composable
fun MemberPreferencesSettings(model: MemberPreferencesModel) {
    val state by model.uiState.collectAsStateWithLifecycle()
    val foreground = MaterialTheme.colorScheme.onSurface
    val textButtonColors = ButtonDefaults.textButtonColors(contentColor = foreground)
    val radioButtonColors = RadioButtonDefaults.colors(selectedColor = foreground)
    var choosingPalette by remember { mutableStateOf(false) }
    var choosingLanguage by remember { mutableStateOf(false) }
    HorizontalDivider()
    Text(
        stringResource(R.string.preferences_title),
        style = MaterialTheme.typography.titleLarge,
        modifier = Modifier.semantics { heading() },
    )
    Text(
        stringResource(R.string.preferences_description),
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
    Text(
        stringResource(R.string.preference_color_theme),
        style = MaterialTheme.typography.titleMedium,
    )
    OutlinedButton(
        onClick = { choosingPalette = true },
        enabled = !state.busy,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Text(stringResource(paletteLabel(state.colorTheme)))
    }
    Text(stringResource(R.string.preference_language), style = MaterialTheme.typography.titleMedium)
    OutlinedButton(
        onClick = { choosingLanguage = true },
        enabled = !state.busy && state.supportedLocales.size > 1,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Text(stringResource(languageLabel(state.locale)))
    }
    Text(stringResource(R.string.preference_timezone), style = MaterialTheme.typography.titleMedium)
    Text(checkNotNull(state.confirmed.timezone), color = MaterialTheme.colorScheme.onSurfaceVariant)
    val message =
        when (state.status) {
            PreferenceStatus.Ready -> null
            PreferenceStatus.Saving -> R.string.preference_saving
            PreferenceStatus.Refreshing -> R.string.preference_loading
            PreferenceStatus.SaveFailed -> R.string.preference_save_failed
            PreferenceStatus.RefreshFailed -> R.string.preference_refresh_failed
        }
    if (message != null) {
        Column(Modifier.fillMaxWidth().semantics { liveRegion = LiveRegionMode.Polite }) {
            if (state.busy) LinearProgressIndicator(Modifier.fillMaxWidth(), color = foreground)
            Text(
                stringResource(message),
                color =
                    if (state.busy) MaterialTheme.colorScheme.onSurfaceVariant
                    else MaterialTheme.colorScheme.error,
            )
            if (!state.busy)
                TextButton(onClick = model::retry, colors = textButtonColors) {
                    Text(stringResource(R.string.retry))
                }
        }
    }
    TextButton(onClick = model::refresh, enabled = !state.busy, colors = textButtonColors) {
        Text(stringResource(R.string.preference_refresh))
    }
    if (choosingPalette) {
        AlertDialog(
            onDismissRequest = { choosingPalette = false },
            title = { Text(stringResource(R.string.preference_color_theme)) },
            text = {
                Column(
                    Modifier.heightIn(max = 420.dp)
                        .verticalScroll(rememberScrollState())
                        .selectableGroup()
                ) {
                    UserPreferencesColorTheme.entries.forEach { palette ->
                        Row(
                            Modifier.fillMaxWidth()
                                .sizeIn(minHeight = 56.dp)
                                .selectable(
                                    selected = state.colorTheme == palette,
                                    enabled = !state.busy,
                                    role = Role.RadioButton,
                                    onClick = {
                                        model.selectColorTheme(palette)
                                        choosingPalette = false
                                    },
                                )
                                .padding(vertical = 8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(12.dp),
                        ) {
                            PaletteSwatch(palette)
                            Text(stringResource(paletteLabel(palette)), Modifier.weight(1f))
                            RadioButton(
                                selected = state.colorTheme == palette,
                                onClick = null,
                                enabled = !state.busy,
                                colors = radioButtonColors,
                            )
                        }
                    }
                }
            },
            confirmButton = {
                TextButton(onClick = { choosingPalette = false }, colors = textButtonColors) {
                    Text(stringResource(R.string.back))
                }
            },
        )
    }
    if (choosingLanguage) {
        AlertDialog(
            onDismissRequest = { choosingLanguage = false },
            title = { Text(stringResource(R.string.preference_language)) },
            text = {
                Column(
                    Modifier.heightIn(max = 420.dp)
                        .verticalScroll(rememberScrollState())
                        .selectableGroup()
                ) {
                    state.supportedLocales.forEach { locale ->
                        Row(
                            Modifier.fillMaxWidth()
                                .sizeIn(minHeight = 56.dp)
                                .selectable(
                                    selected = state.locale == locale,
                                    enabled = !state.busy,
                                    role = Role.RadioButton,
                                    onClick = {
                                        model.selectLocale(locale)
                                        choosingLanguage = false
                                    },
                                )
                                .padding(vertical = 8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(stringResource(languageLabel(locale)), Modifier.weight(1f))
                            RadioButton(
                                selected = state.locale == locale,
                                onClick = null,
                                enabled = !state.busy,
                                colors = radioButtonColors,
                            )
                        }
                    }
                }
            },
            confirmButton = {
                TextButton(onClick = { choosingLanguage = false }, colors = textButtonColors) {
                    Text(stringResource(R.string.back))
                }
            },
        )
    }
}

@Composable
private fun PaletteSwatch(palette: UserPreferencesColorTheme) {
    val context = LocalContext.current
    val configuration = LocalConfiguration.current
    val dark = MaterialTheme.colorScheme.background.luminance() < 0.5f
    val colors =
        remember(context, configuration, dark, palette) {
            resolvePalette(context, dark, palette).scheme
        }
    Surface(
        Modifier.size(24.dp),
        shape = CircleShape,
        color = colors.primary,
        border = BorderStroke(1.dp, colors.outline),
    ) {}
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
