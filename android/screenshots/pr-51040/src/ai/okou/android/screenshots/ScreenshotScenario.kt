package ai.okou.android.screenshots

import ai.okou.android.CHAT_DATE
import ai.okou.android.CHAT_PROJECT
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
import android.app.LocaleManager
import android.content.res.Configuration
import android.graphics.Rect
import android.os.LocaleList
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.services.storage.TestStorage
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import java.util.UUID
import org.junit.Test
import org.junit.runner.RunWith
import kotlin.math.roundToInt

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    @Test
    fun capturesConfirmedEmptyProjectAndFilter() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val app = instrumentation.targetContext.applicationContext as TestOkouApplication
        val device = UiDevice.getInstance(instrumentation)
        val auth = app.authentication as TestAuthentication
        val originalAuth = auth.state.value
        val originalChat = app.chatService
        val preferences = app.snapshotApiPreferences()
        val initialPreferences = app.initialPreferences
        val localeManager = checkNotNull(app.getSystemService(LocaleManager::class.java))
        val locale = LocaleList.forLanguageTags("zh-Hans")
        val originalLocale = localeManager.applicationLocales
        val labels = app.createConfigurationContext(
            Configuration(app.resources.configuration).apply { setLocales(locale) },
        )
        val cache = ChatCacheSnapshot(app.noBackupFilesDir.resolve("chat-list"), app.chatCache)
        val originalSize = Regex("Override size: (\\d+x\\d+)").find(device.executeShellCommand("wm size"))?.groupValues?.get(1)
        val originalDensity = Regex("Override density: (\\d+)").find(device.executeShellCommand("wm density"))?.groupValues?.get(1)
        val fontScale = device.executeShellCommand("settings get system font_scale").trim()
        val fixture = ChatListApiFixture()
        val projectTitle = "用户研究"
        val chatTitle = "制定下周计划"
        fun text(label: String) = By.pkg(app.packageName).text(label)
        fun label(id: Int) = text(labels.getString(id))
        fun find(selector: BySelector) =
            checkNotNull(device.wait(Until.findObject(selector), 12_000)) { "Missing $selector" }
        fun assertTouchTarget(selector: BySelector, dpi: Int) {
            val node = generateSequence(find(selector).accessibilityNodeInfo) { it.parent }
                .first { it.isClickable && it.isEnabled }
            val bounds = Rect().also(node::getBoundsInScreen)
            check(bounds.height() >= (48 * dpi / 160f).roundToInt()) {
                "Expected a 48dp target for $selector, got $bounds at $dpi dpi"
            }
        }

        try {
            device.executeShellCommand("settings put system font_scale 1.0")
            app.initialPreferences = testPreferences().copy(
                locale = UserPreferencesLocale.ZH_HANS,
                theme = UserPreferencesTheme.LIGHT,
            )
            instrumentation.runOnMainSync { localeManager.applicationLocales = locale }
            fixture.projects = {
                jsonResponse("""{"projects":[{"id":"$CHAT_PROJECT","name":"$projectTitle","createdAt":"$CHAT_DATE","updatedAt":"$CHAT_DATE","sortOrder":"a0"}],"latestEventId":null,"latestSeqId":0}""")
            }
            fixture.events = { request ->
                val rows = if (request.requestUrl?.queryParameter("sinceSeqId") == null) chatEventWire(title = chatTitle) else ""
                jsonResponse("""{"events":[$rows],"hasMore":false}""")
            }
            app.chatService = fixture.service

            for (wide in listOf(false, true)) {
                val dpi = if (wide) 160 else 420
                val prefix = if (wide) "wide" else "phone"
                device.executeShellCommand(if (wide) "wm size 1180x920" else "wm size 1080x1920")
                device.executeShellCommand("wm density $dpi")
                auth.state.value = testAuthenticationState(user = "empty-list-${UUID.randomUUID()}")
                ActivityScenario.launch(MainActivity::class.java).use {
                    try {
                        find(text(projectTitle))
                        find(text(chatTitle))
                        find(By.pkg(app.packageName).desc(labels.getString(R.string.chat_filter))).click()
                        find(label(R.string.chat_archived)).click()
                        find(label(R.string.chat_empty_archived))
                        assertTouchTarget(label(R.string.chat_back_to_inbox), dpi)
                        ScreenshotCapture.capture("$prefix-empty-filter.png")
                        find(label(R.string.chat_back_to_inbox)).click()
                        find(text(chatTitle))
                        find(text(projectTitle)).click()
                        assertTouchTarget(label(R.string.composer_new_project), dpi)
                        ScreenshotCapture.capture("$prefix-empty-project.png")
                        find(label(R.string.composer_new_project)).click()
                        find(By.pkg(app.packageName).clazz("android.widget.EditText"))
                    } catch (failure: Throwable) {
                        runCatching {
                            TestStorage().openOutputFile("diagnostic-hierarchy.xml").use(device::dumpWindowHierarchy)
                        }
                        throw failure
                    }
                }
            }
        } finally {
            fixture.close()
            auth.state.value = originalAuth
            app.chatService = originalChat
            app.restoreApiPreferences(preferences)
            app.initialPreferences = initialPreferences
            instrumentation.runOnMainSync { localeManager.applicationLocales = originalLocale }
            device.executeShellCommand("wm size ${originalSize ?: "reset"}")
            device.executeShellCommand("wm density ${originalDensity ?: "reset"}")
            device.executeShellCommand(if (fontScale == "null") "settings delete system font_scale" else "settings put system font_scale $fontScale")
            cache.restore()
        }
    }
}
