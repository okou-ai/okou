package ai.okou.android.screenshots

import ai.okou.android.ArtifactApiFixture
import ai.okou.android.CHAT_DATE
import ai.okou.android.CHAT_IN_PROJECT
import ai.okou.android.CHAT_PERSONAL
import ai.okou.android.CHAT_PROJECT
import ai.okou.android.ChatCacheSnapshot
import ai.okou.android.HISTORY_LAST_EVENT
import ai.okou.android.HISTORY_RUN
import ai.okou.android.MainActivity
import ai.okou.android.R
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.WorkflowApiFixture
import ai.okou.android.awaitChatList
import ai.okou.android.chatEventWire
import ai.okou.android.historyEventWire
import ai.okou.android.jsonResponse
import ai.okou.android.testAuthenticationState
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.services.storage.TestStorage
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import java.util.UUID
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    @Test
    fun workspaceSearch() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val app = instrumentation.targetContext.applicationContext as TestOkouApplication
        val device = UiDevice.getInstance(instrumentation)
        val auth = app.authentication as TestAuthentication
        val originalAuth = auth.state.value
        val originalChats = app.chatService
        val originalSearch = app.searchService
        val originalComposer = app.composerService
        val originalWorkflows = app.workflows
        val originalConnectivity = app.connectivity.value
        val originalPreferences = app.snapshotApiPreferences()
        val originalCache =
            ChatCacheSnapshot(app.noBackupFilesDir.resolve("chat-list"), app.chatCache)
        val originalSize =
            device.executeShellCommand("wm size").substringAfter("Override size: ", "").trim()
        val originalDensity =
            device.executeShellCommand("wm density").substringAfter("Override density: ", "").trim()
        val workflows = WorkflowApiFixture()
        val fixture = workflows.chats
        val artifacts = ArtifactApiFixture(fixture).apply { install() }
        auth.state.value = testAuthenticationState(user = "workspace-search-${UUID.randomUUID()}")
        app.chatService = fixture.service
        app.searchService = fixture.service
        app.composerService = fixture.service
        app.workflows = fixture.service

        fun get(selector: BySelector) =
            checkNotNull(device.wait(Until.findObject(selector), 12_000)) {
                "Missing search acceptance control: $selector"
            }
        fun text(value: String) = get(By.pkg(app.packageName).text(value))
        fun contains(value: String) = get(By.pkg(app.packageName).textContains(value))
        fun label(id: Int) = app.getString(id)
        fun press(id: Int) = text(label(id)).click()
        fun button(id: Int) = get(By.pkg(app.packageName).desc(label(id)))
        fun field() =
            checkNotNull(
                device
                    .wait(
                        Until.findObjects(By.pkg(app.packageName).clazz("android.widget.EditText")),
                        12_000,
                    )
                    ?.minByOrNull { it.visibleBounds.left }
            ) {
                "The search input is not visible"
            }
        fun tab(id: Int) {
            val selector = By.pkg(app.packageName).text(label(id))
            val control =
                checkNotNull(device.wait(Until.findObjects(selector), 12_000)).minBy {
                    it.visibleBounds.top
                }
            control.click()
        }
        fun capture(name: String) {
            device.waitForIdle()
            ScreenshotCapture.capture(name)
        }

        val title = "Weekly launch brief"
        val projectTitle = "Launch assets"
        val earlierReply = "Earlier launch reply"
        val finalReply = "Final launch reply"
        val hiddenReply = "Unrelated process is hidden"
        val olderRun = "bc1564cb-c2d4-49b1-8758-fe4e6e403e32"
        fixture.events = { request ->
            if (request.requestUrl?.queryParameter("sinceSeqId") != null) {
                jsonResponse("""{"events":[],"hasMore":false}""")
            } else {
                val rows =
                    listOf(
                        chatEventWire(title = title),
                        chatEventWire(
                            id = "f4a88885-e53a-49a1-a52e-f29529f70ed3",
                            seq = 18,
                            thread = CHAT_IN_PROJECT,
                            title = projectTitle,
                            extra = ",\"projectId\":\"$CHAT_PROJECT\"",
                        ),
                    ) +
                        listOf("Launch checklist", "Launch announcement", "Launch notes")
                            .mapIndexed { index, name ->
                                chatEventWire(
                                    id = "66381000-3774-419f-8f42-00000000001$index",
                                    seq = (19 + index).toLong(),
                                    thread = "66381000-3774-419f-8f42-00000000002$index",
                                    title = name,
                                )
                            }
                jsonResponse("""{"events":[${rows.joinToString(",")}],"hasMore":false}""")
            }
        }
        fun history(thread: String): List<Pair<Long, String>> {
            fun prompt(id: String, seq: Long, run: String, body: String) =
                historyEventWire(
                    id,
                    seq,
                    thread,
                    "input.prompt",
                    """{"userMessage":{"version":1,"parts":[{"type":"text","text":"$body"}]}}""",
                    run,
                )
            fun reply(id: String, seq: Long, run: String, body: String) =
                historyEventWire(id, seq, thread, payload = """{"content":"$body"}""", run = run)
            return listOf(
                    10L to prompt("older-prompt", 10, olderRun, "Check last week's notes"),
                    11L to reply("older-process", 11, olderRun, hiddenReply),
                    12L to reply("older-end", 12, olderRun, "Previous launch summary"),
                    17L to prompt("launch-prompt", 17, HISTORY_RUN, "Prepare the launch brief"),
                    22L to reply("launch-process", 22, HISTORY_RUN, earlierReply),
                    23L to reply("launch-end", 23, HISTORY_RUN, finalReply),
                    37L to historyEventWire(HISTORY_LAST_EVENT, 37, thread, "run.completed", "null"),
                )
        }
        fixture.historyRows = { request ->
            val address = checkNotNull(request.requestUrl)
            val thread = address.pathSegments[2]
            val since = address.queryParameter("sinceSeqId")?.toLong() ?: 0
            val events = history(thread).filter { it.first > since }.joinToString(",") { it.second }
            jsonResponse(
                """{"rows":[$events],"cursor":{"lastEventId":"$HISTORY_LAST_EVENT","lastSeqId":37},"hasMore":false}"""
            )
        }
        fixture.historyCatchUp = { request ->
            val body = Json.parseToJsonElement(request.body.clone().readUtf8()).jsonArray
            val events = body.joinToString(",") { cursor ->
                val (thread, sequence) = cursor.jsonArray
                val rows = history(thread.jsonPrimitive.content)
                    .filter { it.first > sequence.jsonPrimitive.long }
                    .joinToString(",") { it.second }
                """$thread:[$rows]"""
            }
            jsonResponse("""{"events":{$events},"notFoundThreads":[]}""")
        }
        fixture.searchMessages = { request ->
            if (request.requestUrl?.queryParameter("keyword") == "launch")
                jsonResponse(
                    """
                    {"results":[{"chatThreadId":"$CHAT_PERSONAL","agentName":"Okou",
                      "matchedMessage":{"chatThreadId":"$CHAT_PERSONAL","role":"assistant",
                        "content":"$earlierReply","createdAt":"$CHAT_DATE","seqId":22,"runId":"$HISTORY_RUN"},
                      "matchedRanges":[{"start":8,"end":14}]}]}
                    """
                )
            else jsonResponse("""{"results":[]}""")
        }
        try {
            device.executeShellCommand("wm density 160")
            device.executeShellCommand("wm size 412x892")
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                fun hideKeyboard() {
                    scenario.onActivity { activity ->
                        WindowCompat.getInsetsController(activity.window, activity.window.decorView)
                            .hide(WindowInsetsCompat.Type.ime())
                    }
                    device.waitForIdle()
                }
                fun enter(keyword: String) {
                    field().click()
                    field().text = keyword
                    hideKeyboard()
                }
                fun openSearch() {
                    button(R.string.chat_search_workspace).click()
                    tab(R.string.chat_search_all)
                    field()
                }
                try {
                    device.awaitChatList(app)
                    text(title).click()
                    text(finalReply)
                    assertFalse(device.hasObject(By.pkg(app.packageName).text(earlierReply)))
                    button(R.string.back).click()
                    device.awaitChatList(app)
                    openSearch()
                    text(label(R.string.chat_search_recently_opened))
                    text(title)
                    hideKeyboard()
                    capture("search-recent.png")

                    enter("launch")
                    text(earlierReply)
                    text(workflows.releaseTitle)
                    text(label(R.string.chat_search_view_all))
                    capture("search-grouped.png")

                    text(earlierReply).click()
                    text(finalReply)
                    text(earlierReply)
                    assertFalse(device.hasObject(By.pkg(app.packageName).text(hiddenReply)))
                    capture("search-message.png")
                    button(R.string.back).click()
                    assertEquals("launch", field().text)
                    text(earlierReply)

                    text(workflows.releaseTitle).click()
                    text(workflows.releasePurpose)
                    capture("search-workflow.png")
                    press(R.string.chat_search_workflow_details)
                    contains("Review launch copy and product notes.")
                    device.pressBack()
                    assertEquals("launch", field().text)
                    text(workflows.releaseTitle).click()
                    press(R.string.chat_search_workflow_add_draft)
                    contains("/release-review Keep my existing draft")
                    assertFalse(
                        workflows.requests.any {
                            it.method == "POST" &&
                                it.requestUrl?.encodedPath in
                                    setOf("/api/chat-threads", "/api/chat/events")
                        }
                    )
                    hideKeyboard()
                    capture("search-draft.png")
                    button(R.string.back).click()
                    assertEquals("launch", field().text)

                    tab(R.string.chat_search_artifacts)
                    text(artifacts.summary.title).click()
                    text(label(R.string.chat_search_artifact_preview))
                    contains("Positioning:")
                    text(label(R.string.artifact_view_source))
                    capture("search-artifact.png")
                    press(R.string.artifact_view_source)
                    text(finalReply)
                    button(R.string.artifact_return_preview).click()
                    contains("Positioning:")
                    button(R.string.back).click()
                    assertEquals("launch", field().text)
                    text(artifacts.summary.title)

                    tab(R.string.chat_search_messages)
                    enter("no match")
                    text(label(R.string.chat_search_no_messages))
                    text(label(R.string.chat_search_all_types))
                    capture("search-empty.png")
                    press(R.string.chat_search_all_types)
                    assertEquals("no match", field().text)

                    enter("launch")
                    app.connectivity.value = false
                    text(label(R.string.chat_search_offline_titles))
                    text("Launch notes")
                    assertFalse(device.hasObject(By.pkg(app.packageName).text(earlierReply)))
                    capture("search-offline.png")
                    tab(R.string.chat_search_messages)
                    text(label(R.string.chat_search_online_only))
                    app.connectivity.value = true

                    button(R.string.back).click()
                    device.awaitChatList(app)
                    device.executeShellCommand("wm size 1000x800")
                    text(title).click()
                    text(finalReply)
                    openSearch()
                    enter("launch")
                    text(label(R.string.chat_search_view_all))
                    assertTrue(field().visibleBounds.right < text(finalReply).visibleBounds.left)
                    capture("search-wide.png")
                    press(R.string.chat_search_view_all)
                    text(projectTitle).click()
                    device.awaitChatList(app)
                    text(projectTitle)
                } catch (failure: Throwable) {
                    runCatching {
                            TestStorage()
                                .openOutputFile("search-failure-window.xml")
                                .use(device::dumpWindowHierarchy)
                        }
                        .exceptionOrNull()
                        ?.let(failure::addSuppressed)
                    throw failure
                }
            }
        } finally {
            app.searchService = originalSearch
            app.chatService = originalChats
            app.composerService = originalComposer
            app.workflows = originalWorkflows
            app.connectivity.value = originalConnectivity
            auth.state.value = originalAuth
            app.restoreApiPreferences(originalPreferences)
            workflows.close()
            originalCache.restore()
            device.executeShellCommand("wm size ${originalSize.ifEmpty { "reset" }}")
            device.executeShellCommand("wm density ${originalDensity.ifEmpty { "reset" }}")
        }
    }
}
