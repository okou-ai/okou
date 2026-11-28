package ai.okou.android.settings

import ai.okou.android.CompactPanelTopAppBar
import ai.okou.android.OkouOutlinedSelectionField
import ai.okou.android.R
import ai.okou.android.SettingsIcon
import ai.okou.android.SettingsModal
import ai.okou.android.SettingsRadioRow
import ai.okou.android.SettingsRow
import ai.okou.android.SettingsSwitchRow
import ai.okou.android.SettingsTrigger
import ai.okou.android.WorkspaceFeedbackHost
import ai.okou.android.WorkspaceMenu
import ai.okou.android.WorkspaceMenuItem
import ai.okou.android.isShortSettingsPanelWindow
import ai.okou.android.settingsPanelContentPadding
import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.relocation.BringIntoViewRequester
import androidx.compose.foundation.relocation.bringIntoViewRequester
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.input.InputMode
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalInputModeManager
import androidx.compose.ui.platform.LocalLocale
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import java.text.NumberFormat

@Composable
internal fun DefaultModelSetting(
    model: DefaultModelSettings?,
    snackbar: SnackbarHostState,
    onFeedbackInOverlay: (Boolean) -> Unit,
    fallbackFocus: FocusRequester? = null,
) {
    val title = stringResource(R.string.settings_default_model)
    val auto = stringResource(R.string.settings_auto_model)
    if (model == null) {
        DefaultModelUnavailableRow(title, value = null)
        return
    }
    val state by model.state.collectAsStateWithLifecycle()
    val options = state.options
    val record = state.record
    if (options == null || record == null) {
        val status =
            when {
                state.catalogUnavailable -> stringResource(R.string.chat_list_first_load_failed)
                else -> null
            }
        val value = record?.let {
            if (isAutoDefaultModel(it.confirmed.selectedModel)) auto
            else it.confirmedLabel ?: it.confirmed.selectedModel
        }
        DefaultModelUnavailableRow(title, value, status)
        return
    }
    val selectedId = state.selectedModel
    val usingAuto = isAutoDefaultModel(selectedId)
    val confirmedAuto = isAutoDefaultModel(record.confirmed.selectedModel)
    val value =
        if (usingAuto) auto
        else
            state.selected?.label
                ?: record.confirmedLabel?.takeIf { record.confirmed.selectedModel == selectedId }
                ?: selectedId
    SettingsTrigger(
        visible = !usingAuto || !confirmedAuto || options.choices.any { it.canSelect },
        fallbackFocus = fallbackFocus,
        keepOpenWhenHidden = true,
        content = { dismiss ->
            DefaultModelSheet(title, state, model, snackbar, onFeedbackInOverlay, dismiss)
        },
    ) { modifier, open ->
        SettingsRow(
            title,
            leading = { SettingsIcon(R.drawable.ic_memory) },
            modifier = modifier,
            value = value,
            onClick = open,
        )
        HorizontalDivider()
    }
}

@Composable
private fun DefaultModelUnavailableRow(title: String, value: String?, status: String? = null) {
    val placeholder: @Composable () -> Unit = {
        Box(
            Modifier.width(64.dp)
                .height(12.dp)
                .background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(4.dp)),
        )
    }
    SettingsRow(
        title,
        leading = { SettingsIcon(R.drawable.ic_memory) },
        modifier =
            if (status == null) Modifier
            else Modifier.semantics { liveRegion = LiveRegionMode.Polite },
        value = value ?: "".takeIf { status == null },
        valueLeading = placeholder.takeIf { value == null && status == null },
        supportingText = status,
    )
    HorizontalDivider()
}

