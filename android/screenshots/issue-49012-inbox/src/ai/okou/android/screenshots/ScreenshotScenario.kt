package ai.okou.android.screenshots

import ai.okou.android.BuildConfig
import ai.okou.android.CHAT_DATE
import ai.okou.android.CHAT_IN_PROJECT
import ai.okou.android.CHAT_OTHER_AGENT
import ai.okou.android.CHAT_PERSONAL
import ai.okou.android.CHAT_PROJECT
import ai.okou.android.ChatCacheSnapshot
import ai.okou.android.ChatListApiFixture
import ai.okou.android.MainActivity
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestOkouApplication
import ai.okou.android.api.generated.AndroidUpdates
import ai.okou.android.api.generated.AndroidUpdatesRelease
import ai.okou.android.auth.SessionModel
import ai.okou.android.awaitChatList
import ai.okou.android.chatEventWire
import ai.okou.android.jsonResponse
import ai.okou.android.updates.AppUpdates
import ai.okou.android.updates.UpdateRecord
import ai.okou.android.updates.UpdateService
import ai.okou.android.updates.UpdateStore
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
import androidx.test.uiautomator.Condition
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import java.io.File
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Job
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.model.MultipleFailureException

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    @Test
    fun inboxFiltersAndReadAll() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val app = instrumentation.targetContext.applicationContext as TestOkouApplication
        val device = UiDevice.getInstance(instrumentation)
        val oldService = app.chatService
        val preferences = app.snapshotApiPreferences()
        val cache = ChatCacheSnapshot(app.noBackupFilesDir.resolve("chat-list"), app.chatCache)
        val fixture = ChatListApiFixture()
        val previousUpdate = app.updateOwner
        val updateGate = CompletableDeferred<Unit>()
        val updateOwner = screenshotUpdateOwner(updateGate)
        val oldAnimatorScale =
            device
                .executeShellCommand("settings get global animator_duration_scale")
                .trim()
                .toFloatOrNull()
        val oldSize =
            Regex("Override size: (\\d+x\\d+)")
                .find(device.executeShellCommand("wm size"))
                ?.groupValues
                ?.get(1)
        val oldDensity =
            Regex("Override density: (\\d+)")
                .find(device.executeShellCommand("wm density"))
                ?.groupValues
                ?.get(1)
        val archived = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        val running = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
        val mutedRunning = "aaaaaaaa-bbbb-4aaa-8aaa-bbbbbbbbbbbb"
        val personalTitle = "Summarize customer interviews"
        val archivedTitle = "Review October campaign"
        val unread =
            ConcurrentHashMap.newKeySet<String>().apply {
                add(CHAT_PERSONAL)
                add(archived)
                add(running)
            }
        val events =
            listOf(
                chatEventWire(title = personalTitle),
                chatEventWire(
                    id = "77777777-7777-4777-8777-777777777777",
                    seq = 18,
                    thread = CHAT_IN_PROJECT,
                    extra = ",\"projectId\":\"$CHAT_PROJECT\"",
                    title = "Prepare launch notes",
                    agent = CHAT_OTHER_AGENT,
                ),
                chatEventWire(
                    id = "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
                    seq = 19,
                    thread = archived,
                    extra = ",\"projectId\":\"$CHAT_PROJECT\"",
                    title = archivedTitle,
                    agent = CHAT_OTHER_AGENT,
                ),
                chatEventWire(
                    id = "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
                    seq = 20,
                    thread = archived,
                    kind = "archived",
                    agent = CHAT_OTHER_AGENT,
                ),
                chatEventWire(
                    id = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
                    seq = 21,
                    thread = running,
                    title = "Find launch partners",
                ),
                chatEventWire(
                    id = "ffffffff-ffff-4fff-8fff-ffffffffffff",
                    seq = 22,
                    thread = mutedRunning,
                    title = "Check release notes",
                ),
                chatEventWire(
                    id = "99999999-9999-4999-8999-999999999999",
                    seq = 23,
                    thread = mutedRunning,
                    kind = "sort_touched",
                    extra = ",\"muted\":true",
                ),
            )
        fixture.events = { request ->
            val rows =
                if (request.requestUrl?.queryParameter("sinceSeqId") == null)
                    events.joinToString(",")
                else ""
            jsonResponse("""{"events":[$rows],"hasMore":false}""")
        }
        fixture.indicators = {
            val snapshot = unread.toList()
            val status =
                snapshot.filterNot { it == running }.joinToString("") { ",\"$it\":\"unread\"" }
            val markers = snapshot.joinToString(",") { "\"$it\":\"$CHAT_DATE\"" }
            jsonResponse(
                """{"agents":{},"threads":{"$running":"active","$mutedRunning":"active"$status},"unreadAt":{$markers}}"""
            )
        }
        fixture.commandResponse = { request ->
            val path = request.requestUrl?.pathSegments.orEmpty()
            val id = path.getOrNull(2)
            if (
                request.method == "POST" &&
                    path.lastOrNull() == "mark-read" &&
                    (id == CHAT_PERSONAL || id == archived || id == running)
            ) {
                unread.remove(id)
                jsonResponse("""{"lastReadAt":"$CHAT_DATE"}""")
            } else null
        }
        app.chatService = fixture.service
        app.updateOwner = updateOwner
        app.restoreApiPreferences(emptyMap())

        var scenario: ActivityScenario<MainActivity>? = null
        var chatJob: Job? = null
        val failures = mutableListOf<Throwable>()
        fun text(label: String) = By.pkg(app.packageName).text(label)
        fun description(label: String) = By.pkg(app.packageName).desc(label)
        fun find(selector: BySelector) =
            checkNotNull(device.wait(Until.findObject(selector), 10_000)) { "Missing $selector" }
        fun openFilter() = find(description("Filter")).click()
        try {
            device.executeShellCommand("settings put global animator_duration_scale 1")
            scenario = ActivityScenario.launch(MainActivity::class.java)
            find(text(personalTitle))
            find(text("Prepare launch notes"))
            find(text("Find launch partners"))
            find(text("Check release notes"))
            scenario.onActivity { activity ->
                chatJob =
                    checkNotNull(
                            ViewModelProvider(activity)[SessionModel::class.java]
                                .uiState
                                .value
                                .ready
                        )
                        .chats
                        .viewModelScope
                        .coroutineContext[Job]
            }
            ScreenshotCapture.capture("00-inbox-running.png")
            openFilter()
            find(text("Inbox"))
            check(device.wait(Until.hasObject(text("Mark all as read").enabled(true)), 10_000))
            ScreenshotCapture.capture("01-filter-menu.png")
            find(text("Unread")).click()
            find(text(archivedTitle))
            find(text(personalTitle))
            find(text("Find launch partners"))
            ScreenshotCapture.capture("02-unread-filter.png")

            find(text("Research")).click()
            check(device.wait(Until.gone(text(archivedTitle)), 10_000))
            openFilter()
            find(text("Mark all as read").enabled(true)).click()
            find(text("Marked 3 chats as read."))
            find(text("No chats in this view."))
            ScreenshotCapture.capture("03-read-all-complete.png")
            find(text("Unread")).click()
            find(text(personalTitle)).click()
            find(text("Completed"))

            device.executeShellCommand("wm size 1200x900")
            device.executeShellCommand("wm density 160")
            check(
                device.wait(
                    object : Condition<UiDevice, Boolean> {
                        override fun apply(device: UiDevice): Boolean {
                            var isWide = false
                            checkNotNull(scenario).onActivity { activity ->
                                val config = activity.resources.configuration
                                isWide = config.screenWidthDp >= 840 && config.screenHeightDp >= 480
                            }
                            return isWide
                        }
                    },
                    10_000,
                )
            )
            openFilter()
            find(text("Archived")).click()
            find(text("Research")).click()
            find(text(archivedTitle))
            find(text("Completed"))
            val listBounds = device.awaitChatList(app).visibleBounds
            check(find(description("Filter")).visibleBounds.right <= listBounds.right)
            openFilter()
            check(find(text("Inbox")).visibleBounds.right <= listBounds.right)
            // UI Automator exposes the text child separately for a disabled Compose item.
            find(text("Mark all as read")).click()
            device.waitForIdle()
            find(text("Mark all as read"))
            ScreenshotCapture.capture("04-wide-archived.png")

            check(device.pressBack())
            updateGate.complete(Unit)
            find(text("Update"))
            find(description("More actions")).click()
            find(text("Filter"))
            find(text("Search"))
            find(text("Settings"))
            ScreenshotCapture.capture("05-update-overflow.png")
        } catch (failure: Throwable) {
            failures += failure
            runCatching { ScreenshotCapture.capture("failure.png") }
                .onFailure(failure::addSuppressed)
        } finally {
            for (cleanup in
                listOf<() -> Unit>(
                    { updateGate.complete(Unit) },
                    { scenario?.close() },
                    { runBlocking { withTimeout(10_000) { chatJob?.join() } } },
                    { fixture.close() },
                    { cache.restore() },
                    { app.restoreApiPreferences(preferences) },
                    { app.chatService = oldService },
                    { updateOwner.close() },
                    { app.updateOwner = previousUpdate },
                    {
                        val operation =
                            if (oldAnimatorScale == null) "delete global animator_duration_scale"
                            else "put global animator_duration_scale $oldAnimatorScale"
                        device.executeShellCommand("settings $operation")
                    },
                    { device.executeShellCommand("wm size ${oldSize ?: "reset"}") },
                    { device.executeShellCommand("wm density ${oldDensity ?: "reset"}") },
                )) runCatching(cleanup).onFailure(failures::add)
        }
        MultipleFailureException.assertEmpty(failures)
    }

    private fun screenshotUpdateOwner(visible: CompletableDeferred<Unit>): AppUpdates {
        val checksum = "a".repeat(64)
        val release =
            AndroidUpdatesRelease(
                "99.0.0",
                24,
                1234,
                checksum,
                "https://static.okou.io/android-updates/releases/99.0.0/$checksum.apk",
                "A native update",
            )
        return AppUpdates(
            object : UpdateService {
                override suspend fun initialize() = Unit

                override suspend fun check(): AndroidUpdates {
                    visible.await()
                    return AndroidUpdates(null, release)
                }

                override suspend fun recover(release: AndroidUpdatesRelease): File? = null

                override suspend fun download(
                    release: AndroidUpdatesRelease,
                    progress: (Long) -> Unit,
                ): File = error("No download requested")

                override fun close() = Unit
            },
            object : UpdateStore {
                override suspend fun load(): UpdateRecord? = null

                override suspend fun save(record: UpdateRecord) = Unit
            },
            BuildConfig.VERSION_NAME,
            35,
        )
    }
}
