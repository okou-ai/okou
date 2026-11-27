package ai.okou.android.screenshots

import ai.okou.android.CHAT_DATE
import ai.okou.android.CHAT_PERSONAL
import ai.okou.android.ChatCacheSnapshot
import ai.okou.android.ChatListApiFixture
import ai.okou.android.MainActivity
import ai.okou.android.R
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.api.generated.UserPreferencesLocale
import ai.okou.android.api.generated.UserPreferencesTheme
import ai.okou.android.awaitChatList
import ai.okou.android.chatEventWire
import ai.okou.android.jsonResponse
import ai.okou.android.testAuthenticationState
import ai.okou.android.testPreferences
import android.app.LocaleManager
import android.content.res.Configuration
import android.os.LocaleList
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import okhttp3.mockwebserver.MockResponse
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    @Test
    fun projectFirstReadUsesPartialContentOrFailureIllustration() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val app = instrumentation.targetContext.applicationContext as TestOkouApplication
        val device = UiDevice.getInstance(instrumentation)
        val auth = app.authentication as TestAuthentication
        val priorAuth = auth.state.value
        val priorService = app.chatService
        val priorPreferences = app.snapshotApiPreferences()
        val priorInitialPreferences = app.initialPreferences
        val localeManager = checkNotNull(app.getSystemService(LocaleManager::class.java))
        val priorLocales = localeManager.applicationLocales
        val locales = LocaleList.forLanguageTags("zh-Hans")
        val labels = app.createConfigurationContext(
            Configuration(app.resources.configuration).apply { setLocales(locales) },
        )
        val priorSize = Regex("Override size: (\\d+x\\d+)").find(device.executeShellCommand("wm size"))
            ?.groupValues?.get(1)
        val priorDensity = Regex("Override density: (\\d+)").find(device.executeShellCommand("wm density"))
            ?.groupValues?.get(1)
        val priorFontScale = device.executeShellCommand("settings get system font_scale").trim()
        val cache = ChatCacheSnapshot(app.noBackupFilesDir.resolve("chat-list"), app.chatCache)
        val personal = "制定下周计划"
        val event = chatEventWire(seq = 17, title = personal)
        fun text(value: String) = By.pkg(app.packageName).text(value)
        fun text(id: Int) = text(labels.getString(id))
        fun desc(id: Int) = By.pkg(app.packageName).desc(labels.getString(id))
        fun find(selector: BySelector) =
            checkNotNull(device.wait(Until.findObject(selector), 15_000)) { "Missing $selector" }

        try {
            device.executeShellCommand("wm density 160")
            device.executeShellCommand("settings put system font_scale 1.0")
            instrumentation.runOnMainSync { localeManager.applicationLocales = locales }
            for (wide in listOf(false, true)) {
                val viewport = if (wide) "wide" else "phone"
                val theme = if (wide) UserPreferencesTheme.DARK else UserPreferencesTheme.LIGHT
                app.initialPreferences = testPreferences().copy(theme = theme, locale = UserPreferencesLocale.ZH_HANS)
                device.executeShellCommand(if (wide) "wm size 1180x920" else "wm size 440x900")
                for (hasChat in listOf(true, false)) {
                    ChatListApiFixture().use { fixture ->
                        app.chatService = fixture.service
                        val releaseProjects = CountDownLatch(1)
                        fixture.projects = {
                            check(releaseProjects.await(20, TimeUnit.SECONDS))
                            MockResponse().setResponseCode(if (hasChat) 404 else 400)
                        }
                        fixture.events = { request ->
                            val rows = if (hasChat && request.requestUrl?.queryParameter("sinceSeqId") == null) event else ""
                            jsonResponse("""{"events":[$rows],"hasMore":false}""")
                        }
                        fixture.indicators = {
                            val unread = if (hasChat) """ "$CHAT_PERSONAL":"$CHAT_DATE" """ else ""
                            jsonResponse("""{"threads":{},"unreadAt":{$unread}}""")
                        }
                        auth.state.value = testAuthenticationState(user = "project-list-${UUID.randomUUID()}")
                        try {
                            ActivityScenario.launch(MainActivity::class.java).use {
                                device.awaitChatList(labels)
                                val before = if (hasChat) find(text(personal)).visibleBounds
                                    else find(desc(R.string.chat_loading)).visibleBounds
                                val newChat = find(text(R.string.composer_new)).visibleBounds
                                releaseProjects.countDown()
                                if (hasChat) {
                                    val notice = find(text(R.string.chat_metadata_unavailable)).visibleBounds
                                    check(find(text(personal)).visibleBounds == before)
                                    check(newChat.top > notice.bottom)
                                    ScreenshotCapture.capture("$viewport-partial.png")
                                } else {
                                    find(text(R.string.chat_list_first_load_failed))
                                    check(!device.hasObject(text(R.string.chat_empty)))
                                    check(!device.hasObject(text(R.string.chat_metadata_unavailable)))
                                    check(find(text(R.string.composer_new)).visibleBounds == newChat)
                                    ScreenshotCapture.capture("$viewport-unavailable.png")
                                }
                            }
                        } finally {
                            releaseProjects.countDown()
                        }
                    }
                }
            }
        } finally {
            auth.state.value = priorAuth
            app.chatService = priorService
            app.restoreApiPreferences(priorPreferences)
            app.initialPreferences = priorInitialPreferences
            instrumentation.runOnMainSync { localeManager.applicationLocales = priorLocales }
            device.executeShellCommand("wm size ${priorSize ?: "reset"}")
            device.executeShellCommand("wm density ${priorDensity ?: "reset"}")
            device.executeShellCommand(
                if (priorFontScale == "null") "settings delete system font_scale"
                else "settings put system font_scale $priorFontScale",
            )
            cache.restore()
        }
    }
}
