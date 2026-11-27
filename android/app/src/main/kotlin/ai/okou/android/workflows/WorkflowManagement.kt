package ai.okou.android.workflows

import ai.okou.android.LocalOkouDarkMode
import ai.okou.android.NativeAboveLabelPadding
import ai.okou.android.OkouActionButton
import ai.okou.android.OkouActionTreatment
import ai.okou.android.OkouFormLayout
import ai.okou.android.OkouOutlinedSelectionField
import ai.okou.android.R
import ai.okou.android.SettingsTrigger
import ai.okou.android.WorkspaceFilterRow
import ai.okou.android.WorkspaceMenu
import ai.okou.android.WorkspaceMenuItem
import ai.okou.android.api.ApiFailure
import ai.okou.android.api.generated.WorkflowAutomation
import ai.okou.android.api.generated.WorkflowAutomationVariant1
import ai.okou.android.api.generated.WorkflowAutomationVariant11
import ai.okou.android.api.generated.WorkflowAutomationVariant12
import ai.okou.android.api.generated.WorkflowAutomationVariant13
import ai.okou.android.api.generated.WorkflowAutomationVariant1ScheduleVariant1
import ai.okou.android.api.generated.WorkflowAutomationVariant1ScheduleVariant3
import ai.okou.android.api.generated.WorkflowAutomationVariant2
import ai.okou.android.api.generated.WorkflowAutomationVariant3
import ai.okou.android.api.generated.WorkflowAutomationVariant4
import ai.okou.android.api.generated.WorkflowDetail
import ai.okou.android.chat.chatTime
import ai.okou.android.okouFormLabelHeight
import ai.okou.android.okouFormSupportingTextStyle
import ai.okou.android.preferences.TimezoneSelectionSheet
import ai.okou.android.preferences.timezoneLabel
import ai.okou.android.updates.updateFocusOutline
import android.app.TimePickerDialog
import android.text.format.DateFormat as AndroidDateFormat
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.wrapContentHeight
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.input.InputTransformation
import androidx.compose.foundation.text.input.TextFieldLineLimits
import androidx.compose.foundation.text.input.TextFieldState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextFieldLabelPosition
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.error
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import java.text.DateFormat
import java.text.NumberFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import kotlin.math.ceil
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.first

