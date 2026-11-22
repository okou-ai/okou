package ai.okou.android.workflows

import ai.okou.android.R
import ai.okou.android.api.generated.CanonicalOptional
import ai.okou.android.api.generated.CreateWorkflowAutomationRequest
import ai.okou.android.api.generated.CreateWorkflowAutomationRequestVariant1
import ai.okou.android.api.generated.CreateWorkflowAutomationRequestVariant11
import ai.okou.android.api.generated.CreateWorkflowAutomationRequestVariant11EventConfig
import ai.okou.android.api.generated.CreateWorkflowAutomationRequestVariant11EventConfigEvent
import ai.okou.android.api.generated.CreateWorkflowAutomationRequestVariant11EventConfigProvider
import ai.okou.android.api.generated.CreateWorkflowAutomationRequestVariant11EventType
import ai.okou.android.api.generated.CreateWorkflowAutomationRequestVariant11Kind
import ai.okou.android.api.generated.CreateWorkflowAutomationRequestVariant1ScheduleVariant1
import ai.okou.android.api.generated.CreateWorkflowAutomationRequestVariant1ScheduleVariant1Type
import ai.okou.android.api.generated.CreateWorkflowAutomationRequestVariant3
import ai.okou.android.api.generated.CreateWorkflowAutomationRequestVariant3EventConfig
import ai.okou.android.api.generated.CreateWorkflowAutomationRequestVariant3EventConfigEvent
import ai.okou.android.api.generated.CreateWorkflowAutomationRequestVariant3EventConfigMatch
import ai.okou.android.api.generated.CreateWorkflowAutomationRequestVariant3EventConfigMatchSubject
import ai.okou.android.api.generated.CreateWorkflowAutomationRequestVariant3EventConfigProvider
import ai.okou.android.api.generated.CreateWorkflowAutomationRequestVariant3EventType
import ai.okou.android.api.generated.CreateWorkflowAutomationRequestVariant3Kind
import ai.okou.android.api.generated.UpdateWorkflowAutomationRequest
import ai.okou.android.api.generated.UpdateWorkflowAutomationRequestVariant1
import ai.okou.android.api.generated.UpdateWorkflowAutomationRequestVariant1ScheduleVariant1
import ai.okou.android.api.generated.UpdateWorkflowAutomationRequestVariant1ScheduleVariant1Type
import ai.okou.android.api.generated.UpdateWorkflowAutomationRequestVariant2
import ai.okou.android.api.generated.UpdateWorkflowAutomationRequestVariant2EventConfigVariant1
import ai.okou.android.api.generated.UpdateWorkflowAutomationRequestVariant2EventConfigVariant1Event
import ai.okou.android.api.generated.UpdateWorkflowAutomationRequestVariant2EventConfigVariant1Match
import ai.okou.android.api.generated.UpdateWorkflowAutomationRequestVariant2EventConfigVariant1MatchSubject
import ai.okou.android.api.generated.UpdateWorkflowAutomationRequestVariant2EventConfigVariant1Provider
import ai.okou.android.api.generated.UpdateWorkflowAutomationRequestVariant4
import ai.okou.android.api.generated.UpdateWorkflowAutomationRequestVariant4EventConfigVariant1
import ai.okou.android.api.generated.UpdateWorkflowAutomationRequestVariant4EventConfigVariant1Event
import ai.okou.android.api.generated.UpdateWorkflowAutomationRequestVariant4EventConfigVariant1Provider
import ai.okou.android.api.generated.UpdateWorkflowRequest
import ai.okou.android.api.generated.WorkflowAutomation
import ai.okou.android.api.generated.WorkflowAutomationVariant1
import ai.okou.android.api.generated.WorkflowAutomationVariant10
import ai.okou.android.api.generated.WorkflowAutomationVariant11
import ai.okou.android.api.generated.WorkflowAutomationVariant12
import ai.okou.android.api.generated.WorkflowAutomationVariant13
import ai.okou.android.api.generated.WorkflowAutomationVariant14
import ai.okou.android.api.generated.WorkflowAutomationVariant15
import ai.okou.android.api.generated.WorkflowAutomationVariant16
import ai.okou.android.api.generated.WorkflowAutomationVariant17
import ai.okou.android.api.generated.WorkflowAutomationVariant18
import ai.okou.android.api.generated.WorkflowAutomationVariant19
import ai.okou.android.api.generated.WorkflowAutomationVariant1ScheduleVariant1
import ai.okou.android.api.generated.WorkflowAutomationVariant2
import ai.okou.android.api.generated.WorkflowAutomationVariant3
import ai.okou.android.api.generated.WorkflowAutomationVariant4
import ai.okou.android.api.generated.WorkflowAutomationVariant5
import ai.okou.android.api.generated.WorkflowAutomationVariant6
import ai.okou.android.api.generated.WorkflowAutomationVariant7
import ai.okou.android.api.generated.WorkflowAutomationVariant8
import ai.okou.android.api.generated.WorkflowAutomationVariant9
import ai.okou.android.api.generated.WorkflowDetail
import androidx.annotation.DrawableRes
import androidx.annotation.StringRes
import java.util.Locale