@Composable
private fun DefaultModelSheet(
    title: String,
    state: DefaultModelState,
    model: DefaultModelSettings,
    snackbar: SnackbarHostState,
    onFeedbackInOverlay: (Boolean) -> Unit,
    dismiss: () -> Unit,
) {
    val routeFeedback by rememberUpdatedState(onFeedbackInOverlay)
    DisposableEffect(Unit) {
        routeFeedback(true)
        onDispose { routeFeedback(false) }
    }
    ModelPickerSheet(
        title = title,
        choices = state.options?.choices,
        selectedId = state.selected?.id ?: state.selectedModel.takeUnless(::isAutoDefaultModel),
        effort = state.effort,
        fast = state.fast,
        select = model::select,
        selectEffort = model::effort,
        selectFast = model::fast,
        dismiss = dismiss,
        snackbar = snackbar,
        footer = {
            val saving = stringResource(R.string.settings_saving)
            val status = if (state.save != null) saving else ""
            SettingsWriteStatus(status, listOf(saving), Modifier.padding(top = 8.dp))
        },
    )
}

@Composable
internal fun ModelPickerSheet(
    title: String,
    choices: List<DefaultModelChoice>?,
    selectedId: String?,
    effort: ModelEffort?,
    fast: Boolean,
    select: (String?) -> Unit,
    selectEffort: (ModelEffort) -> Unit,
    selectFast: (Boolean) -> Unit,
    dismiss: () -> Unit,
    catalogUnavailable: Boolean = false,
    snackbar: SnackbarHostState? = null,
    footerHasAction: Boolean = false,
    footer: @Composable () -> Unit = {},
) {
    val fullScreen = isShortSettingsPanelWindow()
    val scroll = rememberScrollState()
    val contentPadding = settingsPanelContentPadding(compactHeight = fullScreen)
    var footerHeight by remember { mutableIntStateOf(0) }
    val selected = choices?.firstOrNull { it.id == selectedId }
    val advancedModel = selected?.takeIf { it.canSelect }
    val showEffort = advancedModel != null && advancedModel.efforts.isNotEmpty()
    val fastMultiplier = advancedModel?.fastMultiplier
    val panel: @Composable (Boolean) -> Unit = { centered ->
        val selectedFocus = remember { FocusRequester() }
        val backFocus = remember { FocusRequester() }
        var effortFocused by remember { mutableStateOf(false) }
        var fastFocused by remember { mutableStateOf(false) }
        // Capture focus before Compose detaches a hidden control.
        val restoreFocus = (!showEffort && effortFocused) || (fastMultiplier == null && fastFocused)
        LaunchedEffect(showEffort, fastMultiplier != null) {
            if (restoreFocus) {
                effortFocused = false
                fastFocused = false
                val selectedAvailable =
                    choices != null && (selectedId == null || selected?.canSelect == true)
                if (!selectedAvailable || !selectedFocus.requestFocus()) backFocus.requestFocus()
            }
        }
        val size =
            if (fullScreen) Modifier.fillMaxHeight()
            else
                Modifier.animateContentSize(
                    alignment = if (centered) Alignment.Center else Alignment.BottomCenter,
                )
        Column(
            Modifier.fillMaxWidth()
                .then(size)
                .padding(contentPadding)
                .padding(top = if (centered && !fullScreen) 16.dp else 0.dp),
        ) {
            if (fullScreen) {
                CompactPanelTopAppBar(
                    title,
                    back = dismiss,
                    backFocus = backFocus,
                )
            } else {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    IconButton(
                        onClick = dismiss,
                        modifier = Modifier.size(48.dp).focusRequester(backFocus),
                    ) {
                        Icon(
                            painterResource(R.drawable.ic_arrow_back),
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
            }
            Column(
                Modifier.weight(1f, fill = false).verticalScroll(scroll),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) body@{
                if (catalogUnavailable)
                    Text(
                        stringResource(R.string.chat_list_first_load_failed),
                        Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                if (choices == null) {
                    if (!catalogUnavailable) SettingsPlaceholder()
                    return@body
                }
                val initialModel = remember { selected?.takeIf { it.canSelect }?.id }
                val reveal = remember { BringIntoViewRequester() }
                val focus = remember { FocusRequester() }
                val inputMode = LocalInputModeManager.current
                var positioned by remember { mutableStateOf(false) }
                val initialRow =
                    Modifier.focusRequester(focus)
                        .bringIntoViewRequester(reveal)
                        .onGloballyPositioned { positioned = true }
                LaunchedEffect(positioned) {
                    if (positioned) {
                        if (inputMode.inputMode == InputMode.Keyboard) focus.requestFocus()
                        reveal.bringIntoView()
                    }
                }
                fun rowFocus(id: String?, enabled: Boolean = true): Modifier {
                    val initial = if (id == initialModel) initialRow else Modifier
                    return if (id == selectedId && enabled) initial.focusRequester(selectedFocus)
                    else initial
                }
                Column(Modifier.fillMaxWidth().selectableGroup()) {
                    SettingsRadioRow(
                        stringResource(R.string.settings_auto_model),
                        selected = selectedId == null,
                        enabled = true,
                        supportingText = stringResource(R.string.settings_auto_model_detail),
                        modifier = rowFocus(null),
                        onClick = { select(null) },
                    )
                    for (choice in choices) {
                        key(choice.id) {
                            SettingsRadioRow(
                                choice.label,
                                selected = choice.id == selected?.id,
                                enabled = choice.canSelect,
                                supportingText =
                                    if (choice.canSelect) null
                                    else stringResource(R.string.settings_model_plan_restricted),
                                modifier = rowFocus(choice.id, choice.canSelect),
                                onClick = { select(choice.id) },
                            )
                        }
                    }
                }
                if (advancedModel != null && (showEffort || fastMultiplier != null)) {
                    HorizontalDivider()
                    Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
                        if (showEffort) {
                            EffortMenu(
                                advancedModel,
                                effort,
                                selectEffort,
                                Modifier.onFocusChanged { effortFocused = it.isFocused },
                            )
                        }
                        fastMultiplier?.let { multiplier ->
                            val usage = multiplier.toBigDecimal()
                            val value =
                                NumberFormat.getNumberInstance(
                                        LocalLocale.current.platformLocale,
                                    )
                                    .apply {
                                        maximumFractionDigits = usage.scale().coerceAtLeast(0)
                                    }
                                    .format(usage)
                            SettingsSwitchRow(
                                stringResource(R.string.settings_model_fast),
                                leading = {},
                                checked = fast,
                                onCheckedChange = selectFast,
                                modifier = Modifier.onFocusChanged { fastFocused = it.isFocused },
                                supportingText =
                                    stringResource(
                                        R.string.settings_model_fast_usage,
                                        value,
                                    ),
                            )
                        }
                    }
                }
            }
            if (footerHasAction) {
                Column(Modifier.onSizeChanged { footerHeight = it.height }) { footer() }
            } else footer()
        }
    }
    SettingsModal(dismiss, fullScreen = fullScreen, fitContentInsets = fullScreen) { centered ->
        Box(Modifier.testTag("model-picker"), propagateMinConstraints = true) {
            panel(centered)
            if (snackbar != null) {
                val footerInset =
                    if (footerHasAction) {
                        with(LocalDensity.current) { footerHeight.toDp() } +
                            contentPadding.calculateBottomPadding()
                    } else 0.dp
                Box(Modifier.matchParentSize(), contentAlignment = Alignment.BottomCenter) {
                    WorkspaceFeedbackHost(
                        snackbar,
                        Modifier.padding(bottom = 8.dp + footerInset),
                        manageTimeout = false,
                    )
                }
            }
        }
    }
}

@Composable
private fun EffortMenu(
    model: DefaultModelChoice,
    current: ModelEffort?,
    select: (ModelEffort) -> Unit,
    modifier: Modifier = Modifier,
) {
    var expanded by remember(model.id) { mutableStateOf(false) }
    val label = stringResource(R.string.settings_model_effort)
    Box {
        OkouOutlinedSelectionField(
            label,
            current?.let { stringResource(it.title) } ?: label,
            modifier = modifier,
            onClick = { expanded = true },
        )
        if (expanded) {
            WorkspaceMenu(
                items =
                    model.efforts.map { effort ->
                        WorkspaceMenuItem(
                            stringResource(effort.title),
                            selected = effort == current,
                        ) {
                            expanded = false
                            select(effort)
                        }
                    },
                close = { expanded = false },
            )
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