@Composable
internal fun WorkflowRuleRow(
    rule: WorkflowAutomation,
    state: WorkflowState,
    actionsEnabled: Boolean,
    timezone: String,
    onEdit: (WorkflowEdit.Rule, Boolean) -> Unit,
    restoreEditorFocus: Boolean,
    onEditorFocusRestored: () -> Unit,
    onToggle: (WorkflowAutomation) -> Unit,
    onViewConnection: ((String, String?) -> Unit)?,
    restoreConnectionFocus: Boolean,
    onConnectionFocusRestored: () -> Unit,
) {
    val colors = MaterialTheme.colorScheme
    val connectionRequired = rule.needsConnection(state.connections)
    val status =
        stringResource(
            if (rule.enabled) R.string.workflow_enabled else R.string.workflow_rule_paused,
        )
    val badge =
        if (connectionRequired) stringResource(R.string.workflow_status_connection, status)
        else status
    val badgeColor =
        when {
            connectionRequired -> colors.error
            rule.enabled -> MaterialTheme.colorScheme.primary
            else -> colors.onSurfaceVariant
        }
    val editable = remember(rule, timezone) { rule.editableRule(timezone) }
    val titleMinWidth = with(LocalDensity.current) { 16.sp.toDp() * 10 }
    val connector = rule.source.connector
    val canOpenConnection = connector != null && onViewConnection != null
    val toggle = state.toggles[rule.id]
    val pendingToggle = toggle?.takeUnless { it.phase == WorkflowTogglePhase.Failed }
    fun viewConnections() {
        if (connector != null) onViewConnection?.invoke(connector, rule.id)
    }
    Column(
        Modifier.fillMaxWidth().padding(vertical = 12.dp).testTag("workflow_rule_${rule.id}"),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        FlowRow(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
            itemVerticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                ruleTitle(rule),
                Modifier.widthIn(min = titleMinWidth).weight(1f).semantics { heading() },
                style = workflowBodyStyle(),
                fontWeight = FontWeight.SemiBold,
            )
            Box(Modifier.semantics { liveRegion = LiveRegionMode.Polite }) {
                WorkflowStatus(badge, badgeColor)
            }
        }
        val scheduleZone = ruleScheduleZone(rule)
        val nextRun =
            rule.nextRunAt
                ?.takeIf { rule.enabled }
                ?.let {
                    stringResource(
                        R.string.workflow_next_run,
                        workflowTimestamp(it, scheduleZone ?: timezone),
                    )
                }
        if (scheduleZone != null) {
            val label = timezoneLabel(scheduleZone)
            val schedule =
                if (nextRun == null) stringResource(R.string.workflow_rule_timezone, label)
                else "$nextRun · $label"
            WorkflowSecondary(schedule, small = true)
        } else {
            ruleDescription(rule, connectionRequired)?.let { WorkflowSecondary(it, small = true) }
            if (nextRun != null) WorkflowSecondary(nextRun, small = true)
        }
        val failure = state.issue?.takeIf { it.ruleId == rule.id }?.failure
        when {
            toggle?.phase == WorkflowTogglePhase.Unconfirmed ->
                WorkflowNotice(R.string.workflow_rule_unconfirmed)
            toggle?.phase == WorkflowTogglePhase.Failed || failure == WorkflowWriteFailure.Failed ->
                WorkflowNotice(R.string.workflow_rule_change_failed)
            failure == WorkflowWriteFailure.Network ->
                WorkflowNotice(R.string.workflow_rule_network_failed)
        }
        if (rule.official == null) {
            val toggleFocus = remember { FocusRequester() }
            val recoveryFocus = remember { FocusRequester() }
            var connectionFocused by remember { mutableStateOf(false) }
            val showSeparateConnection = connectionRequired && rule.enabled
            val restoreToggleFocus = !showSeparateConnection && connectionFocused
            val needsRecovery = connectionRequired && !rule.enabled && pendingToggle == null
            val canToggle = rule.enabled || rule.canEnable(state.connections)
            val toggleEnabled =
                actionsEnabled &&
                    (pendingToggle != null ||
                        !state.writing && (if (needsRecovery) canOpenConnection else canToggle))
            val pendingStatus =
                when (pendingToggle?.phase) {
                    WorkflowTogglePhase.Submitting -> R.string.settings_saving
                    WorkflowTogglePhase.Checking -> R.string.workflow_rule_checking
                    WorkflowTogglePhase.Unconfirmed -> R.string.workflow_rule_unconfirmed
                    else -> null
                }
            LaunchedEffect(showSeparateConnection, restoreConnectionFocus, toggleEnabled) {
                if (restoreConnectionFocus && actionsEnabled) {
                    val target =
                        if (showSeparateConnection && canOpenConnection) recoveryFocus
                        else if (toggleEnabled) toggleFocus else return@LaunchedEffect
                    if (target.requestFocus()) onConnectionFocusRestored()
                } else if (restoreToggleFocus && toggleEnabled) toggleFocus.requestFocus()
            }
            FlowRow(
                Modifier.padding(top = 4.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                if (showSeparateConnection)
                    WorkflowAction(
                        stringResource(R.string.workflow_view_connection),
                        ::viewConnections,
                        Modifier.focusRequester(recoveryFocus).onFocusChanged {
                            connectionFocused = it.isFocused
                        },
                        enabled = actionsEnabled && canOpenConnection && !state.writing,
                    )
                WorkflowAction(
                    stringResource(
                        when {
                            pendingToggle?.enabled == true -> R.string.workflow_enable
                            pendingToggle?.enabled == false -> R.string.workflow_pause
                            rule.enabled -> R.string.workflow_pause
                            needsRecovery -> R.string.workflow_view_connection
                            else -> R.string.workflow_enable
                        },
                    ),
                    {
                        if (needsRecovery) viewConnections()
                        else if (!state.writing && pendingToggle == null) onToggle(rule)
                    },
                    enabled = toggleEnabled,
                    pendingStatus = pendingStatus,
                    showPendingProgress = pendingToggle?.phase != WorkflowTogglePhase.Unconfirmed,
                    modifier =
                        Modifier.focusRequester(toggleFocus)
                            .then(
                                if (needsRecovery) Modifier
                                else Modifier.testTag("workflow_toggle_${rule.id}"),
                            ),
                )
                if (editable != null)
                    WorkflowEditorAction(
                        R.string.workflow_edit,
                        enabled = actionsEnabled && !state.writing && pendingToggle == null,
                        restoreFocus = restoreEditorFocus,
                        onFocusRestored = onEditorFocusRestored,
                    ) { focused ->
                        onEdit(editable, focused)
                    }
            }
        }
    }
}

