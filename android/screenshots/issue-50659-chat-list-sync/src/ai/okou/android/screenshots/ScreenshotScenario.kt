package ai.okou.android.screenshots

import ai.okou.android.BuildConfig
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
import ai.okou.android.api.generated.ChatArchive
import ai.okou.android.api.generated.ChatEvents
import ai.okou.android.api.generated.UserPreferencesLocale
import ai.okou.android.api.generated.UserPreferencesTheme
import ai.okou.android.auth.WorkspaceIdentity
import ai.okou.android.auth.scopeHash
import ai.okou.android.awaitChatList
import ai.okou.android.chat.CachedUnread
import ai.okou.android.chat.ChatCheckpoint
import ai.okou.android.chat.ChatCursor
import ai.okou.android.chat.cursor
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
import androidx.test.uiautomator.UiObject2
import androidx.test.uiautomator.Until
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import okhttp3.mockwebserver.MockResponse
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.model.MultipleFailureException

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    @Test
    fun capturesWorkspaceListDuringIndicatorRecovery() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val app = instrumentation.targetContext.applicationContext as TestOkouApplication
        val device = UiDevice.getInstance(instrumentation)
        val auth = app.authentication as TestAuthentication
        val originalAuth = auth.state.value
        val originalChat = app.chatService
        val originalOnline = app.connectivity.value
        val originalPreferences = app.snapshotApiPreferences()
        val originalInitialPreferences = app.initialPreferences
        val localeManager = checkNotNull(app.getSystemService(LocaleManager::class.java))
        val originalLocale = localeManager.applicationLocales
        val locales = LocaleList.forLanguageTags("zh-Hans")
        val labels =
            app.createConfigurationContext(
                Configuration(app.resources.configuration).apply { setLocales(locales) },
            )
        val cache = ChatCacheSnapshot(app.noBackupFilesDir.resolve("chat-list"), app.chatCache)
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
        val originalFont = device.executeShellCommand("settings get system font_scale").trim()
        val originalMotion =
            device.executeShellCommand("settings get global animator_duration_scale").trim()
        val fixture = ChatListApiFixture()
        val coldResponse = CountDownLatch(1)
        val firstRetryableResponse = CountDownLatch(1)
        val fourthRequest = CountDownLatch(1)
        val finalResponse = CountDownLatch(1)
        val wideResponse = CountDownLatch(1)
        val attempts = AtomicInteger()
        val focusChat = "制定下周计划"
        val archivedChat = "客户沟通记录"
        val archivedThread = "11111111-1111-4111-8111-111111111112"
        val projectChat = "梳理访谈问题"
        val projectName = "产品研究"
        val inboxRows =
            listOf(
                chatEventWire(seq = 17, title = focusChat),
                chatEventWire(
                    "77777777-7777-4777-8777-000000000018",
                    18,
                    CHAT_IN_PROJECT,
                    extra = ",\"projectId\":\"$CHAT_PROJECT\"",
                    title = projectChat,
                ),
                chatEventWire(
                    "77777777-7777-4777-8777-000000000019",
                    19,
                    archivedThread,
                    title = archivedChat,
                ),
                chatEventWire(
                    "77777777-7777-4777-8777-000000000020",
                    20,
                    archivedThread,
                    kind = "archived",
                ),
            )
        val emptyIndicators = """{"threads":{},"unreadAt":{}}"""
        fixture.events = { request ->
            val since = request.requestUrl?.queryParameter("sinceSeqId")?.toLongOrNull() ?: 0L
            val events = inboxRows.filterIndexed { index, _ -> 17 + index > since }
            jsonResponse("""{"events":[${events.joinToString(",")}],"hasMore":false}""")
        }
        fixture.projects = {
            jsonResponse(
                """{"projects":[{"id":"$CHAT_PROJECT","name":"$projectName","createdAt":"$CHAT_DATE","updatedAt":"$CHAT_DATE"}],"latestEventId":null,"latestSeqId":0}""",
            )
        }
        fixture.indicators = {
            check(coldResponse.await(45, TimeUnit.SECONDS))
            jsonResponse(emptyIndicators)
        }

        fun text(value: String) = By.pkg(app.packageName).text(value)
        fun text(id: Int) = text(labels.getString(id))
        fun desc(id: Int) = By.pkg(app.packageName).desc(labels.getString(id))
        fun find(selector: BySelector) = device.await(selector)
        fun selectFilter(id: Int) {
            find(desc(R.string.chat_filter)).click()
            find(text(id)).click()
            check(
                device.wait(
                    Until.gone(
                        By.pkg(app.packageName)
                            .text(labels.getString(R.string.chat_inbox))
                            .clickable(true),
                    ),
                    10_000,
                ),
            )
        }

        val loading = desc(R.string.chat_loading)
        val progress = desc(R.string.chat_syncing)
        fun seedList(user: String, unreadAgeMillis: Long) {
            val workspace =
                WorkspaceIdentity(
                    BuildConfig.API_ORIGIN,
                    user,
                    "session-a",
                    "org-a",
                    scopeHash(listOf("org:member")),
                )
            val rows =
                Json.decodeFromString<ChatEvents>(
                        """{"events":[${inboxRows.joinToString(",")}],"hasMore":false}""",
                    )
                    .events
            val now = System.currentTimeMillis()
            runBlocking {
                app.chatCache
                    .open(workspace) { true }
                    .use { lease ->
                        check(
                            lease.save(
                                ChatCheckpoint(
                                    ChatArchive(emptyList()),
                                    ChatCursor(),
                                    rows,
                                    rows.last().cursor(),
                                ),
                                now,
                            ),
                        )
                        check(
                            lease.saveUnread(
                                CachedUnread(
                                    now - unreadAgeMillis,
                                    mapOf(CHAT_PERSONAL to CHAT_DATE),
                                ),
                            ),
                        )
                    }
            }
        }

        val failures = mutableListOf<Throwable>()
        try {
            device.executeShellCommand("wm size 440x900")
            device.executeShellCommand("wm density 160")
            device.executeShellCommand("settings put system font_scale 1.0")
            device.executeShellCommand("settings put global animator_duration_scale 0")
            app.chatService = fixture.service
            app.connectivity.value = true
            app.initialPreferences =
                testPreferences()
                    .copy(
                        locale = UserPreferencesLocale.ZH_HANS,
                        theme = UserPreferencesTheme.LIGHT,
                    )
            instrumentation.runOnMainSync { localeManager.applicationLocales = locales }
            auth.state.value = testAuthenticationState(user = "list-initial-${UUID.randomUUID()}")
            ActivityScenario.launch(MainActivity::class.java).use {
                device.awaitChatList(labels)
                find(text(focusChat))
                selectFilter(R.string.chat_unread)
                find(loading)
                check(!device.hasObject(text(R.string.chat_empty_unread)))
                check(!device.hasObject(progress))
                ScreenshotCapture.capture("phone-initial-unread.png")
                coldResponse.countDown()
                find(text(R.string.chat_empty_unread))
            }

            val cachedUser = "list-cached-${UUID.randomUUID()}"
            seedList(cachedUser, 300_000L)
            fixture.indicators = {
                val attempt = attempts.incrementAndGet()
                if (attempt == 1) check(firstRetryableResponse.await(45, TimeUnit.SECONDS))
                if (attempt <= 3) MockResponse().setResponseCode(503)
                else {
                    fourthRequest.countDown()
                    check(finalResponse.await(45, TimeUnit.SECONDS))
                    jsonResponse(emptyIndicators)
                }
            }
            auth.state.value = testAuthenticationState(user = cachedUser)
            ActivityScenario.launch(MainActivity::class.java).use {
                device.awaitChatList(labels)
                find(text(projectName))
                find(text(focusChat))
                check(!device.hasObject(progress))
                ScreenshotCapture.capture("phone-cached-inbox.png")
                selectFilter(R.string.chat_unread)
                val before = find(text(focusChat)).visibleBounds
                check(!device.hasObject(loading))
                check(!device.hasObject(progress))

                firstRetryableResponse.countDown()
                val bar = find(progress).visibleBounds
                check(attempts.get() >= 3)
                check(bar.height() == 4) { "Expected 4 dp progress height at mdpi, saw $bar" }
                check(bar.top == device.awaitChatList(labels).visibleBounds.top) {
                    "Progress must overlay the list's leading edge"
                }
                check(find(text(focusChat)).visibleBounds == before)
                check(!device.hasObject(text(R.string.chat_empty_unread)))
                ScreenshotCapture.capture("phone-retrying-unread.png")

                check(fourthRequest.await(10, TimeUnit.SECONDS)) {
                    "Fourth indicator request did not start"
                }
                selectFilter(R.string.chat_archived)
                find(text(archivedChat))
                check(device.wait(Until.gone(progress), 10_000))
                check(!device.hasObject(text(R.string.chat_refresh_failed)))
                ScreenshotCapture.capture("phone-archived-quiet.png")
                selectFilter(R.string.chat_unread)
                find(progress)
                check(find(text(focusChat)).visibleBounds == before)
                finalResponse.countDown()
                find(text(R.string.chat_empty_unread))
                check(device.wait(Until.gone(progress), 10_000))
                ScreenshotCapture.capture("phone-settled-unread.png")
            }

            val wideUser = "list-wide-${UUID.randomUUID()}"
            seedList(wideUser, 660_000L)
            fixture.indicators = {
                check(wideResponse.await(45, TimeUnit.SECONDS))
                jsonResponse(emptyIndicators)
            }
            device.executeShellCommand("wm size 1180x920")
            auth.state.value = testAuthenticationState(user = wideUser)
            ActivityScenario.launch(MainActivity::class.java).use {
                val region = device.awaitChatList(labels).visibleBounds
                check(region.width() == 344) { "Expected a 344 dp wide list at mdpi, saw $region" }
                find(text(focusChat))
                check(!device.hasObject(progress))
                selectFilter(R.string.chat_unread)
                val bar = find(progress).visibleBounds
                check(bar.height() == 4 && bar.width() == 344 && bar.top == region.top)
                find(text(focusChat))
                ScreenshotCapture.capture("wide-stale-unread.png")
                wideResponse.countDown()
                find(text(R.string.chat_empty_unread))
            }
        } catch (failure: Throwable) {
            failures += failure
        } finally {
            coldResponse.countDown()
            firstRetryableResponse.countDown()
            finalResponse.countDown()
            wideResponse.countDown()
            for (cleanup in
                listOf<() -> Unit>(
                    { fixture.close() },
                    { cache.restore() },
                    { app.restoreApiPreferences(originalPreferences) },
                    { app.initialPreferences = originalInitialPreferences },
                    { app.chatService = originalChat },
                    { app.connectivity.value = originalOnline },
                    { auth.state.value = originalAuth },
                    {
                        instrumentation.runOnMainSync {
                            localeManager.applicationLocales = originalLocale
                        }
                    },
                    { device.executeShellCommand("wm size ${originalSize ?: "reset"}") },
                    { device.executeShellCommand("wm density ${originalDensity ?: "reset"}") },
                    { device.restoreSetting("system", "font_scale", originalFont) },
                    { device.restoreSetting("global", "animator_duration_scale", originalMotion) },
                )) {
                try {
                    cleanup()
                } catch (failure: Throwable) {
                    failures += failure
                }
            }
        }
        MultipleFailureException.assertEmpty(failures)
    }

    private fun UiDevice.restoreSetting(namespace: String, name: String, original: String) {
        if (original == "null") executeShellCommand("settings delete $namespace $name")
        else executeShellCommand("settings put $namespace $name $original")
    }

    private fun UiDevice.await(selector: BySelector): UiObject2 =
        checkNotNull(wait(Until.findObject(selector), 12_000)) { "Missing $selector" }
}
