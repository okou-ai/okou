package ai.okou.android

import ai.okou.android.chat.plainDraftDocument
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.RecordedRequest
import okhttp3.mockwebserver.SocketPolicy
import org.junit.Assert.assertNull

internal const val WORKFLOW_RELEASE = "a1111111-1111-4111-8111-111111111111"
internal const val WORKFLOW_SHARED = "a2222222-2222-4222-8222-222222222222"
private const val WORKFLOW_FEEDBACK = "a3333333-3333-4333-8333-333333333333"

internal class WorkflowApiFixture(
    private val chinese: Boolean = false,
    val chats: ChatListApiFixture = ChatListApiFixture(),
) : AutoCloseable {
    val service = chats.service
    val requests = CopyOnWriteArrayList<RecordedRequest>()
    val active = AtomicBoolean(false)
    val gmailEnabled = AtomicBoolean(false)
    val gmailConnected = AtomicBoolean(false)
    private val githubEnabled = AtomicBoolean(false)
    private val sharedScheduleEnabled = AtomicBoolean(true)
    @Volatile private var sharedScheduleCron = "0 9 * * 1-5"
    @Volatile var githubAppInstalled: Boolean? = null
    @Volatile var githubAccountConnected = false
    @Volatile var hasSharedSchedule = false
    @Volatile var calendarId: String? = null
    @Volatile var beforeCatalog: () -> Unit = {}
    @Volatile var beforeReleaseDetailRead: () -> Unit = {}
    @Volatile var beforeConnectionsRead: () -> Unit = {}
    @Volatile var beforeDraftRead: () -> Unit = {}
    @Volatile var beforeInstructionSave: () -> Unit = {}
    @Volatile var disconnectDraftRead = false
    @Volatile var disconnectInstructionSave = false
    @Volatile var instructionSaveConflict = false
    @Volatile var previousDraft = if (chinese) "保留原有草稿" else "Keep my existing draft"
    @Volatile
    var instruction =
        if (chinese) "1. 核对发布文案和产品说明。\n2. 查看官网、邮件和社区素材，列出缺项。\n3. 汇总负责人、发布时间和要确认的阻塞项。"
        else
            "Review launch copy and product notes.\nCheck the website, email, and community assets."
    @Volatile var releaseTitle = if (chinese) "发布检查流程" else "Release checklist"
    val sharedTitle = if (chinese) "发布后跟进" else "Release follow-up"
    private val feedbackTitle = if (chinese) "客户反馈汇总" else "Customer feedback"
    val releasePurpose =
        if (chinese) "按渠道核对发布文案、素材与上线安排。" else "Check launch copy, assets, and timing by channel."
    val ruleTitle = if (chinese) "工作日 09:00" else "Weekdays at 09:00"

    init {
        val composerResponse = chats.commandResponse
        chats.commandResponse = { request -> respond(request) ?: composerResponse(request) }
    }

    private fun respond(request: RecordedRequest): MockResponse? {
        requests += request
        val path = request.requestUrl?.encodedPath
        return when (path) {
            "/api/connectors/connected" -> {
                beforeConnectionsRead()
                val connectors = buildList {
                    if (gmailConnected.get()) add(connector("gmail", "Gmail"))
                    if (githubAccountConnected) add(connector("github", "GitHub"))
                    if (calendarId != null) add(connector("google-calendar", "Google Calendar"))
                }
                jsonResponse(
                    """{"builtinConnectors":[${connectors.joinToString()}],"customConnectors":[]}"""
                )
            }
            "/api/workflows" -> {
                assertNull(request.requestUrl?.query)
                beforeCatalog()
                jsonResponse("[${release()},${shared()},${feedback()},${official()}]")
            }
            "/api/workflows/$WORKFLOW_RELEASE" -> {
                if (request.method == "GET") beforeReleaseDetailRead()
                if (request.method == "PATCH") {
                    beforeInstructionSave()
                    if (disconnectInstructionSave)
                        return MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST)
                    if (instructionSaveConflict)
                        return jsonResponse(
                                """{"error":{"code":"CONFLICT","message":"Workflow changed during update; retry the request"}}"""
                            )
                            .setResponseCode(409)
                    val body = Json.parseToJsonElement(request.body.clone().readUtf8()).jsonObject
                    body["displayName"]?.jsonPrimitive?.content?.let { releaseTitle = it }
                    body["instruction"]?.jsonPrimitive?.content?.let { instruction = it }
                }
                jsonResponse(detail(release(), instruction, "[${releaseRules().joinToString()}]"))
            }
            "/api/workflows/$WORKFLOW_SHARED" ->
                jsonResponse(
                    detail(
                        shared(),
                        if (chinese) "整理发布发现。" else "Collect launch findings.",
                        if (hasSharedSchedule) "[${sharedSchedule()}]" else "[]",
                    )
                )
            "/api/workflow-automations" -> {
                val rules = buildList {
                    releaseRules().forEach { add(automationEntry(release(), it)) }
                    if (hasSharedSchedule) add(automationEntry(shared(), sharedSchedule()))
                    add(automationEntry(feedback(), schedule(id = "feedback", enabled = true)))
                }
                jsonResponse(rules.joinToString(prefix = "[", postfix = "]"))
            }
            "/api/workflow-automations/weekday/enable" -> {
                active.set(true)
                jsonResponse(schedule())
            }
            "/api/workflow-automations/weekday/disable" -> {
                active.set(false)
                jsonResponse(schedule())
            }
            "/api/workflow-automations/shared-weekday/enable",
            "/api/workflow-automations/shared-weekday/disable" -> {
                sharedScheduleEnabled.set(path.endsWith("/enable"))
                jsonResponse(sharedSchedule())
            }
            "/api/workflow-automations/shared-weekday" -> {
                val body = Json.parseToJsonElement(request.body.clone().readUtf8()).jsonObject
                sharedScheduleCron =
                    body
                        .getValue("schedule")
                        .jsonObject
                        .getValue("cronExpression")
                        .jsonPrimitive
                        .content
                jsonResponse(sharedSchedule())
            }
            "/api/workflow-automations/calendar-created" -> {
                val body = Json.parseToJsonElement(request.body.clone().readUtf8()).jsonObject
                val savedId =
                    body
                        .getValue("eventConfig")
                        .jsonObject
                        .getValue("calendarId")
                        .jsonPrimitive
                        .content
                calendarId = savedId
                jsonResponse(calendar(savedId))
            }
            "/api/workflow-automations/github/enable" -> {
                if (githubAppInstalled == true) {
                    githubEnabled.set(true)
                    jsonResponse(github())
                } else {
                    jsonResponse(
                            """{"error":{"code":"BAD_REQUEST","message":"Install GitHub before creating GitHub webhook automations"}}"""
                        )
                        .setResponseCode(400)
                }
            }
            "/api/onboarding/status" ->
                jsonResponse(
                    """{"needsOnboarding":false,"onboardingComplete":true,"isAdmin":false,"hasOrg":true}"""
                )
            "/api/chat-drafts/composer" -> {
                if (request.method == "GET") {
                    beforeDraftRead()
                    if (disconnectDraftRead)
                        return MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST)
                    jsonResponse(plainDraftDocument(previousDraft).toString())
                } else {
                    val document =
                        Json.parseToJsonElement(request.body.clone().readUtf8())
                            .jsonObject["draftUserMessage"]
                            as? JsonObject
                    previousDraft =
                        document
                            ?.let {
                                // Read through the same wire format as a normal draft response.
                                Json.decodeFromString<DraftFixtureMessage>(it.toString())
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
            owner = "user-b",
        )

    private fun feedback() =
        summary(
            WORKFLOW_FEEDBACK,
            "customer-feedback",
            feedbackTitle,
            if (chinese) "归类当天的客户反馈，整理跟进项。"
            else "Summarize today's feedback and track action items.",
        )

    private fun official() =
        summary(
            "a4444444-4444-4444-8444-444444444444",
            "launch-official",
            "Official launch workflow",
            "Installed workflow",
            manage = false,
            official =
                """{"definitionName":"launch-official","installationState":"installed","definitionLifecycle":"active","readOnly":true}""",
        )

    private fun summary(
        id: String,
        name: String,
        title: String,
        purpose: String,
        visibility: String = "private",
        manage: Boolean = true,
        owner: String = "user-a",
        official: String = "null",
    ) =
        """{"id":"$id","name":"$name","displayName":"$title","description":"$purpose","visibility":"$visibility","ownerUserId":"$owner","createdAt":"$CHAT_DATE","canManage":$manage,"canPublish":$manage,"official":$official,"shadowedBy":null,"importSource":null}"""

    private fun detail(summary: String, instruction: String, automations: String) =
        summary.dropLast(1) +
            ""","createdByUserId":"user-a","updatedByUserId":"user-a","updatedAt":"$CHAT_DATE","instruction":${Json.encodeToString(instruction)},"files":null,"fileContents":null,"automations":$automations}"""

    private fun schedule(
        id: String = "weekday",
        enabled: Boolean = active.get(),
        cron: String = "0 9 * * 1-5",
    ): String {
        val next = if (enabled) """"2026-11-23T01:00:00.000Z"""" else "null"
        return """{"id":"$id","ownerUserId":"user-a","enabled":$enabled,"chatThreadId":"$CHAT_PERSONAL","nextRunAt":$next,"lastRunAt":"2026-11-20T01:00:00.000Z","official":null,"kind":"schedule","schedule":{"type":"cron","cronExpression":"$cron","timezone":"Asia/Shanghai"},"scheduleSummary":"Weekdays at 09:00"}"""
    }

    private fun sharedSchedule() =
        schedule("shared-weekday", sharedScheduleEnabled.get(), sharedScheduleCron)

    private fun automationEntry(workflow: String, rule: String) =
        """{"workflow":$workflow,"automation":$rule}"""

    private fun gmail() =
        """{"id":"gmail","ownerUserId":"user-a","enabled":${gmailEnabled.get()},"chatThreadId":null,"nextRunAt":null,"lastRunAt":null,"official":null,"kind":"event","eventType":"gmail-new-message","eventConfig":{"provider":"gmail","event":"new_message","match":{"subject":{"contains":"${if (chinese) "发布" else "Release"}"}}},"schedule":null,"scheduleSummary":null}"""

    private fun github() =
        """{"id":"github","ownerUserId":"user-a","enabled":${githubEnabled.get()},"chatThreadId":null,"nextRunAt":null,"lastRunAt":null,"official":null,"kind":"event","eventType":"github-pull-request","eventConfig":{"provider":"github","event":"pull_request","repository":"example/release","action":"opened","filters":{}},"schedule":null,"scheduleSummary":null}"""

    private fun calendar(id: String) =
        """{"id":"calendar-created","ownerUserId":"user-a","enabled":false,"chatThreadId":null,"nextRunAt":null,"lastRunAt":null,"official":null,"kind":"event","eventType":"google-calendar-event-created","eventConfig":{"provider":"google-calendar","event":"event_created","calendarId":${Json.encodeToString(id)}},"schedule":null,"scheduleSummary":null}"""

    private fun releaseRules() =
        listOfNotNull(
            schedule(),
            gmail(),
            githubAppInstalled?.let { github() },
            calendarId?.let(::calendar),
        )

    private fun connector(slug: String, label: String) =
        """{"slug":"$slug","label":"$label","icon":{"url":"/$slug.svg","invertInDarkMode":false},"hasPermissions":true}"""

    override fun close() = chats.close()
}

@kotlinx.serialization.Serializable
private data class DraftFixtureMessage(val version: Int, val parts: List<DraftFixturePart>)

@kotlinx.serialization.Serializable
private data class DraftFixturePart(val type: String, val text: String)