@Composable
internal fun WorkflowEditorAction(
    label: Int,
    enabled: Boolean,
    restoreFocus: Boolean,
    onFocusRestored: () -> Unit,
    onEdit: (Boolean) -> Unit,
) {
    val actionFocus = rememberWorkflowReturnFocus(restoreFocus, enabled, onFocusRestored)
    WorkflowAction(
        stringResource(label),
        { onEdit(actionFocus.keyboardFocused) },
        actionFocus.modifier,
        enabled = enabled,
    )
}

@Composable
private fun ruleTitle(rule: WorkflowAutomation): String =
    when (rule) {
        is WorkflowAutomationVariant1 -> {
            val simple =
                (rule.schedule as? WorkflowAutomationVariant1ScheduleVariant1)?.simpleRule()
            if (simple == null) rule.scheduleSummary
            else
                stringResource(
                    if (simple.weekdays) R.string.workflow_weekday_schedule
                    else R.string.workflow_daily_schedule,
                    simple.time,
                )
        }
        is WorkflowAutomationVariant3 ->
            rule.eventConfig.match?.subject?.contains?.let {
                stringResource(R.string.workflow_mail_subject_contains, it)
            } ?: stringResource(rule.eventLabel)
        else -> stringResource(rule.eventLabel)
    }

@Composable
private fun ruleDescription(rule: WorkflowAutomation, connectionRequired: Boolean): String? {
    if (connectionRequired)
        return stringResource(
            if (rule.enabled) R.string.workflow_resume_provider
            else R.string.workflow_connect_provider,
            stringResource(rule.source.label),
        )
    return when (rule) {
        is WorkflowAutomationVariant1 -> null
        is WorkflowAutomationVariant2 -> rule.eventConfig.outputPattern
        is WorkflowAutomationVariant3 ->
            rule.eventConfig.match?.from?.contains?.let {
                stringResource(R.string.workflow_mail_from_contains, it)
            }
        is WorkflowAutomationVariant4 -> rule.eventConfig.labelName
        is WorkflowAutomationVariant11 -> rule.eventConfig.calendarId
        is WorkflowAutomationVariant12 -> rule.eventConfig.calendarId
        is WorkflowAutomationVariant13 -> rule.eventConfig.calendarId
        else -> rule.githubRepositorySummary() ?: stringResource(rule.source.label)
    }
}

private fun ruleScheduleZone(rule: WorkflowAutomation): String? =
    when (val schedule = (rule as? WorkflowAutomationVariant1)?.schedule) {
        is WorkflowAutomationVariant1ScheduleVariant1 -> schedule.timezone
        is WorkflowAutomationVariant1ScheduleVariant3 -> schedule.timezone
        else -> null
    }

@Composable
internal fun workflowTimestamp(time: String, timezone: String): String {
    val locale = LocalConfiguration.current.locales[0]
    return remember(time, timezone, locale) {
        try {
            DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT, locale)
                .apply { timeZone = TimeZone.getTimeZone(timezone) }
                .format(Date(chatTime(time)))
        } catch (_: ApiFailure.IncompatibleResponse) {
            time
        }
    }
}

