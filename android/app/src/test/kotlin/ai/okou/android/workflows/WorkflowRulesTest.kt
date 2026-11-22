package ai.okou.android.workflows

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.encodeToJsonElement
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class WorkflowRulesTest {
    @Test
    fun newScheduleIsPausedAndUsesLocalWallTime() {
        val rule = RuleFields(time = "09:35", timezone = "Asia/Shanghai")
        val body = Json.encodeToJsonElement(rule.createRequest())
        assertEquals(
            Json.parseToJsonElement(
                """{"schedule":{"type":"cron","cronExpression":"35 9 * * 1-5","timezone":"Asia/Shanghai"},"enabled":false}"""
            ),
            body,
        )
    }

    @Test
    fun eventRuleUpdatesSendOnlyTheEditableConfiguration() {
        val gmail =
            RuleFields(trigger = EditableTrigger.Gmail, subject = " Release ", timezone = "UTC")
        assertEquals(
            Json.parseToJsonElement(
                """{"eventConfig":{"provider":"gmail","event":"new_message","match":{"subject":{"contains":" Release "}}}}"""
            ),
            Json.encodeToJsonElement(gmail.updateRequest()),
        )

        val calendar =
            RuleFields(trigger = EditableTrigger.Calendar, calendarId = "primary", timezone = "UTC")
        assertEquals(
            Json.parseToJsonElement(
                """{"eventConfig":{"provider":"google-calendar","event":"event_created","calendarId":"primary"}}"""
            ),
            Json.encodeToJsonElement(calendar.updateRequest()),
        )
    }

    @Test
    fun workflowMetadataCanBeEditedWithoutAnInstruction() {
        assertTrue(
            InstructionsFields(title = "Release review", purpose = "Check copy", instruction = "")
                .valid
        )
    }
}
