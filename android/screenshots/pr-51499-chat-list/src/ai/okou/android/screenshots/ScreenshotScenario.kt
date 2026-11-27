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
import ai.okou.android.auth.ReadyWorkspace
import ai.okou.android.auth.SessionModel
import ai.okou.android.awaitChatList
import ai.okou.android.chat.CachedUnread
import ai.okou.android.chat.ChatListReadFailure
import ai.okou.android.chat.ChatListSource
import ai.okou.android.chat.ChatListUiState
import ai.okou.android.chat.ChatReadPhase
import ai.okou.android.chat.indicatorsRefreshProgressVisible
import ai.okou.android.chat.listRefreshProgressVisible
import ai.okou.android.chatEventWire
import ai.okou.android.chatListRegion
import ai.okou.android.jsonResponse
import ai.okou.android.testAuthenticationState
import ai.okou.android.testPreferences
import android.app.LocaleManager
import android.content.res.Configuration
import android.graphics.Rect
import android.os.LocaleList
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
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
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.mockwebserver.MockResponse
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    @Test
    fun refreshFeedbackKeepsCachedRowsInPlace() {
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
        val metrics = mutableListOf<String>()

        fun text(value: String) = By.pkg(app.packageName).text(value)
        fun text(id: Int) = text(labels.getString(id))
        fun desc(id: Int) = By.pkg(app.packageName).desc(labels.getString(id))
        fun find(selector: BySelector) =
            checkNotNull(device.wait(Until.findObject(selector), 15_000)) { "Missing $selector" }

        fun rowBounds(selector: BySelector): Rect =
            Rect().apply {
                generateSequence(find(selector).accessibilityNodeInfo) { it.parent }
                    .first { it.isClickable }
                    .getBoundsInScreen(this)
            }

        val syncing = desc(R.string.chat_syncing)
        val filter = desc(R.string.chat_filter)
        fun assertProgress(rowBounds: Rect, largeText: Boolean = false) {
            val bar = find(syncing).visibleBounds
            val pane = find(chatListRegion(labels)).visibleBounds
            check(bar.left == pane.left && bar.right == pane.right && bar.height() == 4) {
                "Expected a 4dp bar across pane $pane, found $bar"
            }
            check(bar.top >= find(filter).visibleBounds.bottom && bar.top < rowBounds.top) {
                "Bar $bar must be under the toolbar and above row $rowBounds"
            }
            check(if (largeText) rowBounds.height() > 56 else rowBounds.height() == 56) {
                "Unexpected row bounds $rowBounds at largeText=$largeText"
            }
            metrics += "pane=$pane bar=$bar row=$rowBounds"
        }

        fun owner(scenario: ActivityScenario<MainActivity>): ReadyWorkspace {
            lateinit var session: SessionModel
            scenario.onActivity { session = ViewModelProvider(it)[SessionModel::class.java] }
            return runBlocking {
                withTimeout(15_000) {
                    checkNotNull(session.uiState.first { it.ready != null }.ready)
                }
            }
        }

        fun awaitState(ready: ReadyWorkspace, predicate: (ChatListUiState) -> Boolean) =
            runBlocking { withTimeout(15_000) { ready.chats.uiState.first { predicate(it) } } }

        fun awaitRetirement(ready: ReadyWorkspace) {
            val job = checkNotNull(ready.chats.viewModelScope.coroutineContext[Job])
            runBlocking { withTimeout(10_000) { job.join() } }
        }

        try {
            device.executeShellCommand("wm density 160")
            device.executeShellCommand("settings put system font_scale 1.0")
            instrumentation.runOnMainSync { localeManager.applicationLocales = locales }
            for ((wide, largeText) in listOf(false to false, true to false, true to true)) {
                device.executeShellCommand("settings put system font_scale ${if (largeText) 2.0 else 1.0}")
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
                    fixture.events = { request ->
                        val events =
                            if (request.requestUrl?.queryParameter("sinceSeqId") != null) ""
                            else buildList {
                                add(chatEventWire(title = personal))
                                add(
                                    chatEventWire(
                                        id = "77777777-7777-4777-8777-777777777777",
                                        seq = 23,
                                        thread = CHAT_IN_PROJECT,
                                        title = child,
                                        extra = ",\"projectId\":\"$CHAT_PROJECT\"",
                                    ),
                                )
                                for ((index, title) in
                                    listOf("周会纪要", "用户反馈整理", "差旅安排", "报销流程", "阅读笔记").withIndex()
                                ) {
                                    val suffix = index.toString().padStart(12, '0')
                                    add(
                                        chatEventWire(
                                            id = "41000000-0000-4000-8000-$suffix",
                                            seq = 24L + index,
                                            thread = "01000000-0000-4000-8000-$suffix",
                                            title = title,
                                        ),
                                    )
                                }
                            }.joinToString(",")
                        jsonResponse("""{"events":[$events],"hasMore":false}""")
                    }
                    val unread = mapOf(CHAT_IN_PROJECT to CHAT_DATE)
                    fixture.indicators = {
                        jsonResponse(
                            """{"threads":{"$CHAT_IN_PROJECT":"unread"},"unreadAt":{"$CHAT_IN_PROJECT":"$CHAT_DATE"}}""",
                        )
                    }
                    auth.state.value = testAuthenticationState(user = "chat-refresh-${UUID.randomUUID()}")
                    val previous =
                        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                            owner(scenario).also { ready ->
                                awaitState(ready) {
                                    it.source == ChatListSource.Network &&
                                        it.projectsSource == ChatListSource.Network &&
                                        it.indicators != null
                                }
                            }
                        }
                    awaitRetirement(previous)
                    runBlocking {
                        app.chatCache.open(previous.identity) { true }.use { lease ->
                            val now = System.currentTimeMillis()
                            val stale = now - TimeUnit.MINUTES.toMillis(11)
                            val checkpoint = checkNotNull(lease.load()).checkpoint
                            check(lease.save(checkpoint, if (wide) now else stale))
                            check(lease.saveUnread(CachedUnread(if (wide) stale else now, unread)))
                        }
                    }
                    val firstStarted = CountDownLatch(1)
                    val releaseFirst = CountDownLatch(1)
                    val secondStarted = CountDownLatch(1)
                    val releaseSecond = CountDownLatch(1)
                    if (wide) {
                        val indicators = fixture.indicators
                        fixture.indicators = {
                            firstStarted.countDown()
                            check(releaseFirst.await(30, TimeUnit.SECONDS))
                            indicators()
                        }
                    } else {
                        val events = fixture.events
                        val requests = AtomicInteger()
                        fixture.events = { request ->
                            when (requests.incrementAndGet()) {
                                1 -> {
                                    firstStarted.countDown()
                                    check(releaseFirst.await(30, TimeUnit.SECONDS))
                                    MockResponse().setResponseCode(503).setHeader("Retry-After", "1")
                                }
                                2 -> {
                                    secondStarted.countDown()
                                    check(releaseSecond.await(30, TimeUnit.SECONDS))
                                    events(request)
                                }
                                else -> events(request)
                            }
                        }
                    }
                    var current: ReadyWorkspace? = null
                    try {
                        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                            try {
                                val ready = owner(scenario)
                                current = ready
                                device.awaitChatList(labels)
                                check(firstStarted.await(10, TimeUnit.SECONDS))
                                if (wide) {
                                    awaitState(ready) {
                                        it.listPhase == ChatReadPhase.Ready &&
                                            it.indicatorsRefreshProgressVisible
                                    }
                                    find(text(personal)).click()
                                    if (!largeText) find(text(reply))
                                    check(!device.hasObject(syncing))
                                    if (!largeText) ScreenshotCapture.capture("03-wide-inbox-quiet.png")
                                    find(filter).click()
                                    find(text(R.string.chat_unread)).click()
                                    find(text(project)).click()
                                    val before = rowBounds(text(child))
                                    assertProgress(before, largeText)
                                    if (!largeText) find(text(reply))
                                    ScreenshotCapture.capture(if (largeText) "05-wide-large-text.png" else "04-wide-unread-refresh.png")
                                    releaseFirst.countDown()
                                    check(device.wait(Until.gone(syncing), 10_000))
                                    check(before == rowBounds(text(child)))
                                    if (!largeText) find(text(reply))
                                } else {
                                    val initial = awaitState(ready) {
                                        it.source == ChatListSource.Cache &&
                                            it.listRefreshProgressVisible
                                    }
                                    check(initial.listReadFailure == null)
                                    val before = rowBounds(text(project))
                                    assertProgress(before)
                                    ScreenshotCapture.capture("01-phone-stale-refresh.png")
                                    releaseFirst.countDown()
                                    awaitState(ready) {
                                        it.listReadFailure == ChatListReadFailure.Retrying
                                    }
                                    check(device.hasObject(syncing))
                                    check(secondStarted.await(10, TimeUnit.SECONDS))
                                    assertProgress(before)
                                    check(before == rowBounds(text(project)))
                                    releaseSecond.countDown()
                                    check(device.wait(Until.gone(syncing), 10_000))
                                    check(before == rowBounds(text(project)))
                                    ScreenshotCapture.capture("02-phone-refresh-complete.png")
                                }
                            } catch (failure: Throwable) {
                                runCatching {
                                    TestStorage()
                                        .openOutputFile("chat-list-refresh-hierarchy.xml")
                                        .use(device::dumpWindowHierarchy)
                                }
                                throw failure
                            } finally {
                                releaseFirst.countDown()
                                releaseSecond.countDown()
                            }
                        }
                    } finally {
                        current?.let(::awaitRetirement)
                    }
                }
            }
            TestStorage().openOutputFile("chat-list-refresh-geometry.txt").use {
                it.write(metrics.joinToString("\n", postfix = "\n").encodeToByteArray())
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
