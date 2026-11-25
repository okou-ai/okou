package ai.okou.android.screenshots

import ai.okou.android.ChatCacheSnapshot
import ai.okou.android.MainActivity
import ai.okou.android.R
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.WorkflowApiFixture
import ai.okou.android.api.generated.UserPreferencesLocale
import ai.okou.android.api.generated.UserPreferencesTheme
import ai.okou.android.awaitChatList
import ai.okou.android.chatEventWire
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
    fun workflowSearchDistinguishesCachedMatchesPendingAndSettledReads() {
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
        val originalSize = device.executeShellCommand("wm size").substringAfter("Override size: ", "").trim()
        val originalDensity = device.executeShellCommand("wm density").substringAfter("Override density: ", "").trim()
        val animationScale = "global animator_duration_scale"
        val originalAnimation = device.executeShellCommand("settings get $animationScale").trim()
        val localized =
            app.createConfigurationContext(
                Configuration(app.resources.configuration).apply {
                    setLocales(LocaleList.forLanguageTags("zh-Hans"))
                },
            )
        val chatTitle = "发布协作"
        val historyReply = "发布文案和渠道清单已核对。"
        val term = "发布"
        val missing = "季度报表"
        fun label(id: Int) = localized.getString(id)
        fun control(id: Int) = By.pkg(app.packageName).desc(label(id))
        fun named(value: String) = By.pkg(app.packageName).text(value)
        fun get(selector: BySelector) =
            checkNotNull(device.wait(Until.findObject(selector), 10_000)) { "Missing $selector" }
        val editors = By.pkg(app.packageName).clazz("android.widget.EditText")
        fun field() =
            checkNotNull(device.wait(Until.findObjects(editors), 10_000)) {
                "Workspace search field is missing"
            }.minBy { it.visibleBounds.left }
        val loading = control(R.string.chat_search_loading)
        val type = named(label(R.string.chat_search_workflows))
        val selectedType = By.pkg(app.packageName).selected(true).hasChild(type)
        val empty = named(label(R.string.chat_search_no_workflows))
        fun hideIme(scenario: ActivityScenario<MainActivity>) {
            scenario.onActivity {
                WindowCompat.getInsetsController(it.window, it.window.decorView)
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
                    8_000,
                ),
            ) { "Expected the keyboard to be hidden" }
        }
        fun query(value: String, scenario: ActivityScenario<MainActivity>) {
            field().click()
            field().text = value
            hideIme(scenario)
            assertEquals(value, field().text)
            get(selectedType)
        }
        fun openSearch(scenario: ActivityScenario<MainActivity>) {
            val entry = get(control(R.string.chat_search_workspace))
            val bounds = entry.visibleBounds
            assertEquals(48, bounds.height())
            entry.click()
            get(By.copy(editors).focused(true))
            val fieldBounds = field().visibleBounds
            assertEquals(bounds.left, fieldBounds.left)
            assertEquals(bounds.top, fieldBounds.top)
            assertEquals(48, fieldBounds.height())
            field().text = term
            val option = get(type).parent
            check(option.isClickable)
            option.click()
            hideIme(scenario)
            val filterBounds = get(selectedType).visibleBounds
            assertEquals(48, filterBounds.height())
            assertEquals(8, filterBounds.top - fieldBounds.bottom)
            assertEquals(term, field().text)
        }
        fun closeSearch() {
            get(control(R.string.back)).click()
            device.awaitChatList(localized)
        }

        try {
            device.executeShellCommand("wm density 160")
            device.executeShellCommand("settings put $animationScale 0")
            for (layout in listOf("phone", "wide")) {
                val wide = layout == "wide"
                device.executeShellCommand("wm size ${if (wide) "1000x800" else "412x892"}")
                WorkflowApiFixture(chinese = true).use { fixture ->
                    val chats = fixture.chats
                    app.initialPreferences =
                        testPreferences().copy(
                            locale = UserPreferencesLocale.ZH_HANS,
                            theme = if (wide) UserPreferencesTheme.DARK else UserPreferencesTheme.LIGHT,
                        )
                    app.chatService = fixture.service
                    app.searchService = fixture.service
                    app.composerService = fixture.service
                    app.workflows = fixture.service
                    chats.historyReply = historyReply
                    chats.events = { request ->
                        if (request.requestUrl?.queryParameter("sinceSeqId") != null)
                            jsonResponse("""{"events":[],"hasMore":false}""")
                        else jsonResponse("""{"events":[${chatEventWire(title = chatTitle)}],"hasMore":false}""")
                    }
                    auth.state.value =
                        testAuthenticationState(user = "workflow-search-refresh-${UUID.randomUUID()}")
                    val refreshRequested = CountDownLatch(1)
                    val releaseCatalog = CountDownLatch(1)
                    ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                        try {
                            device.awaitChatList(localized)
                            if (wide) {
                                get(named(chatTitle)).click()
                                assertTrue(get(named(historyReply)).visibleBounds.left >= 320)
                            }
                            openSearch(scenario)
                            val row = named(fixture.releaseTitle)
                            val stableRow = get(row).visibleBounds
                            closeSearch()

                            fixture.beforeCatalog = {
                                refreshRequested.countDown()
                                check(releaseCatalog.await(25, TimeUnit.SECONDS)) {
                                    "The workflow catalog was held past the capture"
                                }
                            }
                            openSearch(scenario)
                            assertTrue(refreshRequested.await(8, TimeUnit.SECONDS))
                            val progress = get(loading).visibleBounds
                            assertEquals(4, progress.height())
                            assertEquals(if (wide) 319 else 412, progress.right)
                            assertEquals(stableRow, get(row).visibleBounds)
                            if (wide) get(named(historyReply))
                            ScreenshotCapture.capture("workflow-search-refresh-$layout.png")

                            query(missing, scenario)
                            val skeleton = get(loading).visibleBounds
                            assertTrue(skeleton.height() > 52)
                            assertFalse(device.hasObject(empty))
                            ScreenshotCapture.capture("workflow-search-skeleton-$layout.png")

                            releaseCatalog.countDown()
                            get(empty)
                            assertFalse(device.hasObject(loading))
                            ScreenshotCapture.capture("workflow-search-empty-$layout.png")
                            closeSearch()

                            val respond = chats.commandResponse
                            chats.commandResponse = { request ->
                                if (request.requestUrl?.encodedPath == "/api/workflows")
                                    jsonResponse("""{"error":{"code":"BAD_REQUEST","message":"Catalog unavailable"}}""")
                                        .setResponseCode(400)
                                else respond(request)
                            }
                            openSearch(scenario)
                            get(named(label(R.string.chat_search_workflows_saved)))
                            get(row)
                            assertFalse(device.hasObject(loading))
                            ScreenshotCapture.capture("workflow-search-fallback-$layout.png")
                        } catch (error: Throwable) {
                            runCatching {
                                TestStorage().openOutputFile("workflow-search-$layout-window.xml")
                                    .use(device::dumpWindowHierarchy)
                                ScreenshotCapture.capture("workflow-search-$layout-failure.png")
                            }.exceptionOrNull()?.let(error::addSuppressed)
                            throw error
                        } finally {
                            releaseCatalog.countDown()
                        }
                    }
                }
            }
        } finally {
            app.chatService = originalChats
            app.searchService = originalSearch
            app.composerService = originalComposer
            app.workflows = originalWorkflows
            auth.state.value = originalAuth
            app.restoreApiPreferences(originalPreferences)
            app.initialPreferences = initialPreferences
            originalCache.restore()
            if (originalAnimation.isEmpty() || originalAnimation == "null") {
                device.executeShellCommand("settings delete $animationScale")
            } else device.executeShellCommand("settings put $animationScale $originalAnimation")
            device.executeShellCommand("wm size ${originalSize.ifEmpty { "reset" }}")
            device.executeShellCommand("wm density ${originalDensity.ifEmpty { "reset" }}")
        }
    }
}
