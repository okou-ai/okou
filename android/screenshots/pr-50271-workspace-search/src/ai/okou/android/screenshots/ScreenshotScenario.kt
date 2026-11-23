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
import ai.okou.android.testPreferences
import ai.okou.android.api.generated.UserPreferencesLocale
import android.content.res.Configuration
import android.os.LocaleList
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.services.storage.TestStorage
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
import androidx.test.uiautomator.Direction
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import okhttp3.mockwebserver.MockResponse
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
        val initialPreferences = app.initialPreferences
        val localized = app.createConfigurationContext(Configuration(app.resources.configuration).apply {
            setLocales(LocaleList.forLanguageTags("zh-Hans"))
        })
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
        app.initialPreferences = testPreferences().copy(locale = UserPreferencesLocale.ZH_HANS)
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
        fun label(id: Int) = localized.getString(id)
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
        fun awaitSearchText(value: String) {
            val restored = By.pkg(app.packageName).clazz("android.widget.EditText").text(value)
            assertTrue(
                "The search input should show $value",
                device.wait(Until.hasObject(restored), 12_000),
            )
        }
        fun tab(id: Int, leaveInput: Boolean = false) {
            device.waitForIdle()
            val value = label(id)
            val selector = By.pkg(app.packageName).text(value)
            val topLabel =
                checkNotNull(device.wait(Until.findObjects(selector), 12_000))
                    .minBy { it.visibleBounds.top }
            val control = checkNotNull(topLabel.parent)
            if (control.isSelected && !leaveInput) return
            check(control.isClickable) { "Search type is not actionable: $value" }
            control.click()
            get(By.pkg(app.packageName).selected(true).hasChild(By.text(value)))
        }
        fun scrollTabs(from: Int, direction: Direction) {
            get(
                By.pkg(app.packageName)
                    .scrollable(true)
                    .hasDescendant(By.text(label(from)))
            ).scroll(direction, 0.8f, 900)
            device.waitForIdle()
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
        fixture.indicators = { jsonResponse("""{"agents":{},"threads":{},"unreadAt":{}}""") }
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
            val events =
                body.joinToString(",") { cursor ->
                    val (thread, sequence) = cursor.jsonArray
                    val rows =
                        history(thread.jsonPrimitive.content)
                            .filter { it.first > sequence.jsonPrimitive.long }
                            .joinToString(",") { it.second }
                    """$thread:[$rows]"""
                }
            jsonResponse("""{"events":{$events},"notFoundThreads":[]}""")
        }
        val recoveryAttempts = AtomicInteger()
        val recoveryRequested = CountDownLatch(1)
        val releaseRecovery = CountDownLatch(1)
        val failLaunchRefresh = AtomicBoolean()
        val failedRefreshes = AtomicInteger()
        val releaseRefresh = CountDownLatch(1)
        val unavailableAttempts = AtomicInteger()
        val holdEmptyRefresh = AtomicBoolean()
        val emptyRefreshStarted = CountDownLatch(1)
        val releaseEmptyRefresh = CountDownLatch(1)
        val groupedMessagesRequested = CountDownLatch(1)
        fixture.searchMessages = search@{ request ->
            val match =
                when (request.requestUrl?.queryParameter("keyword")) {
                    "launch" -> {
                        groupedMessagesRequested.countDown()
                        if (failLaunchRefresh.get()) {
                            if (failedRefreshes.incrementAndGet() == 1) {
                                check(releaseRefresh.await(20, TimeUnit.SECONDS))
                            }
                            return@search MockResponse().setResponseCode(503)
                        }
                        8 until 14
                    }
                    "earlier" -> {
                        if (recoveryAttempts.incrementAndGet() == 1)
                            return@search MockResponse().setResponseCode(503)
                        recoveryRequested.countDown()
                        check(releaseRecovery.await(20, TimeUnit.SECONDS))
                        0 until 7
                    }
                    "no match" -> {
                        if (holdEmptyRefresh.get()) {
                            emptyRefreshStarted.countDown()
                            check(releaseEmptyRefresh.await(20, TimeUnit.SECONDS))
                        }
                        return@search jsonResponse("""{"results":[]}""")
                    }
                    "unavailable" -> {
                        unavailableAttempts.incrementAndGet()
                        return@search MockResponse().setResponseCode(503)
                    }
                    else -> return@search jsonResponse("""{"results":[]}""")
                }
            jsonResponse(
                """
                {"results":[{"chatThreadId":"$CHAT_PERSONAL","agentName":"Okou",
                  "matchedMessage":{"chatThreadId":"$CHAT_PERSONAL","role":"assistant",
                    "content":"$earlierReply","createdAt":"$CHAT_DATE","seqId":22,"runId":"$HISTORY_RUN"},
                  "matchedRanges":[{"start":${match.first},"end":${match.last + 1}}]}]}
                """
            )
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
                fun enter(keyword: String, scope: Int = R.string.chat_search_all) {
                    field().click()
                    field().text = keyword
                    // Selecting the scope also ends the input session. Closing the IME window
                    // alone can leave the input method composing with the field still focused.
                    tab(scope, leaveInput = true)
                    hideKeyboard()
                    awaitSearchText(keyword)
                }
                fun openSearch() {
                    button(R.string.chat_search_workspace).click()
                    text(label(R.string.chat_search_all))
                    get(By.pkg(app.packageName).clazz("android.widget.EditText").focused(true))
                }
                try {
                    device.awaitChatList(localized)
                    if (!device.hasObject(By.pkg(app.packageName).text(projectTitle))) {
                        text("Research").click()
                    }
                    text(projectTitle).click()
                    text(finalReply)
                    button(R.string.back).click()
                    device.awaitChatList(localized)
                    text(title).click()
                    text(finalReply)
                    assertFalse(device.hasObject(By.pkg(app.packageName).text(earlierReply)))
                    button(R.string.back).click()
                    device.awaitChatList(localized)
                    fun actionBounds(id: Int) =
                        generateSequence(button(id)) { it.parent }.first { it.isClickable }.visibleBounds
                    val entry = actionBounds(R.string.chat_search_workspace)
                    val filter = actionBounds(R.string.chat_filter)
                    val settings = actionBounds(R.string.settings)
                    assertTrue(entry.height() == 48)
                    assertTrue(filter.left - entry.right == 8)
                    assertTrue(filter.width() == 48 && settings.width() == 48)
                    assertTrue(settings.left - filter.right == 4)
                    capture("search-home.png")
                    openSearch()
                    val input = field().visibleBounds
                    val firstType = get(By.pkg(app.packageName).selected(true)
                        .hasChild(By.text(label(R.string.chat_search_all)))).visibleBounds
                    assertTrue(input.height() == entry.height() && input.left == entry.left)
                    assertTrue(firstType.top - input.bottom == 8 && firstType.height() == 48)
                    assertFalse(device.hasObject(By.pkg(app.packageName).text("Workspace A")))
                    text(label(R.string.chat_search_recently_opened))
                    assertTrue(text(title).visibleBounds.top < text(projectTitle).visibleBounds.top)
                    val recentRow = generateSequence(text(title)) { it.parent }.first { it.isClickable }
                    assertTrue(recentRow.visibleBounds.height() == 52)
                    hideKeyboard()
                    capture("search-recent.png")

                    enter("launch")
                    assertTrue(
                        "An active workspace search should request messages for launch",
                        groupedMessagesRequested.await(12, TimeUnit.SECONDS),
                    )
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
                    awaitSearchText("launch")
                    text(earlierReply)

                    text(workflows.releaseTitle).click()
                    text(workflows.releasePurpose)
                    capture("search-workflow.png")
                    press(R.string.chat_search_workflow_details)
                    contains("Review launch copy and product notes.")
                    device.pressBack()
                    awaitSearchText("launch")
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
                    awaitSearchText("launch")

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
                    button(R.string.chat_search_close_artifact_preview).click()
                    awaitSearchText("launch")
                    text(artifacts.summary.title)

                    tab(R.string.chat_search_messages)
                    enter("no match", R.string.chat_search_messages)
                    text(label(R.string.chat_search_no_messages))
                    text(label(R.string.chat_search_all_types))
                    capture("search-empty.png")
                    val loadingLabel = label(R.string.chat_search_loading)
                    val searchLoader = By.pkg(app.packageName).desc(loadingLabel)
                    holdEmptyRefresh.set(true)
                    tab(R.string.chat_list_title)
                    tab(R.string.chat_search_messages)
                    assertTrue("The confirmed empty query should refresh", emptyRefreshStarted.await(12, TimeUnit.SECONDS))
                    assertFalse(device.wait(Until.hasObject(searchLoader), 650))
                    text(label(R.string.chat_search_no_messages))
                    text(label(R.string.chat_search_all_types))
                    capture("search-empty-refresh.png")
                    holdEmptyRefresh.set(false)
                    releaseEmptyRefresh.countDown()
                    press(R.string.chat_search_all_types)
                    awaitSearchText("no match")

                    tab(R.string.chat_search_messages)
                    enter("earlier", R.string.chat_search_messages)
                    val unavailable = label(R.string.chat_search_messages_failed)
                    val searchLabel = label(R.string.chat_search_loading)
                    val searching = By.pkg(app.packageName).desc(searchLabel).clazz("android.widget.ProgressBar")
                    val skeleton = By.pkg(app.packageName).desc(searchLabel).clazz("android.view.View")
                    checkNotNull(device.wait(Until.findObject(skeleton), 10_000))
                    assertTrue(
                        "The visible search should retry",
                        recoveryRequested.await(12, TimeUnit.SECONDS),
                    )
                    assertFalse(device.hasObject(By.pkg(app.packageName).text(unavailable)))
                    assertTrue(device.hasObject(skeleton))
                    assertFalse(device.hasObject(searching))
                    capture("search-retry.png")
                    releaseRecovery.countDown()
                    text(earlierReply)
                    awaitSearchText("earlier")
                    assertFalse(device.hasObject(By.pkg(app.packageName).text(unavailable)))

                    enter("launch", R.string.chat_search_messages)
                    text(earlierReply)
                    app.connectivity.value = false
                    device.waitForIdle()
                    val savedResults = label(R.string.chat_search_saved_results)
                    assertFalse(device.hasObject(By.pkg(app.packageName).text(savedResults)))
                    failLaunchRefresh.set(true)
                    tab(R.string.chat_list_title)
                    tab(R.string.chat_search_messages)
                    checkNotNull(device.wait(Until.findObject(searching), 10_000))
                    assertFalse(device.hasObject(skeleton))
                    text(earlierReply)
                    capture("search-refresh.png")
                    releaseRefresh.countDown()
                    val notice = text(savedResults)
                    assertTrue(failedRefreshes.get() == 3)
                    assertTrue(notice.visibleBounds.bottom <= text(earlierReply).visibleBounds.top)
                    capture("search-saved-results.png")
                    failLaunchRefresh.set(false)
                    app.connectivity.value = true

                    enter("unavailable", R.string.chat_search_messages)
                    text(unavailable)
                    assertTrue(unavailableAttempts.get() == 3)
                    assertFalse(device.hasObject(By.pkg(app.packageName).text(label(R.string.retry))))
                    capture("search-error.png")
                    enter("no match", R.string.chat_search_messages)
                    text(label(R.string.chat_search_no_messages))

                    button(R.string.back).click()
                    device.awaitChatList(localized)
                    device.executeShellCommand("wm size 1000x800")
                    text(title).click()
                    text(finalReply)
                    openSearch()
                    enter("launch")
                    text(label(R.string.chat_search_view_all))
                    assertTrue(field().visibleBounds.right < text(finalReply).visibleBounds.left)
                    capture("search-wide.png")
                    scrollTabs(R.string.chat_search_all, Direction.RIGHT)
                    tab(R.string.chat_search_artifacts)
                    text(artifacts.summary.title).click()
                    text(label(R.string.chat_search_artifact_preview))
                    contains("Positioning:")
                    assertFalse(device.hasObject(By.pkg(app.packageName).clazz("android.widget.EditText")))
                    capture("search-wide-artifact.png")
                    button(R.string.chat_search_close_artifact_preview).click()
                    awaitSearchText("launch")
                    text(artifacts.summary.title)
                    scrollTabs(R.string.chat_search_artifacts, Direction.LEFT)
                    tab(R.string.chat_search_all)
                    press(R.string.chat_search_view_all)
                    text(projectTitle).click()
                    device.awaitChatList(localized)
                    text(projectTitle)
                } catch (failure: Throwable) {
                    runCatching {
                            val storage = TestStorage()
                            storage.openOutputFile("search-failure-window.xml")
                                .use(device::dumpWindowHierarchy)
                            storage.openOutputFile("search-fixture-requests.txt").use { output ->
                                val journal = workflows.requests.mapNotNull { request ->
                                    val url = request.requestUrl ?: return@mapNotNull null
                                    when (url.encodedPath) {
                                        "/api/chat/search", "/api/artifacts/catalog" ->
                                            "${request.method} ${url.encodedPath} ${url.queryParameter("keyword")}"
                                        "/api/workflows", "/api/chat-threads/events" ->
                                            "${request.method} ${url.encodedPath}"
                                        else -> null
                                    }
                                }
                                val artifactQueries = artifacts.catalogQueries.map { (_, keyword) ->
                                    "GET /api/artifacts/catalog $keyword"
                                }
                                output.write((journal + artifactQueries).joinToString("\n").toByteArray())
                            }
                        }
                        .exceptionOrNull()
                        ?.let(failure::addSuppressed)
                    throw failure
                }
            }
        } finally {
            releaseRecovery.countDown()
            releaseRefresh.countDown()
            releaseEmptyRefresh.countDown()
            app.searchService = originalSearch
            app.chatService = originalChats
            app.composerService = originalComposer
            app.workflows = originalWorkflows
            app.connectivity.value = originalConnectivity
            auth.state.value = originalAuth
            app.restoreApiPreferences(originalPreferences)
            app.initialPreferences = initialPreferences
            workflows.close()
            originalCache.restore()
            device.executeShellCommand("wm size ${originalSize.ifEmpty { "reset" }}")
            device.executeShellCommand("wm density ${originalDensity.ifEmpty { "reset" }}")
        }
    }
}
