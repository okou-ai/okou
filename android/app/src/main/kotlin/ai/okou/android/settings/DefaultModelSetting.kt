package ai.okou.android.settings

import ai.okou.android.LocalActivityStatusColor
import ai.okou.android.R
import ai.okou.android.SettingsIcon
import ai.okou.android.SettingsModal
import ai.okou.android.SettingsRow
import ai.okou.android.SettingsSwitchRow
import ai.okou.android.SettingsTrigger
import ai.okou.android.currentWindowSizeDp
import ai.okou.android.updates.updateFocusOutline
import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.relocation.BringIntoViewRequester
import androidx.compose.foundation.relocation.bringIntoViewRequester
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedCard
import androidx.compose.material3.RadioButton
import androidx.compose.material3.RadioButtonDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.input.InputMode
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalInputModeManager
import androidx.compose.ui.platform.LocalLocale
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.compose.currentStateAsState
import java.text.NumberFormat

@Composable
internal fun DefaultModelSetting(model: DefaultModelSettings?) {
    val title = stringResource(R.string.settings_default_model)
    if (model == null) {
        DefaultModelLoadingRow(title)
        return
    }
    val state by model.state.collectAsStateWithLifecycle()
    val lifecycle by LocalLifecycleOwner.current.lifecycle.currentStateAsState()
    val active = lifecycle.isAtLeast(Lifecycle.State.RESUMED)
    DisposableEffect(model, active) {
        model.visible(active)
        onDispose { model.visible(false) }
    }
    if (state.options == null && !state.offline && !state.failed) {
        DefaultModelLoadingRow(title)
        return
    }
    val choices = state.options?.choices.orEmpty()
    if (choices.none { it.canSelect } && state.selected == null) return
    SettingsTrigger(content = { dismiss -> DefaultModelSheet(title, state, model, dismiss) }) {
        modifier,
        open ->
        SettingsRow(
            title,
            leading = { SettingsIcon(R.drawable.ic_memory) },
            modifier = modifier,
            value = state.selected?.label ?: stringResource(R.string.settings_auto_model),
            onClick = open,
        )
    }
    HorizontalDivider()
}

@Composable
private fun DefaultModelLoadingRow(title: String) {
    SettingsRow(
        title,
        leading = { SettingsIcon(R.drawable.ic_memory) },
        value = "",
        valueLeading = {
            Box(
                Modifier.width(64.dp)
                    .height(12.dp)
                    .background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(4.dp))
            )
        },
    )
    HorizontalDivider()
}

@Composable
private fun DefaultModelSheet(
    title: String,
    state: DefaultModelState,
    model: DefaultModelSettings,
    dismiss: () -> Unit,
) {
    val windowHeight = currentWindowSizeDp().height
    val fullScreen = windowHeight < 480
    val scroll = rememberScrollState()
    val size =
        if (fullScreen) Modifier.fillMaxHeight()
        else Modifier.heightIn(max = windowHeight.dp * 0.86f).animateContentSize()
    SettingsModal(dismiss, fullScreen = fullScreen) { centered ->
        val initialModel = remember { state.selected?.takeIf { it.canSelect }?.id }
        val reveal = remember { BringIntoViewRequester() }
        val focus = remember { FocusRequester() }
        val inputMode = LocalInputModeManager.current
        var positioned by remember { mutableStateOf(false) }
        val initialRow =
            Modifier.focusRequester(focus).bringIntoViewRequester(reveal).onGloballyPositioned {
                positioned = true
            }
        LaunchedEffect(positioned) {
            if (positioned) {
                if (inputMode.inputMode == InputMode.Keyboard) focus.requestFocus()
                reveal.bringIntoView()
            }
        }
        Column(
            Modifier.fillMaxWidth()
                .then(size)
                .padding(
                    start = 16.dp,
                    end = 16.dp,
                    top = if (centered) 16.dp else 0.dp,
                    bottom = 16.dp,
                )
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = dismiss) {
                    androidx.compose.material3.Icon(
                        androidx.compose.ui.res.painterResource(R.drawable.ic_arrow_back),
                        stringResource(R.string.back),
                    )
                }
                Text(
                    title,
                    Modifier.semantics { heading() },
                    style =
                        MaterialTheme.typography.titleLarge.copy(
                            fontSize = 22.sp,
                            lineHeight = 28.sp,
                            fontWeight = FontWeight.SemiBold,
                        ),
                )
            }
            Column(
                Modifier.weight(1f, fill = false).verticalScroll(scroll),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                val status =
                    when {
                        state.offline -> R.string.settings_model_offline
                        state.failed -> R.string.settings_model_save_unavailable
                        else -> null
                    }
                if (status != null)
                    Text(
                        stringResource(status),
                        Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                val choices = state.options?.choices.orEmpty()
                Column(Modifier.fillMaxWidth().selectableGroup()) {
                    ModelOption(
                        stringResource(R.string.settings_auto_model),
                        selected = state.selected == null,
                        enabled = true,
                        supportingText = stringResource(R.string.settings_auto_model_detail),
                        modifier = if (initialModel == null) initialRow else Modifier,
                        onClick = { model.select(null) },
                    )
                    for (choice in choices) {
                        ModelOption(
                            choice.label,
                            selected = choice == state.selected,
                            enabled = choice.canSelect,
                            supportingText =
                                if (choice.canSelect) null
                                else stringResource(R.string.settings_model_plan_restricted),
                            modifier = if (choice.id == initialModel) initialRow else Modifier,
                            onClick = { model.select(choice.id) },
                        )
                    }
                }
                state.selected
                    ?.takeIf {
                        it.canSelect && (it.efforts.isNotEmpty() || it.fastMultiplier != null)
                    }
                    ?.let { choice ->
                        HorizontalDivider()
                        Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
                            if (choice.efforts.isNotEmpty()) {
                                EffortMenu(choice.efforts, state.effort, model::effort)
                            }
                            choice.fastMultiplier?.let { multiplier ->
                                val value =
                                    NumberFormat.getNumberInstance(
                                            LocalLocale.current.platformLocale
                                        )
                                        .format(multiplier)
                                SettingsSwitchRow(
                                    stringResource(R.string.settings_model_fast),
                                    leading = {},
                                    checked = state.fast,
                                    onCheckedChange = model::fast,
                                    supportingText =
                                        stringResource(R.string.settings_model_fast_usage, value),
                                )
                            }
                        }
                    }
            }
        }
    }
}

