package ai.okou.android.screenshots

import ai.okou.android.CHAT_DATE
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
import android.content.Context
import android.content.res.Configuration
import android.graphics.Rect
import android.os.LocaleList
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.services.storage.TestStorage
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
import androidx.test.uiautomator.Direction
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import okhttp3.mockwebserver.MockResponse
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    @Test
    fun batchFeedbackOverlaysTheSameChatListPosition() {
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
        val priorSize =
            Regex("Override size: (\\d+x\\d+)").find(device.executeShellCommand("wm size"))
                ?.groupValues?.get(1)
        val priorDensity =
            Regex("Override density: (\\d+)").find(device.executeShellCommand("wm density"))
                ?.groupValues?.get(1)
        val priorFontScale = device.executeShellCommand("settings get system font_scale").trim()
        val cache = ChatCacheSnapshot(app.noBackupFilesDir.resolve("chat-list"), app.chatCache)
        try {
            device.executeShellCommand("wm density 160")
            device.executeShellCommand("settings put system font_scale 1.0")
            app.initialPreferences = testPreferences().copy(
                theme = UserPreferencesTheme.LIGHT,
                locale = UserPreferencesLocale.ZH_HANS,
            )
            instrumentation.runOnMainSync { localeManager.applicationLocales = locales }
            val evidence = JSONArray()
            for ((name, size) in listOf("phone" to "440x900", "wide" to "1180x920", "short" to "760x340")) {
                device.executeShellCommand("wm size $size")
                auth.state.value = testAuthenticationState(user = "list-feedback-${UUID.randomUUID()}")
                evidence.put(capturePane(app, device, labels, name))
            }
            TestStorage().openOutputFile("feedback-evidence.json").use {
                it.write(evidence.toString().toByteArray(Charsets.UTF_8))
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

    private fun capturePane(
        app: TestOkouApplication,
        device: UiDevice,
        labels: Context,
        prefix: String,
    ): JSONObject {
        fun id(index: Int) = "31990000-0000-4000-8000-${index.toString().padStart(12, '0')}"
        fun title(index: Int) = "方案讨论 ${index.toString().padStart(2, '0')}"
        fun text(title: String) = By.pkg(app.packageName).text(title)
        fun find(selector: BySelector) =
            checkNotNull(device.wait(Until.findObject(selector), 10_000)) { "Missing $selector" }

        val events = (1..18).joinToString(",") { index ->
            chatEventWire(id(index + 100), index.toLong(), id(index), title = title(index))
        }
        val accepted = AtomicBoolean(false)
        val successId = id(18)
        val rejectedId = id(17)
        return ChatListApiFixture().use { fixture ->
            app.chatService = fixture.service
            fixture.events = { request ->
                val rows = if (request.requestUrl?.queryParameter("sinceSeqId") == null) events else ""
                jsonResponse("""{"events":[$rows],"hasMore":false}""")
            }
            fixture.indicators = {
                val unread = listOfNotNull(rejectedId, successId.takeUnless { accepted.get() })
                val states = JSONObject()
                val timestamps = JSONObject()
                unread.forEach { id ->
                    states.put(id, "unread")
                    timestamps.put(id, CHAT_DATE)
                }
                jsonResponse(JSONObject().put("threads", states).put("unreadAt", timestamps).toString())
            }
            fixture.commandResponse = { request ->
                when (request.requestUrl?.encodedPath) {
                    "/api/chat-threads/$successId/mark-read" -> {
                        accepted.set(true)
                        jsonResponse("""{"lastReadAt":"$CHAT_DATE"}""")
                    }
                    "/api/chat-threads/$rejectedId/mark-read" -> MockResponse().setResponseCode(409)
                    else -> null
                }
            }
            ActivityScenario.launch(MainActivity::class.java).use {
                val list = device.awaitChatList(labels)
                find(text(title(18)))
                val listBounds = Rect(list.visibleBounds)
                if (prefix != "short") {
                    var more = true
                    repeat(18) {
                        if (more) more = list.scroll(Direction.DOWN, 0.8f)
                    }
                    check(!more)
                    find(text(title(1)))
                }
                val anchor = device.findObjects(By.pkg(app.packageName).textStartsWith("方案讨论 "))
                    .filter { it.visibleBounds.top >= listBounds.top }
                    .minBy { it.visibleBounds.top }
                val anchorText = anchor.text
                val anchorBounds = Rect(anchor.visibleBounds)
                val actionSelector = text(labels.getString(R.string.composer_new))
                fun listAction() = device.findObjects(actionSelector).firstOrNull {
                    it.visibleBounds.right <= listBounds.right && it.visibleBounds.top >= listBounds.top
                }
                val actionBounds = Rect(checkNotNull(listAction()).visibleBounds)
                if (prefix == "short") check(actionBounds.bottom < anchorBounds.top)
                ScreenshotCapture.capture("$prefix-before.png")

                find(By.pkg(app.packageName).desc(labels.getString(R.string.chat_filter))).click()
                find(text(labels.getString(R.string.chat_mark_all_read)).enabled(true)).click()
                val message = text(labels.getString(R.string.chat_mark_all_read_partial_failed, 1, 1))
                val notice = find(message)
                check(find(text(anchorText)).visibleBounds == anchorBounds)
                check(device.awaitChatList(labels).visibleBounds == listBounds)
                check(listAction()?.visibleBounds == actionBounds)
                val noticeBounds = Rect(notice.visibleBounds)
                ScreenshotCapture.capture("$prefix-feedback.png")
                check(device.wait(Until.gone(message), 10_000))
                check(find(text(anchorText)).visibleBounds == anchorBounds)

                JSONObject().put("scenario", prefix)
                    .put("listBounds", listBounds.toShortString())
                    .put("rowBounds", anchorBounds.toShortString())
                    .put("actionLabelBounds", actionBounds.toShortString())
                    .put("feedbackLabelBounds", noticeBounds.toShortString())
            }
        }
    }
}
