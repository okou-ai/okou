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
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    @Test
    fun workspaceSearchShowsPartialAndUnavailableReadsInPlace() {
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
        val localized =
            app.createConfigurationContext(
                Configuration(app.resources.configuration).apply {
                    setLocales(LocaleList.forLanguageTags("zh-Hans"))
                },
            )
        val title = "发布检查清单"
        val partialKeyword = "发布"
        val missingKeyword = "客户访谈"
        val emptyKeyword = "预算"
        val editor = By.pkg(app.packageName).clazz("android.widget.EditText")

        fun label(id: Int) = localized.getString(id)
        fun get(selector: BySelector) =
            checkNotNull(device.wait(Until.findObject(selector), 12_000)) {
                "Missing workspace search element: $selector"
            }
        fun text(value: String) = get(By.pkg(app.packageName).text(value))
        fun control(id: Int) = By.pkg(app.packageName).desc(label(id))
        fun field() =
            checkNotNull(device.wait(Until.findObjects(editor), 12_000)) {
                "Missing workspace search editor"
            }.minBy { it.visibleBounds.left }
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
        fun assertContext(keyword: String) {
            assertEquals(keyword, field().text)
            get(By.pkg(app.packageName).selected(true).hasChild(By.text(label(R.string.chat_search_all))))
        }

        val fixture = ChatListApiFixture()
        try {
            fixture.snapshot = {
                jsonResponse("""{"chatThreads":[],"latestEventId":null,"latestSeqId":null}""")
            }
            fixture.events = { request ->
                val events =
                    if (request.requestUrl?.queryParameter("sinceSeqId") == null)
                        chatEventWire(title = title)
                    else ""
                jsonResponse("""{"events":[$events],"hasMore":false}""")
            }
            app.chatService = fixture.service
            app.searchService = fixture.service
            app.composerService = fixture.service
            app.workflows = fixture.service
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
                val started = CountDownLatch(1)
                val release = CountDownLatch(1)
                fixture.searchMessages = { request ->
                    val keyword = request.requestUrl?.queryParameter("keyword")
                    if (keyword == partialKeyword) {
                        started.countDown()
                        check(release.await(35, TimeUnit.SECONDS)) { "Search response was never released" }
                    }
                    if (keyword == partialKeyword || keyword == missingKeyword)
                        jsonResponse("""{"error":{"code":"BAD_REQUEST","message":"Unavailable"}}""")
                            .setResponseCode(400)
                    else jsonResponse("""{"results":[]}""")
                }
                if (short) device.executeShellCommand("settings put $fontScaleSetting 2.0")
                device.executeShellCommand("wm size $size")
                auth.state.value = testAuthenticationState(user = "search-feedback-${UUID.randomUUID()}")
                app.initialPreferences =
                    testPreferences().copy(
                        locale = UserPreferencesLocale.ZH_HANS,
                        theme = if (wide) UserPreferencesTheme.DARK else UserPreferencesTheme.LIGHT,
                    )
                try {
                    ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                        get(control(R.string.chat_search_workspace)).click()
                        if (short) {
                            query(missingKeyword, scenario)
                            text(label(R.string.chat_list_first_load_failed))
                            scenario.onActivity { activity ->
                                assertTrue(activity.resources.configuration.fontScale >= 2f)
                            }
                            assertContext(missingKeyword)
                            ScreenshotCapture.capture("search-unavailable-short-200-percent.png")
                            return@use
                        }
                        query(partialKeyword, scenario)
                        assertTrue(started.await(10, TimeUnit.SECONDS))
                        val row = text(title).visibleBounds
                        val progress = get(control(R.string.chat_search_loading)).visibleBounds
                        assertEquals(4, progress.height())
                        assertContext(partialKeyword)
                        if (wide) {
                            assertTrue(progress.right <= 320)
                            ScreenshotCapture.capture("search-loading-wide.png")
                        }
                        release.countDown()
                        val notice = text(label(R.string.chat_search_unavailable)).visibleBounds
                        assertTrue(notice.top > row.bottom)
                        if (wide) assertTrue(notice.right <= 320)
                        assertEquals(row, text(title).visibleBounds)
                        assertFalse(device.hasObject(control(R.string.chat_search_loading)))
                        ScreenshotCapture.capture("search-partial-$layout.png")

                        query(missingKeyword, scenario)
                        val failure = text(label(R.string.chat_list_first_load_failed)).visibleBounds
                        if (wide) assertTrue(failure.right <= 320)
                        assertContext(missingKeyword)
                        assertFalse(device.hasObject(By.text(label(R.string.chat_search_no_results))))
                        assertFalse(device.hasObject(By.text(label(R.string.chat_search_unavailable))))
                        ScreenshotCapture.capture("search-unavailable-$layout.png")

                        if (!wide) {
                            query(emptyKeyword, scenario)
                            text(label(R.string.chat_search_no_results))
                            assertContext(emptyKeyword)
                            assertFalse(device.hasObject(By.text(label(R.string.chat_list_first_load_failed))))
                            ScreenshotCapture.capture("search-empty-phone.png")
                        }
                    }
                } catch (error: Throwable) {
                    runCatching {
                        TestStorage().openOutputFile("workspace-search-window.xml")
                            .use(device::dumpWindowHierarchy)
                    }.exceptionOrNull()?.let(error::addSuppressed)
                    throw error
                } finally {
                    release.countDown()
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
            fixture.close()
            originalCache.restore()
            if (originalAnimation == "null" || originalAnimation.isEmpty()) {
                device.executeShellCommand("settings delete $animationSetting")
            } else {
                device.executeShellCommand("settings put $animationSetting $originalAnimation")
            }
            if (originalFontScale.toFloatOrNull() == null) {
                device.executeShellCommand("settings delete $fontScaleSetting")
            } else device.executeShellCommand("settings put $fontScaleSetting $originalFontScale")
            device.executeShellCommand("wm size ${originalSize.ifEmpty { "reset" }}")
            device.executeShellCommand("wm density ${originalDensity.ifEmpty { "reset" }}")
        }
    }
}
