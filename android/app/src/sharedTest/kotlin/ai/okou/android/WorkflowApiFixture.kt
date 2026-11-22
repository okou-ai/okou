package ai.okou.android

import ai.okou.android.chat.plainDraftDocument
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.RecordedRequest
import org.junit.Assert.assertNull

internal const val WORKFLOW_RELEASE = "a1111111-1111-4111-8111-111111111111"
internal const val WORKFLOW_SHARED = "a2222222-2222-4222-8222-222222222222"
private const val WORKFLOW_FEEDBACK = "a3333333-3333-4333-8333-333333333333"

internal class WorkflowApiFixture(private val chinese: Boolean = false) : AutoCloseable {
    val chats = ChatListApiFixture()
    val service = chats.service
    val requests = CopyOnWriteArrayList<RecordedRequest>()
    val active = AtomicBoolean(false)
    val gmailEnabled = AtomicBoolean(false)
    val gmailConnected = AtomicBoolean(false)
    @Volatile var beforeCatalog: () -> Unit = {}
    @Volatile var beforeConnectionsRead: () -> Unit = {}
    @Volatile var beforeDraftRead: () -> Unit = {}
    @Volatile var previousDraft = if (chinese) "保留原有草稿" else "Keep my existing draft"
    @Volatile
    var instruction =
        if (chinese) "1. 核对发布文案和产品说明。\n2. 查看官网、邮件和社区素材，列出缺项。\n3. 汇总负责人、发布时间和要确认的阻塞项。"
        else
            "Review launch copy and product notes.\nCheck the website, email, and community assets."
    val releaseTitle = if (chinese) "发布检查流程" else "Release checklist"
    val sharedTitle = if (chinese) "发布后跟进" else "Release follow-up"
    private val feedbackTitle = if (chinese) "客户反馈汇总" else "Customer feedback"
    val releasePurpose =
        if (chinese) "按渠道核对发布文案、素材与上线安排。" else "Check launch copy, assets, and timing by channel."
    val ruleTitle = if (chinese) "工作日 09:00" else "Weekdays at 09:00"

    init {
        chats.commandResponse = ::respond
    }

    private fun respond(request: RecordedRequest): MockResponse? {
        requests += request
        val path = request.requestUrl?.encodedPath
        return when (path) {
            "/api/connectors/connected" -> {
                beforeConnectionsRead()
                val gmail =
                    if (gmailConnected.get())
                        """{"slug":"gmail","label":"Gmail","icon":{"url":"/gmail.svg","invertInDarkMode":false},"hasPermissions":true}"""
                    else ""
                jsonResponse("""{"builtinConnectors":[$gmail],"customConnectors":[]}""")
            }
            "/api/workflows" -> {
                assertNull(request.requestUrl?.query)
                beforeCatalog()
                jsonResponse("[${release()},${shared()},${feedback()}]")
            }
            "/api/workflows/$WORKFLOW_RELEASE" -> {
                if (request.method == "PATCH") {
                    val body = Json.parseToJsonElement(request.body.clone().readUtf8()).jsonObject
                    body["instruction"]?.jsonPrimitive?.content?.let { instruction = it }
                }
                jsonResponse(detail(release(), instruction, "[${schedule()},${gmail()}]"))
            }
            "/api/workflows/$WORKFLOW_SHARED" ->
                jsonResponse(
                    detail(shared(), if (chinese) "整理发布发现。" else "Collect launch findings.", "[]")
                )
            "/api/workflow-automations" ->
                jsonResponse(
                    """[{"workflow":${release()},"automation":${schedule()}},{"workflow":${release()},"automation":${gmail()}},{"workflow":${feedback()},"automation":${schedule(id = "feedback", enabled = true)}}]"""
                )
            "/api/workflow-automations/weekday/enable" -> {
                active.set(true)
                jsonResponse(schedule())
            }
            "/api/workflow-automations/weekday/disable" -> {
                active.set(false)
                jsonResponse(schedule())
            }
            "/api/onboarding/status" ->
                jsonResponse(
                    """{"needsOnboarding":false,"onboardingComplete":true,"isAdmin":false,"hasOrg":true}"""
                )
            "/api/chat-drafts/composer" -> {
                if (request.method == "GET") {
                    beforeDraftRead()
                    jsonResponse(plainDraftDocument(previousDraft).toString())
                } else {
                    previousDraft =
                        Json.parseToJsonElement(request.body.clone().readUtf8())
                            .jsonObject["draftUserMessage"]
                            ?.jsonObject
                            ?.let { document -> document.toString() }
                            ?.let { document ->
                                // Read through the same wire format as a normal draft response.
                                Json.decodeFromString<DraftFixtureMessage>(document)
                                    .parts
                                    .single()
                                    .text
                            }
                            .orEmpty()
                    MockResponse().setResponseCode(204)
                }
            }
            else -> null
        }
    }

    private fun release() =
        summary(WORKFLOW_RELEASE, "release-review", releaseTitle, releasePurpose)

    private fun shared() =
        summary(
            WORKFLOW_SHARED,
            "release-follow-up",
            sharedTitle,
            if (chinese) "整理发布表现和回访待办。" else "Review launch performance and follow-up tasks.",
            visibility = "public",
            manage = false,
        )

    private fun feedback() =
        summary(
            WORKFLOW_FEEDBACK,
            "customer-feedback",
            feedbackTitle,
            if (chinese) "归类当天的客户反馈，整理跟进项。"
            else "Summarize today's feedback and track action items.",
        )

    private fun summary(
        id: String,
        name: String,
        title: String,
        purpose: String,
        visibility: String = "private",
        manage: Boolean = true,
    ) =
        """{"id":"$id","name":"$name","displayName":"$title","description":"$purpose","visibility":"$visibility","ownerUserId":"user-a","createdAt":"$CHAT_DATE","canManage":$manage,"canPublish":$manage,"official":null,"shadowedBy":null,"importSource":null}"""

    private fun detail(summary: String, instruction: String, automations: String) =
        summary.dropLast(1) +
            ""","createdByUserId":"user-a","updatedByUserId":"user-a","updatedAt":"$CHAT_DATE","instruction":${Json.encodeToString(instruction)},"files":null,"fileContents":null,"automations":$automations}"""

    private fun schedule(id: String = "weekday", enabled: Boolean = active.get()): String {
        val next = if (enabled) """"2026-11-23T01:00:00.000Z"""" else "null"
        return """{"id":"$id","ownerUserId":"user-a","enabled":$enabled,"chatThreadId":"$CHAT_PERSONAL","nextRunAt":$next,"lastRunAt":"2026-11-20T01:00:00.000Z","official":null,"kind":"schedule","schedule":{"type":"cron","cronExpression":"0 9 * * 1-5","timezone":"Asia/Shanghai"},"scheduleSummary":"Weekdays at 09:00"}"""
    }

    private fun gmail() =
        """{"id":"gmail","ownerUserId":"user-a","enabled":${gmailEnabled.get()},"chatThreadId":null,"nextRunAt":null,"lastRunAt":null,"official":null,"kind":"event","eventType":"gmail-new-message","eventConfig":{"provider":"gmail","event":"new_message","match":{"subject":{"contains":"${if (chinese) "发布" else "Release"}"}}},"schedule":null,"scheduleSummary":null}"""

    override fun close() = chats.close()
}

@kotlinx.serialization.Serializable
private data class DraftFixtureMessage(val version: Int, val parts: List<DraftFixturePart>)

@kotlinx.serialization.Serializable
private data class DraftFixturePart(val type: String, val text: String)