internal enum class RuleSource(
    @StringRes val label: Int,
    @DrawableRes val icon: Int,
    val connector: String? = null,
) {
    Schedule(R.string.workflow_schedule, R.drawable.ic_event),
    Chat(R.string.workflow_chat, R.drawable.ic_chat_bubble),
    Gmail(R.string.workflow_gmail, R.drawable.ic_mail, "gmail"),
    // The enable endpoint validates the workspace's GitHub App installation.
    Github(R.string.workflow_github, R.drawable.ic_bolt),
    Calendar(R.string.workflow_calendar, R.drawable.ic_event, "google-calendar"),
    Forms(R.string.workflow_forms, R.drawable.ic_bolt, "google-forms"),
    Meet(R.string.workflow_meet, R.drawable.ic_bolt, "google-meet"),
    Notion(R.string.workflow_notion, R.drawable.ic_bolt, "notion"),
    Webhook(R.string.workflow_webhook, R.drawable.ic_bolt);

    fun needsConnection(connected: Set<String>?): Boolean =
        connector != null && connected != null && connector !in connected
}

internal val WorkflowAutomation.source: RuleSource
    get() =
        when (this) {
            is WorkflowAutomationVariant1 -> RuleSource.Schedule
            is WorkflowAutomationVariant2 -> RuleSource.Chat
            is WorkflowAutomationVariant3,
            is WorkflowAutomationVariant4 -> RuleSource.Gmail
            is WorkflowAutomationVariant5,
            is WorkflowAutomationVariant6,
            is WorkflowAutomationVariant7,
            is WorkflowAutomationVariant8,
            is WorkflowAutomationVariant9,
            is WorkflowAutomationVariant10 -> RuleSource.Github
            is WorkflowAutomationVariant11,
            is WorkflowAutomationVariant12,
            is WorkflowAutomationVariant13 -> RuleSource.Calendar
            is WorkflowAutomationVariant14 -> RuleSource.Forms
            is WorkflowAutomationVariant15 -> RuleSource.Meet
            is WorkflowAutomationVariant16,
            is WorkflowAutomationVariant17,
            is WorkflowAutomationVariant18 -> RuleSource.Notion
            is WorkflowAutomationVariant19 -> RuleSource.Webhook
        }

internal val WorkflowAutomation.eventLabel: Int
    get() =
        when (this) {
            is WorkflowAutomationVariant1 -> R.string.workflow_schedule
            is WorkflowAutomationVariant2 -> R.string.workflow_chat_finished
            is WorkflowAutomationVariant3 -> R.string.workflow_mail_received
            is WorkflowAutomationVariant4 -> R.string.workflow_mail_labeled
            is WorkflowAutomationVariant5 -> R.string.workflow_github_deployed
            is WorkflowAutomationVariant6 -> R.string.workflow_github_commented
            is WorkflowAutomationVariant7 -> R.string.workflow_github_pr
            is WorkflowAutomationVariant8 -> R.string.workflow_github_reviewed
            is WorkflowAutomationVariant9 -> R.string.workflow_github_job
            is WorkflowAutomationVariant10 -> R.string.workflow_github_run
            is WorkflowAutomationVariant11 -> R.string.workflow_event_created
            is WorkflowAutomationVariant12 -> R.string.workflow_event_updated
            is WorkflowAutomationVariant13 -> R.string.workflow_event_cancelled
            is WorkflowAutomationVariant14 -> R.string.workflow_form_submitted
            is WorkflowAutomationVariant15 -> R.string.workflow_transcript
            is WorkflowAutomationVariant16 -> R.string.workflow_notion_child
            is WorkflowAutomationVariant17 -> R.string.workflow_notion_item
            is WorkflowAutomationVariant18 -> R.string.workflow_notion_updated
            is WorkflowAutomationVariant19 -> R.string.workflow_webhook
        }

internal fun WorkflowAutomation.needsConnection(connected: Set<String>?): Boolean =
    source.needsConnection(connected) ||
        when (this) {
            is WorkflowAutomationVariant11 -> warning?.name == "RECONNECT_REQUIRED"
            is WorkflowAutomationVariant12 -> warning?.name == "RECONNECT_REQUIRED"
            is WorkflowAutomationVariant13 -> warning?.name == "RECONNECT_REQUIRED"
            else -> false
        }

internal fun WorkflowAutomation.canEnable(connected: Set<String>?): Boolean =
    (source.connector == null || connected != null) && !needsConnection(connected)

