package ai.okou.android.screenshots

import ai.okou.android.ArtifactApiFixture
import ai.okou.android.ChatCacheSnapshot
import ai.okou.android.ChatListApiFixture
import ai.okou.android.MainActivity
import ai.okou.android.R
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.api.generated.UserPreferencesLocale
import ai.okou.android.api.generated.UserPreferencesTheme
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
    fun workspaceSearchShowsReadingFeedbackAndGroupedActions() {
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
        val cache = ChatCacheSnapshot(app.noBackupFilesDir.resolve("chat-list"), app.chatCache)
        val originalSize =
            device.executeShellCommand("wm size").substringAfter("Override size: ", "").trim()
        val originalDensity =
            device.executeShellCommand("wm density").substringAfter("Override density: ", "").trim()
        val fontScale = device.executeShellCommand("settings get system font_scale").trim()
        val showIme =
            device.executeShellCommand("settings get secure show_ime_with_hard_keyboard").trim()
        val animationScale =
            device.executeShellCommand("settings get global animator_duration_scale").trim()
        val localized =
            app.createConfigurationContext(
                Configuration(app.resources.configuration).apply {
                    setLocales(LocaleList.forLanguageTags("zh-Hans"))
                },
            )
        val keyword = "发布"

        fun label(id: Int) = localized.getString(id)
        fun get(selector: BySelector) =
            checkNotNull(device.wait(Until.findObjects(selector), 12_000)) {
                "Missing workspace search element: $selector"
            }.minBy { it.visibleBounds.left }
        fun text(value: String) = get(By.pkg(app.packageName).text(value))
        fun control(id: Int) = By.pkg(app.packageName).desc(label(id))
        fun editor() = get(By.pkg(app.packageName).clazz("android.widget.EditText"))
        fun waitForIme(visible: Boolean) {
            check(
                device.wait(
                    object : Condition<UiDevice, Boolean> {
                        override fun apply(device: UiDevice): Boolean =
                            instrumentation.uiAutomation.windows.any {
                                it.type == AccessibilityWindowInfo.TYPE_INPUT_METHOD
                            } == visible
                    },
                    10_000,
                ),
            ) { "Expected keyboard visibility: $visible" }
        }
        fun restoreSetting(namespace: String, name: String, value: String) {
            if (value.toFloatOrNull() == null) {
                device.executeShellCommand("settings delete $namespace $name")
            } else {
                device.executeShellCommand("settings put $namespace $name $value")
            }
        }

        try {
            device.executeShellCommand("wm density 160")
            device.executeShellCommand("settings put system font_scale 1.0")
            device.executeShellCommand("settings put secure show_ime_with_hard_keyboard 1")
            device.executeShellCommand("settings put global animator_duration_scale 0")
            for (layout in listOf("phone", "wide")) {
                val wide = layout == "wide"
                val size = if (wide) "1000x800" else "412x892"
                device.executeShellCommand("wm size $size")
                auth.state.value = testAuthenticationState(user = "search-capture-${UUID.randomUUID()}")
                app.initialPreferences =
                    testPreferences().copy(
                        locale = UserPreferencesLocale.ZH_HANS,
                        theme = if (wide) UserPreferencesTheme.DARK else UserPreferencesTheme.LIGHT,
                    )

                ChatListApiFixture().use { api ->
                    val sourceReply = "已核对官网长版和社区配图，接下来确认发布时间。"
                    api.historyReply = sourceReply
                    val started = CountDownLatch(1)
                    val release = CountDownLatch(1)
                    val artifacts =
                        ArtifactApiFixture(api, chinese = true).apply {
                            beforeCatalog = { request ->
                                val url = checkNotNull(request.requestUrl)
                                if (
                                    url.queryParameter("keyword") == keyword &&
                                        url.queryParameter("cursor") == null
                                ) {
                                    started.countDown()
                                    check(release.await(20, TimeUnit.SECONDS)) {
                                        "Timed out waiting for the partial results screenshot"
                                    }
                                }
                            }
                            install()
                        }
                    app.chatService = api.service
                    app.searchService = api.service
                    app.composerService = api.service
                    app.workflows = api.service

                    ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                        try {
                            val chat = text(artifacts.sourceTitle)
                            if (wide) {
                                chat.click()
                                text(sourceReply)
                            }
                            get(control(R.string.chat_search_workspace)).click()
                            waitForIme(true)
                            val field = editor()
                            assertTrue(field.isFocused)
                            assertEquals(48, field.visibleBounds.height())
                            field.text = keyword
                            scenario.onActivity { activity ->
                                WindowCompat.getInsetsController(activity.window, activity.window.decorView)
                                    .hide(WindowInsetsCompat.Type.ime())
                            }
                            waitForIme(false)
                            assertTrue("Artifact lookup did not start", started.await(10, TimeUnit.SECONDS))
                            val rowBounds = text(artifacts.sourceTitle).visibleBounds
                            val progress = get(control(R.string.chat_search_loading)).visibleBounds
                            assertEquals(4, progress.height())
                            assertTrue(progress.bottom <= rowBounds.top)
                            assertFalse(device.hasObject(By.text(artifacts.checklist.title)))
                            if (wide) {
                                assertTrue(progress.right <= 320)
                                text(sourceReply)
                            }
                            ScreenshotCapture.capture("search-reading-$layout.png")

                            release.countDown()
                            text(artifacts.site.title)
                            val moreLabel = localized.getString(
                                R.string.chat_search_view_type,
                                label(R.string.chat_search_artifacts),
                            )
                            val more = By.pkg(app.packageName).desc(moreLabel)
                            val actionBounds = get(more).visibleBounds
                            assertTrue(actionBounds.height() >= 48)
                            assertTrue(actionBounds.width() >= 48)
                            assertEquals(rowBounds, text(artifacts.sourceTitle).visibleBounds)
                            assertFalse(device.hasObject(By.text(artifacts.slides.title)))
                            assertFalse(device.hasObject(control(R.string.chat_search_loading)))
                            assertEquals(listOf(null to keyword), artifacts.catalogQueries.filter { it.second == keyword })
                            ScreenshotCapture.capture("search-grouped-$layout.png")

                            get(more).click()
                            get(
                                By.pkg(app.packageName).selected(true).focused(true)
                                    .hasChild(By.text(label(R.string.chat_search_artifacts))),
                            )
                            assertEquals(keyword, editor().text)
                            text(artifacts.slides.title)
                            if (wide) text(sourceReply)
                            assertEquals(listOf(null to keyword), artifacts.catalogQueries.filter { it.second == keyword })
                        } finally {
                            release.countDown()
                        }
                    }
                }
            }
        } catch (error: Throwable) {
            runCatching {
                TestStorage().openOutputFile("search-read-feedback-window.xml")
                    .use(device::dumpWindowHierarchy)
            }.exceptionOrNull()?.let(error::addSuppressed)
            throw error
        } finally {
            app.chatService = originalChats
            app.searchService = originalSearch
            app.composerService = originalComposer
            app.workflows = originalWorkflows
            auth.state.value = originalAuth
            app.restoreApiPreferences(originalPreferences)
            app.initialPreferences = initialPreferences
            cache.restore()
            restoreSetting("system", "font_scale", fontScale)
            restoreSetting("secure", "show_ime_with_hard_keyboard", showIme)
            restoreSetting("global", "animator_duration_scale", animationScale)
            device.executeShellCommand("wm size ${originalSize.ifEmpty { "reset" }}")
            device.executeShellCommand("wm density ${originalDensity.ifEmpty { "reset" }}")
        }
    }
}