@Composable
internal fun WorkflowEditor(
    detail: WorkflowDetail,
    editing: WorkflowEditSession,
    state: WorkflowState,
    model: WorkflowModel,
    wide: Boolean,
    feedback: @Composable () -> Unit,
    discarding: Boolean,
    onCancel: () -> Unit,
    onViewConnection: ((String) -> Unit)?,
    restoreConnectionFocus: Boolean,
    onConnectionFocusRestored: () -> Unit,
) {
    val editor = editing.draft
    val horizontalPadding = if (wide) 32.dp else 20.dp
    val activeRule = editor as? WorkflowEdit.Rule
    val available = !state.writing && detail.canEdit(editor)
    val connectionRequired = activeRule?.blockingConnection(detail, state.connections)
    val connector = connectionRequired?.connector
    val showConnectionAction = connector != null && state.connections != null
    val connectionFeedback =
        state.connectionAccessFeedback().takeIf {
            activeRule?.value?.trigger?.source?.connector != null
        }
    val saveEnabled =
        available &&
            editor.canSave &&
            connectionRequired == null &&
            state.issue?.failure != WorkflowWriteFailure.UncertainCreate
    val saveFocus = remember { FocusRequester() }
    val recoveryFocus = remember { FocusRequester() }
    val cancelFocus = remember { FocusRequester() }
    var connectionFocused by remember { mutableStateOf(false) }
    var saveFocused by remember { mutableStateOf(false) }
    var restoreSaveFocusAfterWrite by remember { mutableStateOf(false) }
    val restoreSaveFocus =
        !showConnectionAction && saveEnabled && (connectionFocused || restoreSaveFocusAfterWrite)
    val inputGuard =
        remember(model, editing) {
            InputTransformation { if (!model.canEdit(editing)) revertAllChanges() }
        }
    val fieldFocus =
        remember(editing, discarding) {
            WorkflowFieldFocus(editing, discarding, restoreConnectionFocus)
        }
    val issue = state.issue
    if (issue?.rejectedDraft != null) {
        LaunchedEffect(model, editing, issue) {
            snapshotFlow { editing.draft.hasSameInput(issue.rejectedDraft) }.first { !it }
            model.clearRejectedEdit(editing, issue)
        }
    }
    LaunchedEffect(showConnectionAction, saveEnabled, restoreConnectionFocus) {
        if (restoreConnectionFocus && !state.writing) {
            val target =
                when {
                    showConnectionAction && onViewConnection != null -> recoveryFocus
                    saveEnabled -> saveFocus
                    else -> cancelFocus
                }
            if (target.requestFocus()) onConnectionFocusRestored()
        } else if (restoreSaveFocus) {
            restoreSaveFocusAfterWrite = false
            saveFocus.requestFocus()
        }
    }
    WorkflowEditorLayout(
        fields = {
            Box(Modifier.fillMaxSize()) {
                Column(
                    Modifier.fillMaxSize()
                        .testTag("workflow_editor_fields")
                        .verticalScroll(rememberScrollState())
                        .padding(horizontal = horizontalPadding, vertical = 16.dp),
                    verticalArrangement = Arrangement.spacedBy(16.dp),
                ) {
                    val heading =
                        when (editor) {
                            is WorkflowEdit.Instructions -> R.string.workflow_edit_instructions
                            is WorkflowEdit.Rule ->
                                if (editor.id == null) R.string.workflow_add_automation
                                else R.string.workflow_edit_automation
                        }
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(
                            stringResource(heading),
                            Modifier.semantics { heading() },
                            style = MaterialTheme.typography.headlineSmall,
                        )
                        if (activeRule != null)
                            WorkflowSecondary(
                                workflowDisplayTitle(detail.name, detail.displayName),
                                small = true,
                            )
                    }
                    when (editing) {
                        is WorkflowEditSession.Instructions -> {
                            val value = editing.draft.value
                            WorkflowField(
                                R.string.workflow_name,
                                editing.title,
                                available,
                                inputGuard,
                                fieldFocus,
                                validation =
                                    workflowValidation(
                                        value.title,
                                        WORKFLOW_DISPLAY_NAME_LIMIT,
                                        stringResource(R.string.workflow_name_required),
                                    ),
                            )
                            WorkflowField(
                                R.string.workflow_purpose,
                                editing.purpose,
                                available,
                                inputGuard,
                                fieldFocus,
                                validation =
                                    workflowValidation(value.purpose, WORKFLOW_PURPOSE_LIMIT),
                            )
                            WorkflowField(
                                R.string.workflow_instructions_heading,
                                editing.instruction,
                                available,
                                inputGuard,
                                fieldFocus,
                                singleLine = false,
                                validation =
                                    workflowValidation(
                                        value.instruction,
                                        WORKFLOW_INSTRUCTION_LIMIT,
                                    ),
                            )
                        }
                        is WorkflowEditSession.Rule ->
                            WorkflowRuleFields(editing, available, model, inputGuard, fieldFocus)
                    }
                }
                Box(Modifier.align(Alignment.BottomCenter)) { feedback() }
            }
        },
    ) {
        Column(
            Modifier.fillMaxWidth().padding(horizontal = horizontalPadding, vertical = 8.dp),
            horizontalAlignment = Alignment.End,
            verticalArrangement = Arrangement.spacedBy(OkouFormLayout.ActionGap),
        ) {
            if (connectionFeedback != null) WorkflowNotice(connectionFeedback)
            if (connectionRequired != null && state.connections != null) {
                WorkflowStatus(
                    stringResource(
                        R.string.workflow_connect_to_save,
                        stringResource(connectionRequired.label),
                    ),
                    MaterialTheme.colorScheme.error,
                )
            }
            WorkflowEditorWriteFeedback(editor, issue?.failure)
            FlowRow(
                horizontalArrangement =
                    Arrangement.spacedBy(OkouFormLayout.ActionGap, Alignment.End),
                verticalArrangement = Arrangement.spacedBy(OkouFormLayout.ActionGap),
            ) {
                OkouActionButton(
                    stringResource(R.string.workflow_cancel),
                    onCancel,
                    Modifier.focusRequester(cancelFocus),
                    enabled = !state.writing,
                    treatment = OkouActionTreatment.Text,
                    useMaterialButtonDefaults = true,
                )
                if (showConnectionAction) {
                    OkouActionButton(
                        stringResource(R.string.workflow_view_connection),
                        { onViewConnection?.invoke(connector) },
                        Modifier.focusRequester(recoveryFocus).onFocusChanged {
                            connectionFocused = it.isFocused
                        },
                        enabled = !state.writing && onViewConnection != null,
                        treatment = OkouActionTreatment.Outline,
                        useMaterialButtonDefaults = true,
                    )
                }
                val saveLabel = stringResource(R.string.workflow_save)
                val savingLabel = stringResource(R.string.settings_saving)
                val pendingSemantics =
                    if (state.writing)
                        Modifier.clearAndSetSemantics {
                            contentDescription = saveLabel
                            stateDescription = savingLabel
                            role = Role.Button
                            liveRegion = LiveRegionMode.Polite
                            disabled()
                        }
                    else Modifier
                OkouActionButton(
                    if (state.writing) savingLabel else saveLabel,
                    onClick = {
                        if (model.canEdit(editing)) {
                            restoreSaveFocusAfterWrite = saveFocused
                            model.save(editing.draft)
                        }
                    },
                    enabled = saveEnabled,
                    layoutLabels = listOf(saveLabel, savingLabel),
                    useMaterialButtonDefaults = true,
                    modifier =
                        Modifier.focusRequester(saveFocus)
                            .onFocusChanged { saveFocused = it.isFocused }
                            .updateFocusOutline(
                                ButtonDefaults.shape,
                                MaterialTheme.colorScheme.onPrimary,
                                outlineInset = WorkflowFilledActionFocusInset,
                            )
                            .testTag("workflow_save")
                            .then(pendingSemantics),
                )
            }
        }
    }
}