internal fun WorkflowAutomation.githubRepositorySummary(): String? =
    when (this) {
            is WorkflowAutomationVariant5 -> eventConfig.filters.repositories
            is WorkflowAutomationVariant6 -> eventConfig.filters.repositories
            is WorkflowAutomationVariant7 -> listOf(eventConfig.repository)
            is WorkflowAutomationVariant8 -> eventConfig.filters.repositories
            is WorkflowAutomationVariant9 -> eventConfig.filters.repositories
            is WorkflowAutomationVariant10 -> eventConfig.filters.repositories
            else -> null
        }
        ?.takeIf { it.isNotEmpty() }
        ?.joinToString()

// The workflow detail endpoint includes only the caller's automations.
internal fun WorkflowDetail.canChange(ruleId: String?): Boolean =
    if (ruleId == null) canManage else automations.any { it.id == ruleId && it.official == null }

internal sealed interface WorkflowEdit {
    val changed: Boolean

    data class Instructions(
        val original: InstructionsFields,
        val value: InstructionsFields = original,
    ) : WorkflowEdit {
        override val changed
            get() = original != value
    }

    data class Rule(
        val id: String?,
        val original: RuleFields,
        val value: RuleFields = original,
        val enabled: Boolean = false,
    ) : WorkflowEdit {
        override val changed
            get() = original != value

        val canSave
            get() = (id == null || changed) && value.valid

        fun blockingConnection(detail: WorkflowDetail, connected: Set<String>?): RuleSource? {
            val source = value.trigger.source
            if (
                source.connector != null && (connected == null || source.needsConnection(connected))
            )
                return source
            return detail.automations
                .firstOrNull { it.id == id && !it.canEnable(connected) }
                ?.source
        }
    }
}

internal const val WORKFLOW_DISPLAY_NAME_LIMIT = 256
internal const val WORKFLOW_PURPOSE_LIMIT = 1024
internal const val WORKFLOW_INSTRUCTION_LIMIT = 5 * 1024 * 1024

internal data class InstructionsFields(
    val title: String,
    val purpose: String,
    val instruction: String,
) {
    val valid
        get() =
            title.length <= WORKFLOW_DISPLAY_NAME_LIMIT &&
                title.isNotBlank() &&
                purpose.length <= WORKFLOW_PURPOSE_LIMIT &&
                instruction.length <= WORKFLOW_INSTRUCTION_LIMIT

    fun changesFrom(original: InstructionsFields) =
        UpdateWorkflowRequest(
            displayName = changedText(original.title, title),
            description = changedText(original.purpose, purpose),
            instruction = changedText(original.instruction, instruction),
        )
}

private fun changedText(before: String, after: String): CanonicalOptional<String?> =
    if (after == before) CanonicalOptional.Absent else CanonicalOptional.Present(after)

internal fun WorkflowDetail.editableInstructions() =
    WorkflowEdit.Instructions(
        InstructionsFields(displayName ?: name, description.orEmpty(), instruction.orEmpty())
    )

internal enum class EditableTrigger(val source: RuleSource) {
    Schedule(RuleSource.Schedule),
    Gmail(RuleSource.Gmail),
    Calendar(RuleSource.Calendar),
}

