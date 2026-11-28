package ai.okou.android.settings

import ai.okou.android.R
import ai.okou.android.SettingsChoiceRow
import ai.okou.android.SettingsGroup
import ai.okou.android.SettingsIcon
import ai.okou.android.SettingsRow
import ai.okou.android.SettingsSheet
import ai.okou.android.SettingsSheetDescription
import ai.okou.android.SettingsSwitchRow
import ai.okou.android.SettingsTrigger
import ai.okou.android.preferences.MemberPreferencesModel
import ai.okou.android.preferences.TimezonePicker
import ai.okou.android.preferences.TimezoneScheduleFeedback
import ai.okou.android.rememberContentReadSkeleton
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.compose.currentStateAsState
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.flow.map

@Composable
internal fun ProactiveSettingsPage(
    workspace: String,
    model: ProactiveSettingsModel,
    preferences: MemberPreferencesModel,
) {
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val lifecycleState by lifecycle.currentStateAsState()
    val active = lifecycleState.isAtLeast(Lifecycle.State.RESUMED)
    DisposableEffect(model, active) {
        model.visible(active)
        onDispose { model.visible(false) }
    }
    LaunchedEffect(preferences, model) {
        preferences.uiState
            .map { it.timezoneConfirmation }
            .distinctUntilChanged()
            .drop(1)
            .collect { model.refresh() }
    }

    val morning by model.morningBrief.state.collectAsStateWithLifecycle()
    val suggestions by model.suggestions.state.collectAsStateWithLifecycle()
    val morningNeedsTimezone = morning.confirmed?.needsTimezone == true
    val needsTimezone = morningNeedsTimezone || suggestions.confirmed?.needsTimezone == true
    val relatedFocus = remember { FocusRequester() }
    var timezoneSetting by remember { mutableStateOf(ProactiveSetting.MorningBrief) }
    // Keep the last related row as the settings refresh and the timezone entry disappears.
    SideEffect {
        if (needsTimezone) {
            timezoneSetting =
                if (morningNeedsTimezone) ProactiveSetting.MorningBrief
                else ProactiveSetting.Suggestions
        }
    }
    val showSuggestions =
        !suggestions.hidden && (suggestions.confirmed != null || suggestions.loading)
    val morningFocusable = morning.canChoose && !morningNeedsTimezone
    val suggestionsFocusable = showSuggestions && suggestions.canChoose
    val focusTarget =
        when {
            timezoneSetting == ProactiveSetting.Suggestions && suggestionsFocusable ->
                ProactiveSetting.Suggestions
            morningFocusable -> ProactiveSetting.MorningBrief
            suggestionsFocusable -> ProactiveSetting.Suggestions
            else -> null
        }
    fun focusFor(setting: ProactiveSetting) =
        if (focusTarget == setting) Modifier.focusRequester(relatedFocus) else Modifier
    val current by preferences.uiState.collectAsStateWithLifecycle()
    val canSelect = needsTimezone && current.pending?.timezoneToWrite == null
    val select: (String) -> Unit = { preferences.selectTimezone(it, missingOnServer = true) }
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        ProactiveDetail(stringResource(R.string.settings_proactive_scope, workspace))
        SettingsGroup {
            if (morning.loading) ProactiveSettingPlaceholder()
            else
                MorningBriefRow(
                    morning,
                    model.morningBrief::choose,
                    focusFor(ProactiveSetting.MorningBrief),
                )
            if (showSuggestions) {
                HorizontalDivider()
                if (suggestions.loading) ProactiveSettingPlaceholder()
                else {
                    SuggestionsRow(
                        suggestions,
                        model.suggestions::choose,
                        focusFor(ProactiveSetting.Suggestions),
                    )
                }
            }
            if (needsTimezone) HorizontalDivider()
            TimezonePicker(
                current.timezone.takeIf { needsTimezone },
                select.takeIf { canSelect },
                visible = needsTimezone,
                fallbackFocus = relatedFocus.takeIf { focusTarget != null },
            )
            if (needsTimezone || current.timezoneScheduleUpdatePending) {
                TimezoneScheduleFeedback(
                    current,
                    preferences::retry,
                    Modifier.padding(start = 16.dp, top = 8.dp, end = 16.dp),
                )
            }
        }
        if (suggestions.readFailed && suggestions.confirmed == null) {
            ProactiveDetail(stringResource(R.string.settings_proactive_read_failed))
        }
    }
}

private val ProactiveSettingState.loading: Boolean
    get() = confirmed == null && !readFailed

