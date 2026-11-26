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
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicBoolean
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    @Test
    fun workspaceSearchKeepsItsSurfaceAndConfirmedArtifactPages() {
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
        val showIme = device.executeShellCommand("settings get secure show_ime_with_hard_keyboard").trim()
        val animationScale =
            device.executeShellCommand("settings get global animator_duration_scale").trim()
        val localized =
            app.createConfigurationContext(
                Configuration(app.resources.configuration).apply {
                    setLocales(LocaleList.forLanguageTags("zh-Hans"))
                },
            )
        val keyword = "发布"
        val editor = By.pkg(app.packageName).clazz("android.widget.EditText")

        fun label(id: Int) = localized.getString(id)
        fun get(selector: BySelector) =
            checkNotNull(device.wait(Until.findObject(selector), 12_000)) {
                "Missing search element: $selector"
            }
        fun text(value: String) = get(By.pkg(app.packageName).text(value))
        fun control(id: Int) = By.pkg(app.packageName).desc(label(id))
        fun field() =
            checkNotNull(device.wait(Until.findObjects(editor), 12_000)) {
                "Missing workspace search editor"
            }.minBy { it.visibleBounds.left }
        fun type(id: Int, selected: Boolean) =
            get(By.pkg(app.packageName).clickable(true).selected(selected).hasChild(By.text(label(id))))
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
                    val artifacts =
                        ArtifactApiFixture(api, chinese = true).apply {
                            pageSize = 1
                            install()
                        }
                    val respond = api.commandResponse
                    val failOnce = AtomicBoolean(!wide)
                    val cursors = CopyOnWriteArrayList<String?>()
                    api.commandResponse = { request ->
                        val url = request.requestUrl
                        if (url?.encodedPath == "/api/artifacts/catalog" &&
                            url.queryParameter("keyword") == keyword
                        ) {
                            val cursor = url.queryParameter("cursor")
                            cursors.add(cursor)
                            if (cursor == "1" && failOnce.compareAndSet(true, false)) {
                                jsonResponse("""{"error":{"code":"BAD_REQUEST","message":"Unavailable"}}""")
                                    .setResponseCode(400)
                            } else respond(request)
                        } else respond(request)
                    }
                    app.chatService = api.service
                    app.searchService = api.service
                    app.composerService = api.service
                    app.workflows = api.service

                    ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                        text(artifacts.sourceTitle)
                        if (wide) {
                            text(artifacts.sourceTitle).click()
                            text(sourceReply)
                        }
                        val entry = get(control(R.string.chat_search_workspace))
                        val entryBounds = entry.visibleBounds
                        entry.click()
                        waitForIme(true)
                        val editorBounds = field().visibleBounds
                        assertTrue(field().isFocused)
                        assertEquals(48, editorBounds.height())
                        assertEquals(entryBounds.left, editorBounds.left)
                        assertEquals(entryBounds.height(), editorBounds.height())
                        text(artifacts.sourceTitle)
                        if (wide) text(sourceReply)
                        ScreenshotCapture.capture("search-focused-$layout.png")

                        field().text = keyword
                        scenario.onActivity { activity ->
                            WindowCompat.getInsetsController(activity.window, activity.window.decorView)
                                .hide(WindowInsetsCompat.Type.ime())
                        }
                        waitForIme(false)
                        val more = localized.getString(
                            R.string.chat_search_view_type,
                            label(R.string.chat_search_artifacts),
                        )
                        get(By.pkg(app.packageName).desc(more)).click()
                        type(R.string.chat_search_artifacts, selected = true)
                        if (!wide) {
                            text(label(R.string.chat_search_unavailable))
                            text(artifacts.checklist.title)
                            assertFalse(device.hasObject(By.text(artifacts.summary.title)))
                            assertEquals(listOf(null, "1"), cursors.toList())
                            ScreenshotCapture.capture("search-pagination-failed-phone.png")
                            type(R.string.chat_list_title, selected = false).click()
                            text(artifacts.sourceTitle)
                            type(R.string.chat_search_all, selected = false).click()
                            get(By.pkg(app.packageName).desc(more)).click()
                        }

                        text(artifacts.image.title)
                        val finishedCursors =
                            if (wide) listOf(null, "1", "2", "3", "4")
                            else listOf(null, "1", "1", "2", "3", "4")
                        assertEquals(finishedCursors, cursors.toList())
                        type(R.string.chat_list_title, selected = false).click()
                        text(artifacts.sourceTitle)
                        type(R.string.chat_search_all, selected = false).click()
                        get(By.pkg(app.packageName).desc(more)).click()
                        val row = text(artifacts.summary.title)
                        val rowBounds = row.visibleBounds
                        row.click()
                        get(By.pkg(app.packageName).textContains("定位：帮助团队继续推进在手工作"))
                        get(control(R.string.chat_search_close_artifact_preview)).click()
                        type(R.string.chat_search_artifacts, selected = true)
                        assertEquals(keyword, field().text)
                        assertEquals(rowBounds, text(artifacts.summary.title).visibleBounds)
                        text(artifacts.image.title)
                        assertEquals(finishedCursors, cursors.toList())
                        assertFalse(device.hasObject(control(R.string.chat_search_loading)))
                        if (wide) {
                            assertTrue(rowBounds.right <= 320)
                            text(sourceReply)
                        }
                        ScreenshotCapture.capture("search-preview-return-$layout.png")
                    }
                }
            }
        } catch (error: Throwable) {
            runCatching {
                TestStorage().openOutputFile("workspace-search-window.xml").use(device::dumpWindowHierarchy)
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