@Composable
private fun ModelOption(
    title: String,
    selected: Boolean,
    enabled: Boolean,
    supportingText: String?,
    modifier: Modifier,
    onClick: () -> Unit,
) {
    val colors = MaterialTheme.colorScheme
    val shape = RoundedCornerShape(12.dp)
    val focusColor = LocalActivityStatusColor.current
    val disabledColor = colors.onSurface.copy(alpha = 0.38f)
    val foreground = if (selected) colors.onSecondaryContainer else colors.onSurface
    Row(
        modifier
            .fillMaxWidth()
            .heightIn(min = if (supportingText == null) 56.dp else 72.dp)
            .clip(shape)
            .updateFocusOutline(shape, focusColor)
            .then(if (selected) Modifier.background(colors.secondaryContainer) else Modifier)
            .selectable(selected, enabled = enabled, role = Role.RadioButton, onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Column(Modifier.weight(1f)) {
            Text(
                title,
                color = if (enabled) foreground else foreground.copy(alpha = 0.38f),
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
            )
            supportingText?.let {
                Text(
                    it,
                    style = MaterialTheme.typography.bodyMedium,
                    color = colors.onSurfaceVariant,
                )
            }
        }
        RadioButton(
            selected,
            onClick = null,
            enabled = enabled,
            colors =
                RadioButtonDefaults.colors(
                    selectedColor = focusColor,
                    unselectedColor = colors.onSurfaceVariant,
                    disabledSelectedColor = disabledColor,
                    disabledUnselectedColor = disabledColor,
                ),
        )
    }
}

@Composable
private fun EffortMenu(
    efforts: List<ModelEffort>,
    current: ModelEffort?,
    select: (ModelEffort) -> Unit,
) {
    var expanded by remember { mutableStateOf(false) }
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        val label = stringResource(R.string.settings_model_effort)
        Text(label, style = MaterialTheme.typography.bodyMedium)
        Box {
            OutlinedCard(
                Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).clickable(
                    role = Role.Button
                ) {
                    expanded = true
                },
                shape = RoundedCornerShape(12.dp),
            ) {
                Row(
                    Modifier.fillMaxWidth().heightIn(min = 56.dp).padding(horizontal = 12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    Text(
                        current?.let { stringResource(it.title) } ?: label,
                        Modifier.weight(1f),
                        style = MaterialTheme.typography.bodyLarge,
                    )
                    SettingsIcon(R.drawable.ic_expand_more)
                }
            }
            DropdownMenu(expanded, onDismissRequest = { expanded = false }) {
                for (effort in efforts) {
                    DropdownMenuItem(
                        text = { Text(stringResource(effort.title)) },
                        onClick = {
                            expanded = false
                            select(effort)
                        },
                    )
                }
            }
        }
    }
}

private val ModelEffort.title: Int
    get() =
        when (this) {
            ModelEffort.LOW -> R.string.settings_model_effort_low
            ModelEffort.MEDIUM -> R.string.settings_model_effort_medium
            ModelEffort.HIGH -> R.string.settings_model_effort_high
            ModelEffort.XHIGH,
            ModelEffort.EXTRA -> R.string.settings_model_effort_extra
            ModelEffort.MAX -> R.string.settings_model_effort_max
            ModelEffort.ULTRA,
            ModelEffort.ULTRACODE -> R.string.settings_model_effort_ultra
        }
