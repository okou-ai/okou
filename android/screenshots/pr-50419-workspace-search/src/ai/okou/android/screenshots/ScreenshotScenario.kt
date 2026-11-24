package ai.okou.android.screenshots

import ai.okou.android.ArtifactApiFixture
import ai.okou.android.CHAT_DATE
import ai.okou.android.CHAT_PERSONAL
import ai.okou.android.ChatCacheSnapshot
import ai.okou.android.HISTORY_RUN
import ai.okou.android.MainActivity
import ai.okou.android.R
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.WorkflowApiFixture
import ai.okou.android.api.generated.UserPreferencesLocale
import ai.okou.android.api.generated.UserPreferencesTheme
import ai.okou.android.awaitChatList
import ai.okou.android.awaitKeyboardFocus
import ai.okou.android.jsonResponse
import ai.okou.android.testAuthenticationState
import ai.okou.android.testPreferences
import android.content.res.Configuration
import android.graphics.Rect
import android.os.LocaleList
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.services.storage.TestStorage
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
import androidx.test.uiautomator.Condition
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    @Test
    fun workspaceSearchKeepsTheKeywordThroughScopeAndPreviewHandoffs() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val app = instrumentation.targetContext.applicationContext as TestOkouApplication
        val device = UiDevice.getInstance(instrumentation)
        val auth = app.authentication as TestAuthentication
        val originalAuth = auth.state.value
        val originalChats = app.chatService
        val originalSearch = app.searchService
        val originalComposer = app.composerService
        val originalWorkflows = app.workflows
        val originalPreferences = app.snapshotApiPreferences()
        val initialPreferences = app.initialPreferences
        val originalCache =
            ChatCacheSnapshot(app.noBackupFilesDir.resolve("chat-list"), app.chatCache)
        val originalSize =
            device.executeShellCommand("wm size").substringAfter("Override size: ", "").trim()
        val originalDensity =
            device.executeShellCommand("wm density").substringAfter("Override density: ", "").trim()
        val animationSetting = "global animator_duration_scale"
        val originalAnimation = device.executeShellCommand("settings get $animationSetting").trim()
        val localized =
            app.createConfigurationContext(
                Configuration(app.resources.configuration).apply {
                    setLocales(LocaleList.forLanguageTags("zh-Hans"))
                },
            )
        val workflows = WorkflowApiFixture(chinese = true)
        val chats = workflows.chats
        val artifacts = ArtifactApiFixture(chats, chinese = true).apply { install() }
        val progressGate = AtomicReference<ProgressGate?>()
        artifacts.beforeCatalog = { request ->
            val url = checkNotNull(request.requestUrl)
            if (url.queryParameter("keyword") == "发布" && url.queryParameter("cursor") == null) {
                progressGate.get()?.let { gate ->
                    gate.requested.countDown()
                    check(gate.release.await(40, TimeUnit.SECONDS)) {
                        "Capture did not release the artifact read"
                    }
                }
            }
        }
        val message = "请核对发布日程，再同步给团队。"
        chats.historyReply = message
        chats.searchMessages = { request ->
            val keyword = request.requestUrl?.queryParameter("keyword")
            if (keyword == "发布") {
                jsonResponse(
                    """
                    {"results":[{"chatThreadId":"$CHAT_PERSONAL","agentName":"Okou",
                      "matchedMessage":{"chatThreadId":"$CHAT_PERSONAL","role":"assistant",
                        "content":"$message","createdAt":"$CHAT_DATE","seqId":23,"runId":"$HISTORY_RUN"},
                      "matchedRanges":[{"start":3,"end":5}]}]}
                    """
                        .trimIndent(),
                )
            } else if (keyword == "摘要") {
                jsonResponse("""{"error":{"code":"BAD_REQUEST","message":"Search unavailable"}}""")
                    .setResponseCode(400)
            } else jsonResponse("""{"results":[]}""")
        }
        auth.state.value = testAuthenticationState(user = "search-groups-${UUID.randomUUID()}")
        app.initialPreferences =
            testPreferences()
                .copy(
                    locale = UserPreferencesLocale.ZH_HANS,
                    theme = UserPreferencesTheme.LIGHT,
                )
        app.chatService = chats.service
        app.searchService = chats.service
        app.composerService = chats.service
        app.workflows = workflows.service

        fun get(selector: BySelector) =
            checkNotNull(device.wait(Until.findObject(selector), 12_000)) {
                "Missing workspace search control: $selector"
            }
        fun label(id: Int) = localized.getString(id)
        fun text(value: String) = get(By.pkg(app.packageName).text(value))
        fun control(id: Int) = By.pkg(app.packageName).desc(label(id))
        fun editText() = By.pkg(app.packageName).clazz("android.widget.EditText")
        fun field() =
            checkNotNull(device.wait(Until.findObjects(editText()), 12_000)) {
                    "Workspace search editor is missing"
                }
                .minBy { it.visibleBounds.left }
        fun selected(id: Int) =
            get(By.pkg(app.packageName).selected(true).hasChild(By.text(label(id))))
        fun hideIme(scenario: ActivityScenario<MainActivity>) {
            scenario.onActivity { activity ->
                WindowCompat.getInsetsController(activity.window, activity.window.decorView)
                    .hide(WindowInsetsCompat.Type.ime())
            }
            check(
                device.wait(
                    object : Condition<UiDevice, Boolean> {
                        override fun apply(device: UiDevice): Boolean =
                            instrumentation.uiAutomation.windows.none {
                                it.type == AccessibilityWindowInfo.TYPE_INPUT_METHOD
                            }
                    },
                    10_000,
                ),
            ) {
                "Expected the keyboard to be hidden"
            }
        }

        try {
            device.executeShellCommand("wm density 160")
            device.executeShellCommand("wm size 412x892")
            device.executeShellCommand("settings put $animationSetting 0")
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                try {
                    for (layout in listOf("phone", "wide")) {
                        val wide = layout == "wide"
                        if (wide) device.executeShellCommand("wm size 1000x800")
                        device.awaitChatList(localized)
                        val entry = get(control(R.string.chat_search_workspace))
                        val entryBounds = entry.visibleBounds
                        text(artifacts.sourceTitle).click()
                        val transcript = text("Hello history")
                        if (wide) {
                            assertTrue(transcript.visibleBounds.left >= 320)
                        } else {
                            device.pressBack()
                            device.awaitChatList(localized)
                        }
                        get(control(R.string.chat_search_workspace)).click()
                        get(editText().focused(true))
                        assertEquals(entryBounds.left, field().visibleBounds.left)
                        assertEquals(48, field().visibleBounds.height())
                        assertEquals(
                            8,
                            selected(R.string.chat_search_all).visibleBounds.top -
                                field().visibleBounds.bottom,
                        )
                        assertEquals(48, selected(R.string.chat_search_all).visibleBounds.height())
                        if (!wide) {
                            hideIme(scenario)
                            text(label(R.string.chat_search_recently_opened))
                            text(artifacts.sourceTitle)
                            ScreenshotCapture.capture("search-recent-phone.png")
                        }
                        val gate = ProgressGate()
                        progressGate.set(gate)
                        field().text = "发布"
                        hideIme(scenario)
                        assertTrue(gate.requested.await(10, TimeUnit.SECONDS))
                        text(workflows.releaseTitle)
                        assertTrue(
                            device.wait(
                                object : Condition<UiDevice, Boolean> {
                                    override fun apply(device: UiDevice): Boolean =
                                        device
                                            .findObjects(By.pkg(app.packageName).text(message))
                                            .any {
                                                it.visibleBounds.right <= if (wide) 320 else 412
                                            }
                                },
                                12_000,
                            ),
                        )
                        val progress = get(control(R.string.chat_search_loading))
                        assertEquals(4, progress.visibleBounds.height())
                        assertEquals(
                            6,
                            progress.visibleBounds.top -
                                selected(R.string.chat_search_all).visibleBounds.bottom,
                        )
                        val knownRowBounds = text(workflows.releaseTitle).visibleBounds
                        ScreenshotCapture.capture("search-loading-$layout.png")
                        gate.release.countDown()
                        text(artifacts.checklist.title)
                        assertTrue(
                            device.wait(Until.gone(control(R.string.chat_search_loading)), 12_000),
                        )
                        assertEquals(knownRowBounds, text(workflows.releaseTitle).visibleBounds)
                        val viewAll =
                            localized.getString(
                                R.string.chat_search_view_type,
                                label(R.string.chat_search_artifacts),
                            )
                        val shortcut = get(By.pkg(app.packageName).desc(viewAll))
                        assertEquals(48, shortcut.visibleBounds.height())
                        if (wide) assertTrue(text("Hello history").visibleBounds.left >= 320)
                        ScreenshotCapture.capture("search-grouped-$layout.png")
                        shortcut.click()
                        val artifactType = selected(R.string.chat_search_artifacts).visibleBounds
                        device.awaitKeyboardFocus(
                            By.pkg(app.packageName).text(label(R.string.chat_search_artifacts)),
                        )
                        assertEquals("发布", field().text)
                        text(artifacts.image.title)
                        val heading =
                            device
                                .findObjects(
                                    By.pkg(app.packageName)
                                        .text(label(R.string.chat_search_artifacts)),
                                )
                                .single { it.visibleBounds.top >= artifactType.bottom }
                        assertEquals(20, heading.visibleBounds.top - artifactType.bottom)
                        assertEquals(28, heading.visibleBounds.left)
                        assertEquals(
                            heading.visibleBounds.left,
                            text(artifacts.checklist.title).visibleBounds.left,
                        )
                        ScreenshotCapture.capture("search-artifacts-$layout.png")

                        text(artifacts.summary.title).click()
                        text(label(R.string.artifact_view_source))
                        get(control(R.string.chat_search_close_artifact_preview)).click()
                        selected(R.string.chat_search_artifacts)
                        assertEquals("发布", field().text)
                        device.awaitKeyboardFocus(
                            By.pkg(app.packageName).text(artifacts.summary.title),
                        )
                        if (!wide) {
                            field().click()
                            field().text = "客户访谈"
                            hideIme(scenario)
                            text(label(R.string.chat_search_no_artifacts))
                            ScreenshotCapture.capture("search-empty-phone.png")
                            text(label(R.string.chat_search_all_types)).click()
                            selected(R.string.chat_search_all)
                            assertEquals("客户访谈", field().text)
                            device.awaitKeyboardFocus(
                                By.pkg(app.packageName).text(label(R.string.chat_search_all)),
                            )
                            text(label(R.string.chat_search_no_results))

                            field().click()
                            field().text = "摘要"
                            hideIme(scenario)
                            val notice = text(label(R.string.chat_search_unavailable))
                            assertEquals(28, notice.visibleBounds.left)
                            text(artifacts.summary.title)
                            assertEquals("摘要", field().text)
                            ScreenshotCapture.capture("search-partial-phone.png")
                        }
                        get(control(R.string.back)).click()
                        device.awaitChatList(localized)
                        check(
                            device.wait(
                                object : Condition<UiDevice, Boolean> {
                                    override fun apply(device: UiDevice): Boolean {
                                        val entry =
                                            device.findObject(
                                                control(R.string.chat_search_workspace),
                                            ) ?: return false
                                        return entry.isFocused ||
                                            entry.hasObject(By.focused(true)) ||
                                            entry.parent?.isFocused == true
                                    }
                                },
                                10_000,
                            ),
                        ) {
                            "Home search did not recover its keyboard focus"
                        }
                    }
                    device.executeShellCommand("wm size 240x760")
                    device.awaitChatList(localized)
                    get(control(R.string.chat_search_workspace)).click()
                    get(editText().focused(true)).text = "发布"
                    hideIme(scenario)
                    text(workflows.releaseTitle)
                    val filtersBottom = selected(R.string.chat_search_all).visibleBounds.bottom
                    val workflowLabel = label(R.string.chat_search_workflows)
                    val tab =
                        nodes(checkNotNull(instrumentation.uiAutomation.rootInActiveWindow)).first {
                            val bounds = Rect()
                            it.getBoundsInScreen(bounds)
                            it.text?.toString() == workflowLabel && bounds.bottom <= filtersBottom
                        }
                    val focusTarget = generateSequence(tab) { it.parent }.first { it.isFocusable }
                    instrumentation.setInTouchMode(false)
                    check(focusTarget.performAction(AccessibilityNodeInfo.ACTION_FOCUS))
                    val workflowText = By.pkg(app.packageName).text(workflowLabel)
                    device.awaitKeyboardFocus(workflowText)
                    check(device.pressDPadCenter())
                    val selectedWorkflow =
                        By.pkg(app.packageName).selected(true).hasChild(By.text(workflowLabel))
                    get(selectedWorkflow)
                    check(
                        device.wait(
                            object : Condition<UiDevice, Boolean> {
                                override fun apply(device: UiDevice): Boolean =
                                    device.findObject(selectedWorkflow)?.visibleBounds?.right
                                        ?.let { it <= device.displayWidth - 32 } == true
                            },
                            10_000,
                        ),
                    ) { "The focused workflow filter overlaps the right fade" }
                    assertEquals("发布", field().text)
                    text(workflows.releaseTitle)
                    ScreenshotCapture.capture("search-workflow-filter-narrow.png")
                } catch (error: Throwable) {
                    runCatching {
                            TestStorage()
                                .openOutputFile("workspace-search-window.xml")
                                .use(device::dumpWindowHierarchy)
                            ScreenshotCapture.capture("workspace-search-failure.png")
                        }
                        .exceptionOrNull()
                        ?.let(error::addSuppressed)
                    throw error
                }
            }
        } finally {
            progressGate.get()?.release?.countDown()
            app.searchService = originalSearch
            app.chatService = originalChats
            app.composerService = originalComposer
            app.workflows = originalWorkflows
            auth.state.value = originalAuth
            app.restoreApiPreferences(originalPreferences)
            app.initialPreferences = initialPreferences
            workflows.close()
            originalCache.restore()
            if (originalAnimation == "null" || originalAnimation.isEmpty()) {
                device.executeShellCommand("settings delete $animationSetting")
            } else device.executeShellCommand("settings put $animationSetting $originalAnimation")
            device.executeShellCommand("wm size ${originalSize.ifEmpty { "reset" }}")
            device.executeShellCommand("wm density ${originalDensity.ifEmpty { "reset" }}")
        }
    }

    private class ProgressGate {
        val requested = CountDownLatch(1)
        val release = CountDownLatch(1)
    }

    private fun nodes(node: AccessibilityNodeInfo): Sequence<AccessibilityNodeInfo> = sequence {
        yield(node)
        for (index in 0 until node.childCount) {
            node.getChild(index)?.let { yieldAll(nodes(it)) }
        }
    }
}
