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
import android.os.LocaleList
import android.view.View
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.services.storage.TestStorage
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
    fun capturesListAndWriteControls() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val app = instrumentation.targetContext.applicationContext as TestOkouApplication
        val device = UiDevice.getInstance(instrumentation)
        val auth = app.authentication as TestAuthentication
        val originalAuth = auth.state.value
        val originalChat = app.chatService
        val preferences = app.snapshotApiPreferences()
        val initialPreferences = app.initialPreferences
        val localeManager = checkNotNull(app.getSystemService(LocaleManager::class.java))
        val originalLocale = localeManager.applicationLocales
        val locale = LocaleList.forLanguageTags("zh-Hans")
        val labels = app.createConfigurationContext(
            Configuration(app.resources.configuration).apply { setLocales(locale) },
        )
        val cache = ChatCacheSnapshot(app.noBackupFilesDir.resolve("chat-list"), app.chatCache)
        val originalSize = Regex("Override size: (\\d+x\\d+)").find(shell(device, "wm size"))?.groupValues?.get(1)
        val originalDensity = Regex("Override density: (\\d+)").find(shell(device, "wm density"))?.groupValues?.get(1)
        val fontScale = shell(device, "settings get system font_scale").trim()
        val release = CountDownLatch(1)
        val started = CountDownLatch(1)
        val fixture = ChatListApiFixture()
        fun label(id: Int) = By.pkg(app.packageName).text(labels.getString(id))
        fun politeStatus(id: Int) = device.find(label(id)).also { status ->
            val liveRegion = status.accessibilityNodeInfo.liveRegion
            check(liveRegion == View.ACCESSIBILITY_LIVE_REGION_POLITE) {
                "Expected a polite live region for ${labels.getString(id)}, got $liveRegion"
            }
        }
        try {
            shell(device, "settings put system font_scale 1.0")
            shell(device, "wm size 1080x1920")
            shell(device, "wm density 420")
            app.initialPreferences = testPreferences().copy(
                locale = UserPreferencesLocale.ZH_HANS,
                theme = UserPreferencesTheme.LIGHT,
            )
            instrumentation.runOnMainSync { localeManager.applicationLocales = locale }
            fixture.projects = {
                jsonResponse("""{"projects":[{"id":"$CHAT_PROJECT","name":"用户研究","createdAt":"$CHAT_DATE","updatedAt":"$CHAT_DATE","sortOrder":"a0"}],"latestEventId":null,"latestSeqId":0}""")
            }
            fixture.events = { request ->
                val rows = if (request.requestUrl?.queryParameter("sinceSeqId") == null)
                    chatEventWire(title = "制定下周计划") else ""
                jsonResponse("""{"events":[$rows],"hasMore":false}""")
            }
            fixture.commandResponse = { request ->
                if (request.method == "DELETE" && request.requestUrl?.encodedPath == "/api/projects/$CHAT_PROJECT") {
                    started.countDown()
                    check(release.await(30, TimeUnit.SECONDS))
                    MockResponse().setResponseCode(409)
                } else null
            }
            app.chatService = fixture.service
            for (wide in listOf(false, true)) {
                if (wide) {
                    shell(device, "wm size 1180x920")
                    shell(device, "wm density 160")
                }
                auth.state.value = testAuthenticationState(user = "list-actions-${UUID.randomUUID()}")
                ActivityScenario.launch(MainActivity::class.java).use {
                    val chat = By.pkg(app.packageName).text("制定下周计划")
                    val project = By.pkg(app.packageName).text("用户研究")
                    device.find(project)
                    device.find(chat)
                    device.find(label(R.string.composer_new))
                    ScreenshotCapture.capture(if (wide) "wide-list.png" else "phone-list.png")
                    if (!wide) {
                        device.find(chat).longClick()
                        device.find(label(R.string.chat_rename)).click()
                        val editor = By.pkg(app.packageName).clazz("android.widget.EditText").text("制定下周计划")
                        device.find(editor)
                        ScreenshotCapture.capture("phone-rename.png")
                    } else {
                        device.find(project).longClick()
                        device.find(label(R.string.chat_project_delete)).click()
                        val confirm = device.find(label(R.string.chat_project_delete))
                        ScreenshotCapture.capture("wide-delete-ready.png")
                        confirm.click()
                        check(started.await(10, TimeUnit.SECONDS))
                        check(!politeStatus(R.string.chat_delete_pending).isEnabled)
                        check(!device.hasObject(label(R.string.chat_project_delete)))
                        ScreenshotCapture.capture("wide-delete-pending.png")
                        release.countDown()
                        politeStatus(R.string.chat_project_delete_rejected)
                        val restored = device.find(label(R.string.chat_project_delete))
                        check(restored.isEnabled)
                        ScreenshotCapture.capture("wide-delete-rejected.png")
                    }
                }
            }
        } catch (failure: Throwable) {
            runCatching {
                TestStorage().openOutputFile("diagnostic-hierarchy.xml").use(device::dumpWindowHierarchy)
            }
            throw failure
        } finally {
            release.countDown()
            fixture.close()
            auth.state.value = originalAuth
            app.chatService = originalChat
            app.restoreApiPreferences(preferences)
            app.initialPreferences = initialPreferences
            instrumentation.runOnMainSync { localeManager.applicationLocales = originalLocale }
            shell(device, "wm size ${originalSize ?: "reset"}")
            shell(device, "wm density ${originalDensity ?: "reset"}")
            shell(device, if (fontScale == "null") "settings delete system font_scale" else "settings put system font_scale $fontScale")
            cache.restore()
        }
    }

    private fun shell(device: UiDevice, command: String) = device.executeShellCommand(command)

    private fun UiDevice.find(selector: BySelector) =
        checkNotNull(wait(Until.findObject(selector), 12_000)) { "Missing $selector" }
}