@Composable
private fun WorkflowEditorLayout(fields: @Composable () -> Unit, actions: @Composable () -> Unit) {
    BoxWithConstraints(Modifier.fillMaxSize(), contentAlignment = Alignment.TopCenter) {
        val viewport = maxHeight
        Layout(
            content = {
                fields()
                Column {
                    WorkflowDivider()
                    actions()
                }
            },
            modifier =
                Modifier.widthIn(max = 730.dp).fillMaxWidth().verticalScroll(rememberScrollState()),
        ) { children, constraints ->
            val loose = constraints.copy(minHeight = 0)
            val footer = children[1].measure(loose)
            val viewportHeight = viewport.roundToPx()
            // Keep room for a labeled field. If the footer no longer fits, it scrolls into view.
            val minimumFieldsHeight =
                (OutlinedTextFieldDefaults.MinHeight +
                        24.sp.toDp() +
                        16.sp.toDp() +
                        NativeAboveLabelPadding)
                    .roundToPx()
                    .coerceAtMost(viewportHeight)
            val fieldsHeight = maxOf(viewportHeight - footer.height, minimumFieldsHeight)
            val body =
                children[0].measure(loose.copy(minHeight = fieldsHeight, maxHeight = fieldsHeight))
            layout(constraints.maxWidth, body.height + footer.height) {
                body.placeRelative(0, 0)
                footer.placeRelative(0, body.height)
            }
        }
    }
}

private fun WorkflowEdit.hasSameInput(other: WorkflowEdit): Boolean =
    when (this) {
        is WorkflowEdit.Instructions -> other is WorkflowEdit.Instructions && value == other.value
        is WorkflowEdit.Rule -> other is WorkflowEdit.Rule && id == other.id && value == other.value
    }

