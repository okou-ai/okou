package ai.okou.android.screenshots

import ai.okou.android.CHAT_DATE
import ai.okou.android.CHAT_IN_PROJECT
import ai.okou.android.CHAT_PERSONAL
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
import ai.okou.android.awaitChatList
import ai.okou.android.awaitKeyboardFocus
import ai.okou.android.chatEventWire
import ai.okou.android.jsonResponse
import ai.okou.android.rowEvent
import ai.okou.android.rowEventTail
import ai.okou.android.testAuthenticationState
import ai.okou.android.testPreferences
import android.app.LocaleManager
import android.content.res.Configuration
import android.graphics.Rect
import android.os.LocaleList
import android.view.KeyEvent
import android.view.accessibility.AccessibilityNodeInfo
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
import java.util.concurrent.atomic.AtomicBoolean
import okhttp3.mockwebserver.MockResponse
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    @Test
    fun chatUndoRestoresTheRowBeforeTheInverseReturns() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val app = instrumentation.targetContext.applicationContext as TestOkouApplication
        val device = UiDevice.getInstance(instrumentation)
        val auth = app.authentication as TestAuthentication
        val originalAuth = auth.state.value
        val originalService = app.chatService
        val originalPreferences = app.snapshotApiPreferences()
        val originalInitialPreferences = app.initialPreferences
        val localeManager = checkNotNull(app.getSystemService(LocaleManager::class.java))
        val originalLocales = localeManager.applicationLocales
        val locales = LocaleList.forLanguageTags("zh-Hans")
        val labels =
            app.createConfigurationContext(
                Configuration(app.resources.configuration).apply { setLocales(locales) },
            )
        val originalSize =
            Regex("Override size: (\\d+x\\d+)")
                .find(device.executeShellCommand("wm size"))
                ?.groupValues
                ?.get(1)
        val originalDensity =
            Regex("Override density: (\\d+)")
                .find(device.executeShellCommand("wm density"))
                ?.groupValues
                ?.get(1)
        val originalFontScale = device.executeShellCommand("settings get system font_scale").trim()
        val cache = ChatCacheSnapshot(app.noBackupFilesDir.resolve("chat-list"), app.chatCache)
        val personal = "制定下周计划"
        val project = "产品调研"
        val child = "发布清单"
        val reply = "发布清单已整理好。你可以先确认交付节点，再把清单发给团队。"

        fun text(value: String) = By.pkg(app.packageName).text(value)
        fun text(id: Int) = text(labels.getString(id))
        fun desc(id: Int) = By.pkg(app.packageName).desc(labels.getString(id))
        fun find(selector: BySelector) =
            checkNotNull(device.wait(Until.findObject(selector), 15_000)) { "Missing $selector" }

        fun actionNode(selector: BySelector): AccessibilityNodeInfo =
            generateSequence(find(selector).accessibilityNodeInfo) { it.parent }
                .first { it.isClickable && it.isEnabled }

        fun bounds(selector: BySelector) =
            Rect().apply { actionNode(selector).getBoundsInScreen(this) }

        val undo = text(R.string.chat_undo)
        val newChat = text(R.string.composer_new)
        fun offerBounds() {
            val dismiss = bounds(desc(R.string.chat_feedback_dismiss))
            val action = bounds(undo)
            val fab = bounds(newChat)
            check(action.width() >= 48 && action.height() >= 48) { "Undo target is $action" }
            check(dismiss.width() == 48 && dismiss.height() == 48) { "Dismiss target is $dismiss" }
            check(dismiss.left - action.right == 4) { "Unexpected Undo action spacing" }
            check(fab.top - dismiss.bottom == 8) {
                "Unexpected Snackbar gap: FAB=$fab dismiss=$dismiss"
            }
        }

        try {
            device.executeShellCommand("wm density 160")
            device.executeShellCommand("settings put system font_scale 1.0")
            instrumentation.runOnMainSync { localeManager.applicationLocales = locales }
            for (wide in listOf(false, true)) {
                device.executeShellCommand(if (wide) "wm size 1180x920" else "wm size 440x900")
                val theme = if (wide) UserPreferencesTheme.DARK else UserPreferencesTheme.LIGHT
                app.initialPreferences =
                    testPreferences().copy(theme = theme, locale = UserPreferencesLocale.ZH_HANS)
                ChatListApiFixture().use { fixture ->
                    app.chatService = fixture.service
                    fixture.historyReply = reply
                    fixture.projects = {
                        jsonResponse(
                            """{"projects":[{"id":"$CHAT_PROJECT","name":"$project","createdAt":"$CHAT_DATE","updatedAt":"$CHAT_DATE"}],"latestEventId":null,"latestSeqId":0}""",
                        )
                    }
                    fixture.events = {
                        val childEvent =
                            chatEventWire(
                                id = "77777777-7777-4777-8777-777777777777",
                                seq = 23,
                                thread = CHAT_IN_PROJECT,
                                title = child,
                                extra = ",\"projectId\":\"$CHAT_PROJECT\"",
                            )
                        jsonResponse(
                            """{"events":[${chatEventWire(title = personal)},$childEvent],"hasMore":false}""",
                        )
                    }
                    val events = fixture.rowEventTail()
                    val unread = AtomicBoolean(wide)
                    fixture.indicators = {
                        if (unread.get())
                            jsonResponse(
                                """{"threads":{"$CHAT_PERSONAL":"unread"},"unreadAt":{"$CHAT_PERSONAL":"$CHAT_DATE"}}""",
                            )
                        else jsonResponse("""{"threads":{},"unreadAt":{}}""")
                    }
                    val inverseStarted = CountDownLatch(1)
                    val releaseInverse = CountDownLatch(1)
                    val inverseReplied = CountDownLatch(1)
                    fixture.commandResponse = { request ->
                        when (request.requestUrl?.encodedPath) {
                            "/api/chat-threads/$CHAT_PERSONAL/archive" -> {
                                events += 24L to request.rowEvent(24, CHAT_PERSONAL, "archived")
                                MockResponse().setResponseCode(204)
                            }
                            "/api/chat-threads/$CHAT_PERSONAL/unarchive" -> {
                                inverseStarted.countDown()
                                check(releaseInverse.await(25, TimeUnit.SECONDS))
                                MockResponse().setResponseCode(400)
                            }
                            "/api/chat-threads/$CHAT_PERSONAL/mark-read" -> {
                                unread.set(false)
                                jsonResponse("""{"lastReadAt":"$CHAT_DATE"}""")
                            }
                            "/api/chat-threads/$CHAT_PERSONAL/mark-unread" -> {
                                inverseStarted.countDown()
                                check(releaseInverse.await(25, TimeUnit.SECONDS))
                                unread.set(true)
                                inverseReplied.countDown()
                                jsonResponse("""{"lastReadAt":null}""")
                            }
                            else -> null
                        }
                    }
                    auth.state.value =
                        testAuthenticationState(user = "chat-undo-${UUID.randomUUID()}")
                    ActivityScenario.launch(MainActivity::class.java).use {
                        try {
                            device.awaitChatList(labels)
                            find(text(personal))
                            if (wide) {
                                find(text(project)).click()
                                find(text(child)).click()
                                find(text(reply))
                                find(desc(R.string.chat_filter)).click()
                                find(text(R.string.chat_unread)).click()
                            }
                            find(text(personal)).longClick()
                            find(text(if (wide) R.string.chat_mark_read else R.string.chat_archive))
                                .click()
                            check(device.wait(Until.gone(text(personal)), 10_000))
                            find(
                                text(
                                    if (wide) R.string.chat_undo_marked_read
                                    else R.string.chat_undo_archived,
                                ),
                            )
                            device.waitForIdle()
                            offerBounds()
                            val name = if (wide) "wide-unread" else "phone-archive"
                            instrumentation.setInTouchMode(false)
                            check(
                                actionNode(undo).performAction(AccessibilityNodeInfo.ACTION_FOCUS),
                            )
                            device.awaitKeyboardFocus(undo)
                            ScreenshotCapture.capture("$name-undo.png")
                            check(device.pressKeyCode(KeyEvent.KEYCODE_ENTER))
                            check(inverseStarted.await(10, TimeUnit.SECONDS))
                            check(device.wait(Until.gone(undo), 10_000))
                            device.awaitKeyboardFocus(text(personal))
                            if (wide) {
                                check(!unread.get())
                                find(text(reply))
                            }
                            ScreenshotCapture.capture("$name-restored.png")
                            releaseInverse.countDown()
                            if (wide) {
                                check(inverseReplied.await(10, TimeUnit.SECONDS))
                                find(By.copy(text(personal)).longClickable(true))
                                find(text(reply))
                            } else {
                                find(text(R.string.chat_undo_failed))
                                check(device.wait(Until.gone(text(personal)), 10_000))
                                ScreenshotCapture.capture("phone-archive-rollback.png")
                            }
                        } catch (failure: Throwable) {
                            runCatching {
                                TestStorage()
                                    .openOutputFile("undo-hierarchy.xml")
                                    .use(device::dumpWindowHierarchy)
                            }
                            throw failure
                        } finally {
                            releaseInverse.countDown()
                        }
                    }
                }
            }
        } finally {
            auth.state.value = originalAuth
            app.chatService = originalService
            app.restoreApiPreferences(originalPreferences)
            app.initialPreferences = originalInitialPreferences
            instrumentation.runOnMainSync { localeManager.applicationLocales = originalLocales }
            device.executeShellCommand("wm size ${originalSize ?: "reset"}")
            device.executeShellCommand("wm density ${originalDensity ?: "reset"}")
            device.executeShellCommand(
                if (originalFontScale == "null") "settings delete system font_scale"
                else "settings put system font_scale $originalFontScale",
            )
            cache.restore()
        }
    }
}
