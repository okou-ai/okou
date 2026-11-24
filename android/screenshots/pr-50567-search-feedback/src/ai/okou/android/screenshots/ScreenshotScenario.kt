package ai.okou.android.screenshots

import ai.okou.android.ChatCacheSnapshot
import ai.okou.android.ChatListApiFixture
import ai.okou.android.MainActivity
import ai.okou.android.R
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.api.generated.UserPreferencesLocale
import ai.okou.android.api.generated.UserPreferencesTheme
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
import java.util.concurrent.atomic.AtomicBoolean
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    @Test
    fun workspaceSearchExplainsWhichSourcesWereSearchedAfterAReadFails() {
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
        val animationSetting = "global animator_duration_scale"
        val originalAnimation = device.executeShellCommand("settings get $animationSetting").trim()
        val localized =
            app.createConfigurationContext(
                Configuration(app.resources.configuration).apply {
                    setLocales(LocaleList.forLanguageTags("zh-Hans"))
                },
            )
        val noMatch = "客户访谈"
        val title = "发布检查清单"
        val firstListStarted = CountDownLatch(1)
        val releaseFirstList = CountDownLatch(1)
        val remoteSearches = CountDownLatch(2)
        val holdWideMessages = AtomicBoolean(false)
        val wideMessagesStarted = CountDownLatch(1)
        val releaseWideMessages = CountDownLatch(1)

        fun unavailable() =
            jsonResponse("""{"error":{"code":"BAD_REQUEST","message":"Search unavailable"}}""")
                .setResponseCode(400)
        fun label(id: Int) = localized.getString(id)
        fun get(selector: BySelector) =
            checkNotNull(device.wait(Until.findObject(selector), 12_000)) {
                "Missing workspace search control: $selector"
            }
        fun text(value: String) = get(By.pkg(app.packageName).text(value))
        fun control(id: Int) = By.pkg(app.packageName).desc(label(id))
        val editor = By.pkg(app.packageName).clazz("android.widget.EditText")
        fun field() =
            checkNotNull(device.wait(Until.findObjects(editor), 12_000)) {
                "Workspace search editor is missing"
            }.minBy { it.visibleBounds.left }
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
            ) { "Expected the keyboard to be hidden" }
        }
        fun query(value: String, scenario: ActivityScenario<MainActivity>) {
            field().text = value
            hideIme(scenario)
        }
        fun assertContext(value: String) {
            assertEquals(value, field().text)
            get(By.pkg(app.packageName).selected(true).hasChild(By.text(label(R.string.chat_search_all))))
        }
        fun assertNotice(id: Int, keyword: String) {
            assertEquals(28, text(label(id)).visibleBounds.left)
            assertContext(keyword)
        }

        val chats = ChatListApiFixture()
        try {
            chats.snapshot = {
                firstListStarted.countDown()
                check(releaseFirstList.await(40, TimeUnit.SECONDS)) { "Chat list was never released" }
                jsonResponse("""{"chatThreads":[],"latestEventId":null,"latestSeqId":null}""")
            }
            chats.events = { request ->
                if (request.requestUrl?.queryParameter("sinceSeqId") != null)
                    jsonResponse("""{"events":[],"hasMore":false}""")
                else jsonResponse("""{"events":[${chatEventWire(title = title)}],"hasMore":false}""")
            }
            chats.searchMessages = { request ->
                when (request.requestUrl?.queryParameter("keyword")) {
                    noMatch -> {
                        remoteSearches.countDown()
                        unavailable()
                    }
                    "发布检查" -> jsonResponse("""{"results":[]}""")
                    "发布" -> {
                        if (holdWideMessages.get()) {
                            wideMessagesStarted.countDown()
                            check(releaseWideMessages.await(30, TimeUnit.SECONDS)) {
                                "Wide search messages were never released"
                            }
                        }
                        unavailable()
                    }
                    else -> unavailable()
                }
            }
            chats.searchArtifacts = { request ->
                if (request.requestUrl?.queryParameter("keyword") == noMatch) remoteSearches.countDown()
                unavailable()
            }
            chats.searchWorkflows = { unavailable() }
            auth.state.value = testAuthenticationState(user = "search-scope-${UUID.randomUUID()}")
            app.initialPreferences =
                testPreferences().copy(locale = UserPreferencesLocale.ZH_HANS, theme = UserPreferencesTheme.LIGHT)
            app.chatService = chats.service
            app.searchService = chats.service
            app.composerService = chats.service
            app.workflows = chats.service

            device.executeShellCommand("wm density 160")
            device.executeShellCommand("wm size 412x892")
            device.executeShellCommand("settings put $animationSetting 0")
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                try {
                    get(control(R.string.chat_search_workspace)).click()
                    assertTrue(firstListStarted.await(10, TimeUnit.SECONDS))
                    query(noMatch, scenario)
                    assertTrue(remoteSearches.await(10, TimeUnit.SECONDS))
                    get(control(R.string.chat_loading))
                    assertFalse(device.hasObject(By.text(label(R.string.chat_search_failed))))
                    assertContext(noMatch)
                    ScreenshotCapture.capture("search-waiting-phone.png")
                    releaseFirstList.countDown()

                    for (layout in listOf("phone", "wide")) {
                        if (layout == "wide") {
                            device.executeShellCommand("wm size 1000x800")
                            check(
                                device.wait(
                                    object : Condition<UiDevice, Boolean> {
                                        override fun apply(device: UiDevice): Boolean =
                                            device.displayWidth == 1000 &&
                                                device.findObjects(editor).any {
                                                    val bounds = it.visibleBounds
                                                    bounds.left < 100 && bounds.right in 250..320
                                                }
                                    },
                                    10_000,
                                ),
                            ) { "Search did not move into the wide sidebar" }
                            query(noMatch, scenario)
                        }
                        assertNotice(R.string.chat_search_saved_chats_no_matches, noMatch)
                        assertFalse(device.hasObject(By.text(label(R.string.chat_search_no_results))))
                        ScreenshotCapture.capture("search-local-empty-$layout.png")

                        holdWideMessages.set(layout == "wide")
                        query("发布", scenario)
                        if (layout == "wide") {
                            assertTrue(wideMessagesStarted.await(10, TimeUnit.SECONDS))
                            assertEquals(4, get(control(R.string.chat_search_loading)).visibleBounds.height())
                            text(title)
                            assertContext("发布")
                            ScreenshotCapture.capture("search-partial-loading-wide.png")
                            releaseWideMessages.countDown()
                        }
                        assertNotice(R.string.chat_search_partial_local, "发布")
                        text(title)
                        ScreenshotCapture.capture("search-local-matches-$layout.png")

                        query("发布检查", scenario)
                        assertNotice(R.string.chat_search_unavailable, "发布检查")
                        text(title)
                        assertFalse(device.hasObject(By.text(label(R.string.chat_search_partial_local))))
                        ScreenshotCapture.capture("search-partial-$layout.png")
                    }
                } catch (error: Throwable) {
                    runCatching {
                            TestStorage().openOutputFile("workspace-search-window.xml")
                                .use(device::dumpWindowHierarchy)
                            ScreenshotCapture.capture("workspace-search-failure.png")
                        }
                        .exceptionOrNull()?.let(error::addSuppressed)
                    throw error
                }
            }
        } finally {
            releaseFirstList.countDown()
            releaseWideMessages.countDown()
            app.chatService = originalChats
            app.searchService = originalSearch
            app.composerService = originalComposer
            app.workflows = originalWorkflows
            auth.state.value = originalAuth
            app.restoreApiPreferences(originalPreferences)
            app.initialPreferences = initialPreferences
            chats.close()
            originalCache.restore()
            if (originalAnimation == "null" || originalAnimation.isEmpty()) {
                device.executeShellCommand("settings delete $animationSetting")
            } else device.executeShellCommand("settings put $animationSetting $originalAnimation")
            device.executeShellCommand("wm size ${originalSize.ifEmpty { "reset" }}")
            device.executeShellCommand("wm density ${originalDensity.ifEmpty { "reset" }}")
        }
    }
}
