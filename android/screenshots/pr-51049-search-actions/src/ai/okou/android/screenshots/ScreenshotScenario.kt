package ai.okou.android.screenshots

import ai.okou.android.ArtifactApiFixture
import ai.okou.android.CHAT_DATE
import ai.okou.android.CHAT_PERSONAL
import ai.okou.android.ChatCacheSnapshot
import ai.okou.android.ComposerApiFixture
import ai.okou.android.HISTORY_RUN
import ai.okou.android.MainActivity
import ai.okou.android.R
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.WorkflowApiFixture
import ai.okou.android.api.generated.UserPreferencesLocale
import ai.okou.android.api.generated.UserPreferencesTheme
import ai.okou.android.jsonResponse
import ai.okou.android.testAuthenticationState
import ai.okou.android.testPreferences
import android.content.res.Configuration
import android.os.LocaleList
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
import androidx.test.uiautomator.Direction
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    @Test
    fun workspaceSearchActions() {
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
        val originalCache = ChatCacheSnapshot(app.noBackupFilesDir.resolve("chat-list"), app.chatCache)
        val originalSize =
            device.executeShellCommand("wm size").substringAfter("Override size: ", "").trim()
        val originalDensity =
            device.executeShellCommand("wm density").substringAfter("Override density: ", "").trim()
        val fontScaleSetting = "system font_scale"
        val originalFontScale = device.executeShellCommand("settings get $fontScaleSetting").trim()
        val animationSetting = "global animator_duration_scale"
        val originalAnimation = device.executeShellCommand("settings get $animationSetting").trim()
        val localized = app.createConfigurationContext(
            Configuration(app.resources.configuration).apply {
                setLocales(LocaleList.forLanguageTags("zh-Hans"))
            },
        )
        val editor = By.pkg(app.packageName).clazz("android.widget.EditText")
        val keyword = "发布"
        val noMatch = "预算"
        val snippet = "发布前需要核对官网和邮件素材。"

        fun label(id: Int) = localized.getString(id)
        fun get(selector: BySelector) =
            checkNotNull(device.wait(Until.findObject(selector), 12_000)) {
                "Missing workspace search element: $selector"
            }
        fun text(value: String) = get(By.pkg(app.packageName).text(value))
        fun control(id: Int) = By.pkg(app.packageName).desc(label(id))
        fun tab(id: Int) = get(By.pkg(app.packageName).clickable(true).hasChild(By.text(label(id))))
        fun field() =
            checkNotNull(device.wait(Until.findObjects(editor), 12_000)) {
                "Missing workspace search editor"
            }.minBy { it.visibleBounds.left }
        fun button(id: Int) =
            checkNotNull(generateSequence(text(label(id))) { it.parent }
                .firstOrNull { it.isClickable || !it.isEnabled && it.visibleBounds.height() >= 48 }) {
                "Missing accessible button for ${label(id)}"
            }
        fun query(value: String, scenario: ActivityScenario<MainActivity>) {
            field().text = value
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
            ) { "Expected the keyboard to be hidden" }
        }
        fun assertContext(query: String, scope: Int) {
            assertEquals(query, field().text)
            get(By.pkg(app.packageName).selected(true).hasChild(By.text(label(scope))))
        }

        val chats = ComposerApiFixture(simulateHistory = false).chats
        val workflows = WorkflowApiFixture(chinese = true, chats = chats)
        val artifacts = ArtifactApiFixture(chats, chinese = true).apply { install() }
        val releaseRead = CountDownLatch(1)
        val startedRead = CountDownLatch(1)
        try {
            chats.searchMessages = { request ->
                if (request.requestUrl?.queryParameter("keyword") != keyword) {
                    jsonResponse("""{"results":[]}""")
                } else {
                    jsonResponse("""
                        {"results":[{"chatThreadId":"$CHAT_PERSONAL",
                        "matchedMessage":{"chatThreadId":"$CHAT_PERSONAL","role":"assistant",
                        "content":"$snippet","createdAt":"$CHAT_DATE","seqId":23,"runId":"$HISTORY_RUN"},
                        "matchedRanges":[{"start":0,"end":2}]}]}
                        """.trimIndent())
                }
            }
            app.chatService = chats.service
            app.searchService = chats.service
            app.composerService = chats.service
            app.workflows = chats.service
            device.executeShellCommand("wm density 160")
            device.executeShellCommand("settings put $animationSetting 0")

            for (layout in listOf("phone", "wide", "short")) {
                val wide = layout == "wide"
                val short = layout == "short"
                val size = when (layout) {
                    "wide" -> "1000x800"
                    "short" -> "412x350"
                    else -> "412x892"
                }
                device.executeShellCommand("settings put $fontScaleSetting ${if (short) "2.0" else "1.0"}")
                device.executeShellCommand("wm size $size")
                auth.state.value = testAuthenticationState(user = "search-actions-${UUID.randomUUID()}")
                app.initialPreferences = testPreferences().copy(
                    locale = UserPreferencesLocale.ZH_HANS,
                    theme = if (wide) UserPreferencesTheme.DARK else UserPreferencesTheme.LIGHT,
                )
                workflows.previousDraft = "保留原有草稿"
                val all = R.string.chat_search_all
                val workflowTab = R.string.chat_search_workflows
                val add = R.string.chat_search_workflow_add_draft
                val opening = R.string.chat_search_workflow_opening_draft
                val details = R.string.chat_search_workflow_details
                ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                    try {
                    if (!short) text(artifacts.sourceTitle)
                    if (wide) text(artifacts.sourceTitle).click()
                    get(control(R.string.chat_search_workspace)).click()

                    if (layout == "phone") {
                        tab(workflowTab).click()
                        query(noMatch, scenario)
                        text(label(R.string.chat_search_no_workflows))
                        val expand = button(R.string.chat_search_all_types)
                        assertTrue(expand.visibleBounds.height() >= 48)
                        assertContext(noMatch, workflowTab)
                        ScreenshotCapture.capture("search-empty-phone.png")
                        expand.click()
                        assertContext(noMatch, all)
                    }

                    if (short) tab(workflowTab).click()
                    query(keyword, scenario)
                    text(workflows.releaseTitle)
                    if (!short) {
                        assertContext(keyword, all)
                        text(snippet)
                        text(artifacts.checklist.title)
                        ScreenshotCapture.capture("search-results-$layout.png")
                        tab(workflowTab).click()
                        assertContext(keyword, workflowTab)
                    }
                    text(workflows.releaseTitle).click()

                    if (short) {
                        scenario.onActivity { activity ->
                            assertTrue(activity.resources.configuration.fontScale >= 2f)
                        }
                        val scrollable = get(By.pkg(app.packageName).scrollable(true)
                            .hasDescendant(By.text(workflows.releaseTitle)))
                        if (device.findObject(By.text(label(details))) == null) {
                            scrollable.scroll(Direction.DOWN, 0.9f)
                        }
                        assertTrue(button(add).isEnabled)
                        assertTrue(button(details).isEnabled)
                        ScreenshotCapture.capture("search-workflow-short-200-percent.png")
                        return@use
                    }

                    text(workflows.releasePurpose)
                    val addBounds = button(add).visibleBounds
                    val detailsBounds = button(details).visibleBounds
                    assertTrue(addBounds.height() >= 48)
                    assertTrue(detailsBounds.height() >= 48)
                    ScreenshotCapture.capture("search-workflow-intro-$layout.png")

                    if (!wide) {
                        button(details).click()
                        text(label(R.string.workflow_instructions_heading))
                        device.pressBack()
                        assertContext(keyword, workflowTab)
                        text(workflows.releaseTitle).click()

                        workflows.rejectDraftRead = true
                        workflows.beforeDraftRead = {
                            startedRead.countDown()
                            check(releaseRead.await(30, TimeUnit.SECONDS))
                        }
                        button(add).click()
                        assertTrue(startedRead.await(8, TimeUnit.SECONDS))
                        val preparing = button(opening)
                        assertFalse(preparing.isEnabled)
                        assertFalse(button(details).isEnabled)
                        assertEquals(addBounds, preparing.visibleBounds)
                        ScreenshotCapture.capture("search-workflow-opening-phone.png")
                        releaseRead.countDown()

                        val error = text(label(R.string.workflow_draft_unavailable))
                        assertTrue(error.visibleBounds.bottom < addBounds.top)
                        assertEquals(addBounds, button(add).visibleBounds)
                        assertEquals(detailsBounds, button(details).visibleBounds)
                        assertTrue(button(add).isEnabled)
                        ScreenshotCapture.capture("search-workflow-failure-phone.png")
                        assertEquals("保留原有草稿", workflows.previousDraft)
                        workflows.beforeDraftRead = {}
                        workflows.rejectDraftRead = false
                    }

                    button(add).click()
                    get(By.pkg(app.packageName).clazz("android.widget.EditText")
                        .textContains("/release-review 保留原有草稿"))
                    if (wide) {
                        get(control(R.string.chat_search_workspace))
                    } else {
                        device.pressBack()
                        assertContext(keyword, workflowTab)
                        text(workflows.releaseTitle)
                    }
                    } catch (error: Throwable) {
                        runCatching {
                            TestStorage().openOutputFile("workspace-search-window.xml")
                                .use(device::dumpWindowHierarchy)
                        }.exceptionOrNull()?.let(error::addSuppressed)
                        throw error
                    }
                }
            }
        } finally {
            releaseRead.countDown()
            app.chatService = originalChats
            app.searchService = originalSearch
            app.composerService = originalComposer
            app.workflows = originalWorkflows
            auth.state.value = originalAuth
            app.restoreApiPreferences(originalPreferences)
            app.initialPreferences = initialPreferences
            workflows.close()
            originalCache.restore()
            if (originalAnimation == "null" || originalAnimation.isEmpty()) {
                device.executeShellCommand("settings delete $animationSetting")
            } else {
                device.executeShellCommand("settings put $animationSetting $originalAnimation")
            }
            if (originalFontScale.toFloatOrNull() == null) {
                device.executeShellCommand("settings delete $fontScaleSetting")
            } else {
                device.executeShellCommand("settings put $fontScaleSetting $originalFontScale")
            }
            device.executeShellCommand("wm size ${originalSize.ifEmpty { "reset" }}")
            device.executeShellCommand("wm density ${originalDensity.ifEmpty { "reset" }}")
        }
    }
}