@Composable
private fun WorkflowEditorWriteFeedback(editor: WorkflowEdit, failure: WorkflowWriteFailure?) {
    val reservedLabel =
        when (editor) {
            is WorkflowEdit.Instructions -> R.string.workflow_write_conflict
            is WorkflowEdit.Rule -> R.string.workflow_create_uncertain.takeIf { editor.id == null }
        }
    val message =
        when (failure) {
            WorkflowWriteFailure.UncertainCreate -> R.string.workflow_create_uncertain
            WorkflowWriteFailure.Conflict -> R.string.workflow_write_conflict
            WorkflowWriteFailure.Network,
            WorkflowWriteFailure.Failed -> R.string.workflow_write_failed
            null -> null
        }
    val colors = MaterialTheme.colorScheme
    val style = workflowBodyStyle().copy(fontSize = 14.sp, lineHeight = 20.sp)
    val hidden = Modifier.clearAndSetSemantics {}.alpha(0f)
    Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.BottomEnd) {
        Text(stringResource(R.string.workflow_write_failed), hidden, style = style)
        if (reservedLabel != null) Text(stringResource(reservedLabel), hidden, style = style)
        if (message != null) {
            Text(
                stringResource(message),
                Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                color =
                    if (
                        failure == WorkflowWriteFailure.Conflict ||
                            failure == WorkflowWriteFailure.Failed
                    )
                        colors.error
                    else colors.onSurfaceVariant,
                style = style,
            )
        }
    }
}

internal fun WorkflowState.connectionAccessFeedback(): Int? =
    R.string.connector_accounts_failed.takeIf {
        connectionsFailure == WorkflowReadFailure.Unavailable
    }

@Composable
private fun WorkflowRuleFields(
    editing: WorkflowEditSession.Rule,
    enabled: Boolean,
    model: WorkflowModel,
    inputGuard: InputTransformation,
    fieldFocus: WorkflowFieldFocus,
) {
    val editor = editing.draft
    val fields = editor.value
    fun editFields(change: (RuleFields) -> RuleFields) {
        model.editRuleOptions(editing) { it.copy(value = change(it.value)) }
    }
    if (editor.id == null) {
        val mode =
            if (fields.trigger == EditableTrigger.Schedule) TriggerMode.Schedule
            else TriggerMode.Event
        val triggerLabel = stringResource(R.string.workflow_trigger)
        WorkspaceFilterRow(
            TriggerMode.entries,
            mode,
            Role.RadioButton,
            label = {
                stringResource(
                    if (it == TriggerMode.Schedule) R.string.workflow_schedule
                    else R.string.workflow_event,
                )
            },
            modifier =
                Modifier.fillMaxWidth().semantics {
                    contentDescription = triggerLabel
                },
            enabled = enabled,
        ) {
            if (it == mode) return@WorkspaceFilterRow
            model.editRuleOptions(editing) { rule ->
                when (it) {
                    TriggerMode.Schedule ->
                        rule.copy(
                            value = rule.value.copy(trigger = EditableTrigger.Schedule),
                            lastEventSource = rule.value.trigger,
                        )
                    TriggerMode.Event ->
                        rule.copy(value = rule.value.copy(trigger = rule.lastEventSource))
                }
            }
        }
        if (mode == TriggerMode.Event) {
            val sources = listOf(EditableTrigger.Calendar, EditableTrigger.Gmail)
            WorkflowChoice(
                R.string.workflow_event_source,
                sources.map { stringResource(it.eventLabel) },
                sources.indexOf(fields.trigger),
                enabled,
            ) { chosen ->
                editFields { it.copy(trigger = sources[chosen]) }
            }
        }
    }
    when (fields.trigger) {
        EditableTrigger.Schedule -> {
            val frequency =
                listOf(
                    stringResource(R.string.workflow_weekdays),
                    stringResource(R.string.workflow_daily),
                )
            WorkflowChoice(
                R.string.workflow_frequency,
                frequency,
                if (fields.weekdays) 0 else 1,
                enabled,
            ) { chosen ->
                editFields { it.copy(weekdays = chosen == 0) }
            }
            WorkflowTime(fields.time, enabled) { time -> editFields { it.copy(time = time) } }
            WorkflowTimezone(fields.timezone, enabled) { timezone ->
                editFields { it.copy(timezone = timezone) }
            }
        }
        EditableTrigger.Gmail ->
            WorkflowField(
                R.string.workflow_match_subject,
                editing.subject,
                enabled,
                inputGuard,
                fieldFocus,
            )
        EditableTrigger.Calendar ->
            WorkflowField(
                R.string.workflow_calendar_id,
                editing.calendarId,
                enabled,
                inputGuard,
                fieldFocus,
                validation =
                    workflowValidation(fields.trimmedCalendarId, WORKFLOW_CALENDAR_ID_LIMIT),
            )
    }
    WorkflowSecondary(
        stringResource(
            if (editor.enabled) R.string.workflow_rule_stays_enabled
            else R.string.workflow_rule_stays_paused,
        ),
        small = true,
    )
}

