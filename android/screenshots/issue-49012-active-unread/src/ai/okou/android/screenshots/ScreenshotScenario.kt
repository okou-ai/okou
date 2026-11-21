package ai.okou.android.screenshots

import ai.okou.android.CHAT_DATE
import ai.okou.android.CHAT_IN_PROJECT
import ai.okou.android.CHAT_OTHER_AGENT
import ai.okou.android.CHAT_PERSONAL
import ai.okou.android.CHAT_PROJECT
import ai.okou.android.ChatCacheSnapshot
import ai.okou.android.ChatListApiFixture
import ai.okou.android.MainActivity
import ai.okou.android.R
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestOkouApplication
import ai.okou.android.auth.SessionModel
import ai.okou.android.chatEventWire
import ai.okou.android.jsonResponse
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.Job
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    @Test
    fun acknowledgesUnreadRepliesWithoutClearingTheRunningIndicator() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val app = instrumentation.targetContext.applicationContext as TestOkouApplication
        val device = UiDevice.getInstance(instrumentation)
        val savedSize =
            Regex("Override size: (\\d+x\\d+)")
                .find(device.executeShellCommand("wm size"))
                ?.groupValues
                ?.get(1)
        val savedDensity =
            Regex("Override density: (\\d+)")
                .find(device.executeShellCommand("wm density"))
                ?.groupValues
                ?.get(1)
        val savedAnimationScale =
            device.executeShellCommand("settings get global animator_duration_scale").trim()
        val savedService = app.chatService
        val savedOnline = app.connectivity.value
        val preferences = app.snapshotApiPreferences()
        val cache = ChatCacheSnapshot(app.noBackupFilesDir.resolve("chat-list"), app.chatCache)
        val fixture = ChatListApiFixture()
        val personalTitle = "Weekly planning notes"
        val projectTitle = "Quarterly research brief"
        val unread = ConcurrentHashMap.newKeySet<String>()
        unread += CHAT_PERSONAL
        unread += CHAT_IN_PROJECT
        val marked = ConcurrentHashMap.newKeySet<String>()
        val events =
            listOf(
                chatEventWire(title = personalTitle),
                chatEventWire(
                    id = UUID.randomUUID().toString(),
                    seq = 23,
                    thread = CHAT_IN_PROJECT,
                    extra = ",\"projectId\":\"$CHAT_PROJECT\"",
                    title = projectTitle,
                    agent = CHAT_OTHER_AGENT,
                ),
                chatEventWire(
                    id = UUID.randomUUID().toString(),
                    seq = 24,
                    thread = CHAT_IN_PROJECT,
                    kind = "archived",
                    agent = CHAT_OTHER_AGENT,
                ),
            )
        fixture.events = { request ->
            val since = request.requestUrl?.queryParameter("sinceSeqId")?.toLong() ?: 0
            val tail = if (since == 0L) events.joinToString(",") else ""
            jsonResponse("""{"events":[$tail],"hasMore":false}""")
        }
        fixture.commandResponse = { request ->
            val url = checkNotNull(request.requestUrl)
            when {
                url.encodedPath == "/api/indicators" -> {
                    val watermarkIds = unread.toList()
                    val activeUnread = url.queryParameter("includeActiveUnread") == "true"
                    val watermarks =
                        watermarkIds
                            .filter { it != CHAT_IN_PROJECT || activeUnread }
                            .joinToString(",") { "\"$it\":\"$CHAT_DATE\"" }
                    val ordinary =
                        if (CHAT_PERSONAL in watermarkIds) ",\"$CHAT_PERSONAL\":\"unread\"" else ""
                    jsonResponse(
                        """{"agents":{},"threads":{"$CHAT_IN_PROJECT":"active"$ordinary},"unreadAt":{$watermarks}}"""
                    )
                }
                request.method == "POST" && url.pathSegments.last() == "mark-read" -> {
                    val target = url.pathSegments[2]
                    assertTrue(unread.remove(target))
                    assertTrue(marked.add(target))
                    jsonResponse("""{"lastReadAt":"$CHAT_DATE"}""")
                }
                else -> null
            }
        }
        fun text(label: String) = By.pkg(app.packageName).text(label)
        fun description(label: Int) = By.pkg(app.packageName).desc(app.getString(label))
        fun see(selector: BySelector) =
            checkNotNull(device.wait(Until.findObject(selector), 10_000)) { "Missing $selector" }
        fun button(selector: BySelector) =
            generateSequence(see(selector)) { it.parent }.first { it.isClickable }
        fun filter() = button(description(R.string.chat_filter)).click()

        var job: Job? = null
        app.chatService = fixture.service
        app.connectivity.value = true
        try {
            device.executeShellCommand("wm density 160")
            device.executeShellCommand("wm size 400x800")
            device.executeShellCommand("settings put global animator_duration_scale 0")
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                scenario.onActivity {
                    job =
                        ViewModelProvider(it)[SessionModel::class.java]
                            .uiState
                            .value
                            .ready
                            ?.chats
                            ?.viewModelScope
                            ?.coroutineContext
                            ?.get(Job)
                }
                see(text(personalTitle))
                filter()
                val markAll = text(app.getString(R.string.chat_mark_all_read))
                assertTrue(device.wait(Until.hasObject(By.copy(markAll).enabled(true)), 10_000))
                ScreenshotCapture.capture("filter-menu.png")

                button(text(app.getString(R.string.chat_unread))).click()
                val list = description(R.string.chat_list_title)
                val unreadHeading = see(text(app.getString(R.string.chat_unread)).hasAncestor(list))
                assertEquals(28, unreadHeading.visibleBounds.left)
                see(text("Research"))
                assertTrue(device.wait(Until.gone(text(projectTitle)), 10_000))
                ScreenshotCapture.capture("unread-collapsed.png")

                button(text("Research")).click()
                see(text(projectTitle))
                ScreenshotCapture.capture("unread-running.png")
                button(text("Research")).click()
                assertTrue(device.wait(Until.gone(text(projectTitle)), 10_000))

                filter()
                button(markAll).click()
                see(text("Marked 2 chats as read."))
                see(text(app.getString(R.string.chat_empty)))
                assertEquals(setOf(CHAT_PERSONAL, CHAT_IN_PROJECT), marked)
                ScreenshotCapture.capture("bulk-read.png")

                filter()
                button(text(app.getString(R.string.chat_archived))).click()
                see(text(app.getString(R.string.chat_archived)).hasAncestor(list))
                button(text("Research")).click()
                see(text(projectTitle))
                ScreenshotCapture.capture("acknowledged-running.png")
            }
        } finally {
            try {
                runBlocking { withTimeout(10_000) { job?.join() } }
                fixture.close()
                cache.restore()
                app.restoreApiPreferences(preferences)
            } finally {
                app.chatService = savedService
                app.connectivity.value = savedOnline
                device.executeShellCommand("wm size " + (savedSize ?: "reset"))
                device.executeShellCommand("wm density " + (savedDensity ?: "reset"))
                if (savedAnimationScale.toFloatOrNull() != null) {
                    device.executeShellCommand(
                        "settings put global animator_duration_scale $savedAnimationScale"
                    )
                } else {
                    device.executeShellCommand("settings delete global animator_duration_scale")
                }
            }
        }
    }
}