@Composable
private fun MorningBriefRow(
    state: ProactiveSettingState,
    select: (Boolean) -> Unit,
    modifier: Modifier,
) {
    SettingsSwitchRow(
        stringResource(R.string.settings_morning_brief),
        leading = { SettingsIcon(R.drawable.ic_wb_twilight) },
        checked = state.enabled,
        onCheckedChange =
            select.takeIf { state.canChoose && state.confirmed?.needsTimezone == false },
        modifier = modifier.semantics { liveRegion = LiveRegionMode.Polite },
        supportingText = stringResource(state.detail(R.string.settings_morning_brief_detail)),
    )
}

@Composable
private fun SuggestionsRow(
    state: ProactiveSettingState,
    select: (Boolean) -> Unit,
    modifier: Modifier,
) {
    val title = stringResource(R.string.settings_suggestions)
    val partial = state.confirmed?.takeIf { it.partial && state.pending == null }
    SettingsTrigger(
        content = { dismiss ->
            SettingsSheet(title, dismiss) {
                val note =
                    when (partial?.enabled) {
                        true -> R.string.settings_suggestions_hourly_only
                        false -> R.string.settings_suggestions_cards_only
                        null -> R.string.settings_suggestions_detail
                    }
                SettingsSheetDescription(stringResource(note))
                val first = remember { FocusRequester() }
                Column(Modifier.fillMaxWidth().selectableGroup()) {
                    SettingsChoiceRow(
                        stringResource(R.string.settings_suggestions_enable_both),
                        selected = partial == null && state.enabled == true,
                        enabled = state.canChoose,
                        onClick = {
                            dismiss()
                            select(true)
                        },
                        modifier = Modifier.focusRequester(first),
                    )
                    SettingsChoiceRow(
                        stringResource(R.string.settings_suggestions_disable_both),
                        selected = partial == null && state.enabled == false,
                        enabled = state.canChoose,
                        onClick = {
                            dismiss()
                            select(false)
                        },
                    )
                }
                LaunchedEffect(first) { first.requestFocus() }
            }
        },
    ) { triggerModifier, open ->
        if (partial != null) {
            SettingsRow(
                title,
                leading = { SettingsIcon(R.drawable.ic_lightbulb) },
                modifier = modifier.then(triggerModifier),
                value = stringResource(R.string.settings_suggestions_partial),
                enabled = state.canChoose,
                onClick = open,
            )
        } else {
            SettingsSwitchRow(
                title,
                leading = { SettingsIcon(R.drawable.ic_lightbulb) },
                checked = state.enabled,
                onCheckedChange = select.takeIf { state.canChoose },
                modifier =
                    modifier.then(triggerModifier).semantics { liveRegion = LiveRegionMode.Polite },
                supportingText = stringResource(state.detail(R.string.settings_suggestions_detail)),
            )
        }
    }
}

private fun ProactiveSettingState.detail(default: Int): Int =
    when {
        pending != null -> R.string.settings_saving
        confirmed?.needsTimezone == true -> R.string.settings_proactive_needs_timezone
        readFailed && confirmed == null -> R.string.settings_proactive_read_failed
        readFailed -> R.string.settings_proactive_refresh_failed
        else ->
            when (confirmed?.status) {
                ProactiveStatus.Preparing -> R.string.settings_proactive_preparing
                ProactiveStatus.Error -> R.string.settings_proactive_schedule_failed
                ProactiveStatus.Paused,
                ProactiveStatus.Enabled,
                null -> default
            }
    }

@Composable
private fun ProactiveDetail(text: String) {
    Text(
        text,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        style = MaterialTheme.typography.bodyMedium,
    )
}

@Composable
private fun ProactiveSettingPlaceholder() {
    val visible = rememberContentReadSkeleton()
    val label = stringResource(R.string.settings_proactive_loading)
    Row(
        Modifier.fillMaxWidth()
            .height(72.dp)
            .alpha(if (visible) 1f else 0f)
            .padding(horizontal = 16.dp)
            .semantics {
                if (visible) {
                    contentDescription = label
                    liveRegion = LiveRegionMode.Polite
                }
            },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        PlaceholderBlock(Modifier.width(20.dp).height(20.dp))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            PlaceholderBlock(Modifier.width(96.dp).height(16.dp))
            PlaceholderBlock(Modifier.width(164.dp).height(12.dp))
        }
        PlaceholderBlock(Modifier.width(52.dp).height(32.dp), radius = 16)
    }
}

@Composable
private fun PlaceholderBlock(modifier: Modifier, radius: Int = 4) {
    Box(
        modifier.background(
            MaterialTheme.colorScheme.surfaceVariant,
            RoundedCornerShape(radius.dp),
        ),
    )
}
