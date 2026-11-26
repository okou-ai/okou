package ai.okou.android.screenshots

import ai.okou.android.CHAT_DATE
import ai.okou.android.CHAT_IN_PROJECT
import ai.okou.android.CHAT_PERSONAL
import ai.okou.android.ChatCacheSnapshot
import ai.okou.android.ChatListApiFixture
import ai.okou.android.MainActivity
import ai.okou.android.R
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.TestRealtimeService
import ai.okou.android.api.generated.UserPreferencesLocale
import ai.okou.android.api.generated.UserPreferencesTheme
import ai.okou.android.awaitChatList
import ai.okou.android.chat.ChatChanges
import ai.okou.android.chatEventWire
import ai.okou.android.chatListRegion
import ai.okou.android.jsonResponse
import ai.okou.android.openChatListSettings
import ai.okou.android.testAuthenticationState
import ai.okou.android.testPreferences
import android.app.LocaleManager
import android.content.Context
import android.content.res.Configuration
import android.os.LocaleList
import android.os.SystemClock
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
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference
import okhttp3.mockwebserver.MockResponse
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    private enum class Phase {
        Confirmed,
        Retrying,
        Returning,
    }

    @Test
    fun reopeningTheListStartsFreshWhileTheConfirmedRowsStayVisible() {
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
            for (wide in listOf(false, true)) {
                device.executeShellCommand(if (wide) "wm size 1180x920" else "wm size 440x900")
                auth.state.value = testAuthenticationState(user = "chat-list-visit-${UUID.randomUUID()}")
                evidence.put(captureVisit(app, device, labels, wide))
            }
            TestStorage().openOutputFile("visit-evidence.json").use {
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

    private fun captureVisit(
        app: TestOkouApplication,
        device: UiDevice,
        labels: Context,
        wide: Boolean,
    ): JSONObject {
        val realtime = app.realtimeService as TestRealtimeService
        val firstTitle = "制定下周计划"
        val secondTitle = "设计交付检查"
        val thirdTitle = "新同步的聊天"
        val phase = AtomicReference(Phase.Confirmed)
        val failures = AtomicInteger()
        val thirdFailureAt = AtomicLong()
        val returnReadAt = AtomicLong()
        val returnRequest = CountDownLatch(1)
        val releaseResponse = CountDownLatch(1)
        val serverRetrySeconds = 60
        val prefix = if (wide) "wide-inbox" else "phone-unread"
        val events = listOf(
            chatEventWire(seq = 17, title = firstTitle),
            chatEventWire("77777777-7777-4777-8777-000000000018", 18, CHAT_IN_PROJECT, title = secondTitle),
            chatEventWire("77777777-7777-4777-8777-000000000019", 19, "11111111-1111-4111-8111-111111111113", title = thirdTitle),
        )
        fun reply(read: (Phase) -> MockResponse): MockResponse =
            when (val current = phase.get()) {
                Phase.Confirmed -> read(current)
                Phase.Retrying -> MockResponse().setResponseCode(503).apply {
                    if (failures.incrementAndGet() >= 3) {
                        thirdFailureAt.compareAndSet(0, SystemClock.elapsedRealtime())
                        setHeader("Retry-After", serverRetrySeconds)
                    }
                }
                Phase.Returning -> {
                    if (returnReadAt.compareAndSet(0, SystemClock.elapsedRealtime())) {
                        returnRequest.countDown()
                        check(releaseResponse.await(25, TimeUnit.SECONDS))
                    }
                    read(current)
                }
            }
        fun text(label: String) = By.pkg(app.packageName).text(label)
        fun text(id: Int) = text(labels.getString(id))
        fun desc(id: Int) = By.pkg(app.packageName).desc(labels.getString(id))
        fun find(selector: BySelector) =
            checkNotNull(device.wait(Until.findObject(selector), 15_000)) { "Missing $selector" }
        val progress = desc(R.string.chat_syncing)
        val filter = desc(R.string.chat_filter)
        return ChatListApiFixture().use { fixture ->
            app.chatService = fixture.service
            fixture.events = { request ->
                val since = request.requestUrl?.queryParameter("sinceSeqId")?.toLongOrNull() ?: 0L
                fun payload(count: Int): MockResponse {
                    val tail = events.take(count).filterIndexed { index, _ -> 17 + index > since }
                    return jsonResponse("""{"events":[${tail.joinToString(",")}],"hasMore":false}""")
                }
                if (wide) reply { payload(if (it == Phase.Returning) 3 else 2) } else payload(2)
            }
            fixture.indicators = {
                fun payload(includeSecond: Boolean): MockResponse {
                    val unread = JSONObject().put(CHAT_PERSONAL, CHAT_DATE)
                    if (includeSecond) unread.put(CHAT_IN_PROJECT, CHAT_DATE)
                    return jsonResponse("""{"threads":{},"unreadAt":$unread}""")
                }
                if (wide) payload(false) else reply { payload(it == Phase.Returning) }
            }
            ActivityScenario.launch(MainActivity::class.java).use {
                try {
                    device.awaitChatList(labels)
                    find(text(firstTitle))
                    find(text(secondTitle))
                    if (!wide) {
                        find(filter).click()
                        find(text(R.string.chat_unread)).click()
                        check(device.wait(Until.gone(text(secondTitle)), 5_000))
                        find(text(firstTitle))
                    }
                    val initialRow = find(text(firstTitle)).visibleBounds
                    val initialToolbar = find(filter).visibleBounds
                    check(!device.hasObject(progress))

                    phase.set(Phase.Retrying)
                    realtime.invalidate(ChatChanges(list = wide, indicators = !wide))
                    val retryBounds = find(progress).visibleBounds
                    check(failures.get() == 3)
                    check(find(text(firstTitle)).visibleBounds == initialRow)
                    check(find(filter).visibleBounds == initialToolbar)
                    ScreenshotCapture.capture("$prefix-retry.png")

                    device.openChatListSettings(labels)
                    find(text(R.string.settings))
                    check(device.wait(Until.gone(chatListRegion(labels)), 5_000))
                    val back = find(desc(R.string.back))
                    val backAt = SystemClock.elapsedRealtime()
                    phase.set(Phase.Returning)
                    back.click()
                    check(returnRequest.await(10, TimeUnit.SECONDS)) { "No new request on list return" }
                    val readAt = returnReadAt.get()
                    check(readAt >= backAt)
                    check(readAt - thirdFailureAt.get() < serverRetrySeconds * 1_000L)
                    check(failures.get() == 3)
                    val region = device.awaitChatList(labels).visibleBounds
                    check(find(text(firstTitle)).visibleBounds == initialRow)
                    check(find(filter).visibleBounds == initialToolbar)
                    check(device.wait(Until.gone(progress), 5_000))
                    check(!device.hasObject(text(if (wide) thirdTitle else secondTitle)))
                    ScreenshotCapture.capture("$prefix-reopened.png")

                    releaseResponse.countDown()
                    find(text(if (wide) thirdTitle else secondTitle))
                    check(!device.hasObject(progress))
                    ScreenshotCapture.capture("$prefix-refreshed.png")
                    JSONObject()
                        .put("scenario", prefix)
                        .put("listBounds", region.toShortString())
                        .put("progressBounds", retryBounds.toShortString())
                        .put("rowBounds", initialRow.toShortString())
                        .put("toolbarBounds", initialToolbar.toShortString())
                        .put("retryAfterSeconds", serverRetrySeconds)
                        .put("newReadAfterBackMillis", readAt - backAt)
                        .put("newReadAfterThirdFailureMillis", readAt - thirdFailureAt.get())
                } finally {
                    releaseResponse.countDown()
                }
            }
        }
    }
}