private enum class TriggerMode {
    Schedule,
    Event,
}

private val EditableTrigger.eventLabel: Int
    get() =
        when (this) {
            EditableTrigger.Schedule -> error("Schedule has no event source")
            EditableTrigger.Gmail -> R.string.workflow_source_gmail
            EditableTrigger.Calendar -> R.string.workflow_source_calendar
        }

private data class WorkflowValidation(
    val lengthMessage: String,
    val requiredMessage: String?,
    val errorMessage: String?,
)

@Composable
private fun workflowValidation(
    value: String,
    limit: Int,
    requiredMessage: String? = null,
): WorkflowValidation {
    val locale = LocalConfiguration.current.locales[0]
    val formattedLimit =
        remember(locale, limit) { NumberFormat.getIntegerInstance(locale).format(limit) }
    val lengthMessage = stringResource(R.string.workflow_field_too_long, formattedLimit)
    val errorMessage =
        when {
            requiredMessage != null && value.isBlank() -> requiredMessage
            value.length > limit -> lengthMessage
            else -> null
        }
    return WorkflowValidation(lengthMessage, requiredMessage, errorMessage)
}

private class WorkflowFieldFocus(
    private val editing: WorkflowEditSession,
    val discarding: Boolean,
    returningFromConnection: Boolean,
) {
    // Take a new restore target on reattachment or after dismissing the discard dialog.
    private var pending =
        editing.fieldSelection.takeUnless { discarding || returningFromConnection }

    fun restore(input: TextFieldState, requester: FocusRequester) {
        val retained = pending?.takeIf { it.field === input } ?: return
        if (requester.requestFocus()) {
            input.edit {
                selection =
                    TextRange(
                        retained.range.start.coerceAtMost(length),
                        retained.range.end.coerceAtMost(length),
                    )
            }
            pending = null
        }
    }

    fun rememberSelection(input: TextFieldState, range: TextRange) {
        editing.rememberSelection(input, range)
    }
}

@Composable
private fun WorkflowField(
    label: Int,
    input: TextFieldState,
    enabled: Boolean,
    inputGuard: InputTransformation,
    fieldFocus: WorkflowFieldFocus,
    singleLine: Boolean = true,
    validation: WorkflowValidation? = null,
) {
    val title = stringResource(label)
    val baseHeight = if (singleLine) OutlinedTextFieldDefaults.MinHeight else 112.dp
    val errorMessage = validation?.errorMessage
    BoxWithConstraints(Modifier.fillMaxWidth()) {
        val requester = remember { FocusRequester() }
        var focused by remember { mutableStateOf(false) }
        val supportStyle = okouFormSupportingTextStyle()
        val labelHeight =
            okouFormLabelHeight(
                title,
                constraints.maxWidth,
                MaterialTheme.typography.bodySmall,
                NativeAboveLabelPadding,
            )
        val minimumHeight =
            if (validation == null) baseHeight else baseHeight + OkouFormLayout.SupportingTextGap
        val supportHeight =
            if (validation == null) 0.dp
            else workflowSupportingHeight(validation, supportStyle, constraints.maxWidth)
        OutlinedTextField(
            state = input,
            inputTransformation = inputGuard,
            modifier =
                Modifier.fillMaxWidth()
                    .heightIn(min = minimumHeight + supportHeight + labelHeight)
                    .focusRequester(requester)
                    .onFocusChanged { focused = it.isFocused }
                    .semantics {
                        contentDescription = title
                        if (errorMessage != null) error(errorMessage)
                    },
            enabled = enabled,
            labelPosition = TextFieldLabelPosition.Above(),
            label = { Text(title) },
            isError = errorMessage != null,
            lineLimits =
                if (singleLine) TextFieldLineLimits.SingleLine
                else TextFieldLineLimits.MultiLine(maxHeightInLines = 8),
            supportingText =
                if (validation == null) null
                else {
                    {
                        Box(Modifier.height(supportHeight).clipToBounds()) {
                            if (errorMessage != null) {
                                Text(
                                    errorMessage,
                                    modifier =
                                        Modifier.wrapContentHeight(
                                            Alignment.Top,
                                            unbounded = true,
                                        ),
                                    style = supportStyle,
                                )
                            }
                        }
                    }
                },
        )
        LaunchedEffect(input, fieldFocus) {
            if (fieldFocus.discarding) return@LaunchedEffect
            fieldFocus.restore(input, requester)
            snapshotFlow { if (focused) input.selection else null }
                .filterNotNull()
                .collect { fieldFocus.rememberSelection(input, it) }
        }
    }
}