internal data class RuleFields(
    val trigger: EditableTrigger = EditableTrigger.Schedule,
    val weekdays: Boolean = true,
    val time: String = "09:00",
    val timezone: String,
    val subject: String = "",
    val calendarId: String = "primary",
) {
    val valid
        get() =
            when (trigger) {
                EditableTrigger.Schedule -> ruleTime.matches(time) && timezone.isNotBlank()
                EditableTrigger.Gmail -> subject.isNotBlank()
                EditableTrigger.Calendar -> calendarId.isNotBlank() && calendarId.length <= 1024
            }

    private fun cron(): String {
        val (hour, minute) = time.split(":").map(String::toInt)
        return "$minute $hour * * ${if (weekdays) "1-5" else "*"}"
    }

    fun createRequest(): CreateWorkflowAutomationRequest =
        when (trigger) {
            EditableTrigger.Schedule ->
                CreateWorkflowAutomationRequestVariant1(
                    schedule =
                        CreateWorkflowAutomationRequestVariant1ScheduleVariant1(
                            CreateWorkflowAutomationRequestVariant1ScheduleVariant1Type.CRON,
                            cron(),
                            timezone,
                        ),
                    enabled = false,
                )
            EditableTrigger.Gmail ->
                CreateWorkflowAutomationRequestVariant3(
                    CreateWorkflowAutomationRequestVariant3Kind.EVENT,
                    CreateWorkflowAutomationRequestVariant3EventType.GMAIL_NEW_MESSAGE,
                    CreateWorkflowAutomationRequestVariant3EventConfig(
                        CreateWorkflowAutomationRequestVariant3EventConfigProvider.GMAIL,
                        CreateWorkflowAutomationRequestVariant3EventConfigEvent.NEW_MESSAGE,
                        match =
                            CreateWorkflowAutomationRequestVariant3EventConfigMatch(
                                subject =
                                    CreateWorkflowAutomationRequestVariant3EventConfigMatchSubject(
                                        contains = subject
                                    )
                            ),
                    ),
                    enabled = false,
                )
            EditableTrigger.Calendar ->
                CreateWorkflowAutomationRequestVariant11(
                    CreateWorkflowAutomationRequestVariant11Kind.EVENT,
                    CreateWorkflowAutomationRequestVariant11EventType.GOOGLE_CALENDAR_EVENT_CREATED,
                    CreateWorkflowAutomationRequestVariant11EventConfig(
                        CreateWorkflowAutomationRequestVariant11EventConfigProvider.GOOGLE_CALENDAR,
                        CreateWorkflowAutomationRequestVariant11EventConfigEvent.EVENT_CREATED,
                        calendarId.trim(),
                    ),
                    enabled = false,
                )
        }

    fun updateRequest(): UpdateWorkflowAutomationRequest =
        when (trigger) {
            EditableTrigger.Schedule ->
                UpdateWorkflowAutomationRequestVariant1(
                    UpdateWorkflowAutomationRequestVariant1ScheduleVariant1(
                        UpdateWorkflowAutomationRequestVariant1ScheduleVariant1Type.CRON,
                        cron(),
                        timezone,
                    )
                )
            EditableTrigger.Gmail ->
                UpdateWorkflowAutomationRequestVariant2(
                    UpdateWorkflowAutomationRequestVariant2EventConfigVariant1(
                        UpdateWorkflowAutomationRequestVariant2EventConfigVariant1Provider.GMAIL,
                        UpdateWorkflowAutomationRequestVariant2EventConfigVariant1Event.NEW_MESSAGE,
                        match =
                            UpdateWorkflowAutomationRequestVariant2EventConfigVariant1Match(
                                subject =
                                    UpdateWorkflowAutomationRequestVariant2EventConfigVariant1MatchSubject(
                                        contains = subject
                                    )
                            ),
                    )
                )
            EditableTrigger.Calendar ->
                UpdateWorkflowAutomationRequestVariant4(
                    UpdateWorkflowAutomationRequestVariant4EventConfigVariant1(
                        UpdateWorkflowAutomationRequestVariant4EventConfigVariant1Provider
                            .GOOGLE_CALENDAR,
                        UpdateWorkflowAutomationRequestVariant4EventConfigVariant1Event
                            .EVENT_CREATED,
                        calendarId.trim(),
                    )
                )
        }
}

private val ruleTime = Regex("(?:[01][0-9]|2[0-3]):[0-5][0-9]")

internal fun WorkflowAutomationVariant1ScheduleVariant1.simpleRule(): RuleFields? {
    val parts = cronExpression.trim().split(Regex("\\s+"))
    if (parts.size != 5 || parts[2] != "*" || parts[3] != "*" || parts[4] !in setOf("*", "1-5"))
        return null
    val minute = parts[0].toIntOrNull()?.takeIf { it in 0..59 } ?: return null
    val hour = parts[1].toIntOrNull()?.takeIf { it in 0..23 } ?: return null
    return RuleFields(
        weekdays = parts[4] == "1-5",
        time = String.format(Locale.ROOT, "%02d:%02d", hour, minute),
        timezone = timezone,
    )
}

internal fun WorkflowAutomation.editableRule(timezone: String): WorkflowEdit.Rule? {
    if (official != null) return null
    val fields =
        when (this) {
            is WorkflowAutomationVariant1 ->
                (schedule as? WorkflowAutomationVariant1ScheduleVariant1)?.simpleRule()
            is WorkflowAutomationVariant3 -> {
                val match = eventConfig.match
                val subject = match?.subject
                if (
                    eventConfig.threadId != null ||
                        match?.from != null ||
                        match?.body != null ||
                        match?.to != null ||
                        match?.cc != null ||
                        subject?.containsAny != null ||
                        subject?.doesNotContain != null ||
                        subject?.doesNotContainAny != null
                )
                    null
                else
                    RuleFields(
                        trigger = EditableTrigger.Gmail,
                        timezone = timezone,
                        subject = subject?.contains.orEmpty(),
                    )
            }
            is WorkflowAutomationVariant11 ->
                RuleFields(
                    trigger = EditableTrigger.Calendar,
                    timezone = timezone,
                    calendarId = eventConfig.calendarId,
                )
            else -> null
        }
    return fields?.let { WorkflowEdit.Rule(id, it, enabled = enabled) }
}