@Composable
private fun workflowSupportingHeight(
    validation: WorkflowValidation,
    style: TextStyle,
    fieldWidth: Int,
): Dp {
    val measurer = rememberTextMeasurer()
    val density = LocalDensity.current
    val reservedPixels =
        remember(measurer, density, style, validation.lengthMessage, validation.requiredMessage) {
            with(density) {
                // A localized fallback font can make one line taller than its nominal line height.
                val lengthLine = measurer.measure(validation.lengthMessage, style, maxLines = 1)
                val requiredLine =
                    validation.requiredMessage?.let { measurer.measure(it, style, maxLines = 1) }
                maxOf(
                    ceil(style.lineHeight.toPx()).toInt(),
                    lengthLine.size.height,
                    requiredLine?.size?.height ?: 0,
                )
            }
        }
    val errorPixels =
        remember(measurer, density, style, fieldWidth, validation.errorMessage) {
            validation.errorMessage?.let {
                // Material 3 adds 16 dp of supporting-text padding on each side.
                val textWidth =
                    with(density) { (fieldWidth - 2 * 16.dp.roundToPx()).coerceAtLeast(0) }
                measurer
                    .measure(it, style, constraints = Constraints(maxWidth = textWidth))
                    .size
                    .height
            } ?: 0
        }
    // The native outline's minimum includes its supporting slot. Keep both in sync while animating.
    return animateDpAsState(with(density) { maxOf(reservedPixels, errorPixels).toDp() }).value
}

@Composable
private fun WorkflowChoice(
    label: Int,
    options: List<String>,
    selected: Int,
    enabled: Boolean,
    pick: (Int) -> Unit,
) {
    val title = stringResource(label)
    Box {
        SettingsTrigger(
            enabled = enabled,
            content = { dismiss ->
                WorkspaceMenu(
                    items =
                        options.mapIndexed { index, option ->
                            WorkspaceMenuItem(option, selected = index == selected) {
                                dismiss()
                                if (index != selected) pick(index)
                            }
                        },
                    close = dismiss,
                )
            },
        ) { trigger, open ->
            OkouOutlinedSelectionField(title, options[selected], trigger, enabled, onClick = open)
        }
    }
}

@Composable
private fun WorkflowTimezone(current: String, enabled: Boolean, pick: (String) -> Unit) {
    val title = stringResource(R.string.workflow_timezone)
    Box {
        SettingsTrigger(
            enabled = enabled,
            content = { dismiss -> TimezoneSelectionSheet(current, title, dismiss, pick) },
        ) { trigger, open ->
            OkouOutlinedSelectionField(
                title,
                timezoneLabel(current),
                trigger.testTag("workflow_timezone"),
                enabled,
                onClick = open,
            )
        }
    }
}

@Composable
private fun WorkflowTime(value: String, enabled: Boolean, pick: (String) -> Unit) {
    val context = LocalContext.current
    val dark = LocalOkouDarkMode.current
    val latestPick by rememberUpdatedState(pick)
    var showing by remember { mutableStateOf(false) }
    if (showing && enabled) {
        DisposableEffect(context, dark) {
            val (hour, minute) = value.split(":").map(String::toInt)
            val theme =
                if (dark) android.R.style.Theme_Material_Dialog_Alert
                else android.R.style.Theme_Material_Light_Dialog_Alert
            val dialog =
                TimePickerDialog(
                    context,
                    theme,
                    { _, pickedHour, pickedMinute ->
                        latestPick(
                            String.format(Locale.ROOT, "%02d:%02d", pickedHour, pickedMinute),
                        )
                    },
                    hour,
                    minute,
                    AndroidDateFormat.is24HourFormat(context),
                )
            dialog.setOnDismissListener { showing = false }
            dialog.show()
            onDispose {
                dialog.setOnDismissListener(null)
                dialog.dismiss()
            }
        }
    }
    OkouOutlinedSelectionField(
        stringResource(R.string.workflow_time),
        value,
        enabled = enabled,
        icon = R.drawable.ic_schedule,
        onClick = { showing = true },
    )
}
