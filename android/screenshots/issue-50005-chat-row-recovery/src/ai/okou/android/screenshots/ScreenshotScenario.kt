package ai.okou.android.screenshots

import ai.okou.android.BuildConfig
import ai.okou.android.CHAT_DATE
import ai.okou.android.CHAT_PERSONAL
import ai.okou.android.CHAT_PROJECT
import ai.okou.android.ChatCacheSnapshot
import ai.okou.android.ChatListApiFixture
import ai.okou.android.MainActivity
import ai.okou.android.R
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.api.ApiFailure
import ai.okou.android.api.generated.ChatArchive
import ai.okou.android.api.generated.ChatEvents
import ai.okou.android.auth.SessionModel
import ai.okou.android.auth.WorkspaceSession
import ai.okou.android.auth.scopeHash
import ai.okou.android.awaitChatList
import ai.okou.android.chat.ChatCheckpoint
import ai.okou.android.chat.ChatCursor
import ai.okou.android.chat.ChatListModel
import ai.okou.android.chat.ChatListReadFailure
import ai.okou.android.chat.ChatReadPhase
import ai.okou.android.chat.ChatRowAction
import ai.okou.android.chat.ProjectDeleteStatus
import ai.okou.android.chat.cursor
import ai.okou.android.chat.isUnread
import ai.okou.android.chatEventWire
import ai.okou.android.chatListRegion
import ai.okou.android.jsonResponse
import ai.okou.android.rowEventTail
import ai.okou.android.testAuthenticationState
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.takeScreenshot as takeInstrumentationScreenshot
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
import androidx.test.uiautomator.Condition
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import java.io.IOException
import java.net.ConnectException
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Job
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.mockwebserver.MockResponse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.model.MultipleFailureException

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    @Test
    fun capturesFilteredReorderingAndRecovery() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val app = instrumentation.targetContext.applicationContext as TestOkouApplication
        val device = UiDevice.getInstance(instrumentation)
        val animatorScale =
            device.executeShellCommand("settings get global animator_duration_scale").trim()
        val auth = app.authentication as TestAuthentication
        val savedAuth = auth.state.value
        val savedService = app.chatService
        val savedOnline = app.connectivity.value
        val savedPreferences = app.snapshotApiPreferences()
        val savedCache = ChatCacheSnapshot(app.noBackupFilesDir.resolve("chat-list"), app.chatCache)
        val fixture = ChatListApiFixture()
        val middle = "22222222-2222-4222-8222-222222222222"
        val last = "33333333-3333-4333-8333-333333333333"
        val firstTitle = "Client onboarding"
        val middleTitle = "Release notes"
        val lastTitle = "Roadmap review"

        fun eventId(seq: Long) = "00000000-0000-4000-8000-${seq.toString().padStart(12, '0')}"
        fun seed(seq: Long, thread: String, title: String, rank: String) =
            listOf(
                chatEventWire(eventId(seq), seq, thread, title = title),
                chatEventWire(
                    eventId(seq + 1),
                    seq + 1,
                    thread,
                    "pinned",
                    ",\"pinOrder\":\"$rank\"",
                ),
            )
        val initial =
            seed(17, CHAT_PERSONAL, firstTitle, "a0") +
                seed(19, middle, middleTitle, "a1") +
                seed(21, last, lastTitle, "a2")
        fixture.events = {
            jsonResponse("""{"events":[${initial.joinToString(",")}],"hasMore":false}""")
        }
        fixture.indicators = {
            jsonResponse(
                """{"threads":{"$CHAT_PERSONAL":"unread","$last":"unread"},"unreadAt":{"$CHAT_PERSONAL":"$CHAT_DATE","$last":"$CHAT_DATE"}}""",
            )
        }
        fixture.historyMarkRead = { MockResponse().setResponseCode(503) }
        val readbacks = AtomicInteger()
        val events = fixture.rowEventTail { readbacks.incrementAndGet() }
        val staleRead = CountDownLatch(1)
        val freshRead = CountDownLatch(1)
        val retryRecoveryRead = CountDownLatch(1)
        val heldRead = AtomicReference<CountDownLatch?>(staleRead)
        val simulatingListFailure = AtomicBoolean(false)
        val retryAttempts = AtomicInteger()
        val eventsResponse = fixture.events
        fixture.events = { request ->
            heldRead.getAndSet(null)?.await()
            if (simulatingListFailure.get() && retryAttempts.incrementAndGet() <= 3) {
                MockResponse().setResponseCode(503)
            } else {
                if (simulatingListFailure.getAndSet(false)) retryRecoveryRead.await()
                eventsResponse(request)
            }
        }
        val pinTargets = CopyOnWriteArrayList<String>()
        val projectDeletes = AtomicInteger()
        val releaseProjectDelete = CountDownLatch(1)
        fixture.commandResponse = { request ->
            val path = request.requestUrl?.pathSegments.orEmpty()
            if (request.method == "POST" && path.lastOrNull() == "pin-order") {
                val thread = path[2]
                pinTargets += thread
                val command = Json.parseToJsonElement(request.body.clone().readUtf8()).jsonObject
                events +=
                    23L to
                        chatEventWire(
                            command.getValue("eventId").jsonPrimitive.content,
                            23,
                            thread,
                            "sort_touched",
                            ",\"pinOrder\":${command.getValue("pinOrder")}",
                        )
                MockResponse().setResponseCode(204)
            } else if (
                request.method == "POST" &&
                    path == listOf("api", "chat-threads", CHAT_PERSONAL, "mark-unread")
            ) {
                jsonResponse("""{"lastReadAt":null}""")
            } else if (
                request.method == "DELETE" && path == listOf("api", "projects", CHAT_PROJECT)
            ) {
                if (projectDeletes.incrementAndGet() == 2) releaseProjectDelete.await()
                MockResponse().setResponseCode(409)
            } else null
        }
        val retryIds = CopyOnWriteArrayList<String>()
        val unknownIds = CopyOnWriteArrayList<String>()
        val releaseRetry = CompletableDeferred<Unit>()
        val confirmUnarchive = AtomicBoolean(false)
        app.chatService =
            object : WorkspaceSession by fixture.service {
                override suspend fun setArchived(
                    threadId: String,
                    archived: Boolean,
                    eventId: String,
                ) {
                    if (threadId == last) {
                        retryIds += eventId
                        if (retryIds.size == 2) releaseRetry.await()
                        throw ApiFailure.Network(ConnectException("Fixture connection failed"))
                    }
                    assertEquals(CHAT_PERSONAL, threadId)
                    if (!archived && confirmUnarchive.get()) {
                        events += 25L to chatEventWire(eventId, 25, threadId, "unarchived")
                        return
                    }
                    unknownIds += eventId
                    throw ApiFailure.Network(IOException("Fixture response lost"))
                }

                override fun close() = Unit
            }
        app.connectivity.value = true
        val user = "row-recovery-${UUID.randomUUID()}"
        auth.state.value = testAuthenticationState(user = user)
        val failures = mutableListOf<Throwable>()
        var scenario: ActivityScenario<MainActivity>? = null
        var chatJob: Job? = null
        lateinit var chats: ChatListModel
        fun selector(value: String) = By.pkg(app.packageName).text(value)
        fun element(target: BySelector) =
            checkNotNull(device.wait(Until.findObject(target), 10_000)) { "Missing $target" }
        fun text(value: String) = element(selector(value))
        fun text(id: Int) = text(app.getString(id))
        fun awaitState(message: String, ready: () -> Boolean) = device.awaitState(message, ready)
        fun above(first: String, second: String) =
            text(first).visibleBounds.top < text(second).visibleBounds.top
        val filter = By.pkg(app.packageName).desc(app.getString(R.string.chat_filter))
        val sync = By.pkg(app.packageName).desc(app.getString(R.string.chat_syncing))
        fun restoreAnimatorScale() = device.restoreAnimatorScale(animatorScale)

        try {
            val cacheIdentity =
                fixture.identity.copy(
                    apiOrigin = BuildConfig.API_ORIGIN,
                    userId = user,
                    authorizationScope = scopeHash(listOf("org:member")),
                )
            val cachedEvents =
                Json.decodeFromString<ChatEvents>(
                        """{"events":[${initial.joinToString(",")}],"hasMore":false}""",
                    )
                    .events
            val checkpoint =
                ChatCheckpoint(
                    ChatArchive(emptyList()),
                    ChatCursor(),
                    cachedEvents,
                    cachedEvents.last().cursor(),
                )
            runBlocking {
                app.chatCache
                    .open(cacheIdentity) { true }
                    .use {
                        assertTrue(
                            it.save(checkpoint, System.currentTimeMillis() - 11 * 60 * 1_000L),
                        )
                    }
            }
            device.executeShellCommand("settings put global animator_duration_scale 1")
            val activityScenario = ActivityScenario.launch(MainActivity::class.java)
            scenario = activityScenario
            device.awaitChatList(app)
            activityScenario.onActivity { activity ->
                val ready =
                    checkNotNull(
                        ViewModelProvider(activity)[SessionModel::class.java].uiState.value.ready,
                    )
                chats = ready.chats
                chatJob = chats.viewModelScope.coroutineContext[Job]
            }
            awaitState("Expected the stale list to remain visible during the held read") {
                heldRead.get() == null && chats.uiState.value.projectsPhase == ChatReadPhase.Ready
            }
            val progressBounds = element(sync).visibleBounds
            assertTrue(progressBounds.top < text(firstTitle).visibleBounds.top)
            val rowTop = text(firstTitle).visibleBounds.top
            device.awaitProgressFrame(sync, app.getColor(R.color.okou_primary))
            ScreenshotCapture.capture("stale-chat-list-sync.png")
            restoreAnimatorScale()
            staleRead.countDown()
            awaitState("Expected the unchanged list to be confirmed") {
                chats.uiState.value.listPhase == ChatReadPhase.Ready
            }
            assertTrue(device.wait(Until.gone(sync), 10_000))
            assertEquals(rowTop, text(firstTitle).visibleBounds.top)

            heldRead.set(freshRead)
            activityScenario.onActivity { chats.refreshList() }
            awaitState("Expected the fresh list to refresh in the background") {
                heldRead.get() == null && chats.uiState.value.listPhase == ChatReadPhase.Loading
            }
            assertFalse(device.hasObject(sync))
            assertEquals(rowTop, text(firstTitle).visibleBounds.top)
            ScreenshotCapture.capture("fresh-chat-list-sync.png")
            freshRead.countDown()
            awaitState("Expected the second refresh to complete") {
                chats.uiState.value.listPhase == ChatReadPhase.Ready
            }

            device.executeShellCommand("settings put global animator_duration_scale 1")
            simulatingListFailure.set(true)
            activityScenario.onActivity { chats.refreshList() }
            awaitState("Expected the second read to fail while the fresh list remains visible") {
                retryAttempts.get() == 2 && chats.uiState.value.listPhase == ChatReadPhase.Failed
            }
            assertFalse(device.hasObject(sync))
            assertEquals(rowTop, text(firstTitle).visibleBounds.top)
            awaitState("Expected progress immediately after the third failed read") {
                retryAttempts.get() == 3 && chats.uiState.value.listRetryProgressVisible
            }
            assertEquals(progressBounds, element(sync).visibleBounds)
            assertEquals(rowTop, text(firstTitle).visibleBounds.top)
            device.awaitProgressFrame(sync, app.getColor(R.color.okou_primary))
            assertEquals(ChatReadPhase.Failed, chats.uiState.value.listPhase)
            ScreenshotCapture.capture("fresh-chat-list-retry.png")
            retryRecoveryRead.countDown()
            awaitState("Expected the retry to restore the fresh list") {
                retryAttempts.get() == 4 && chats.uiState.value.listPhase == ChatReadPhase.Ready
            }
            assertTrue(device.wait(Until.gone(sync), 10_000))
            assertEquals(rowTop, text(firstTitle).visibleBounds.top)
            ScreenshotCapture.capture("chat-list-recovered.png")
            restoreAnimatorScale()

            text(firstTitle)
            text(middleTitle)
            text(lastTitle)
            element(filter).click()
            text(R.string.chat_unread).click()
            text(firstTitle)
            text(lastTitle)
            assertFalse(device.hasObject(selector(middleTitle)))
            assertTrue(above(firstTitle, lastTitle))
            text(lastTitle).longClick()
            val up = text(R.string.chat_move_pin_up)
            ScreenshotCapture.capture("filtered-pin-menu.png")
            up.click()
            awaitState("Expected the visible pin order to change") { above(lastTitle, firstTitle) }
            assertFalse(device.hasObject(selector(middleTitle)))
            ScreenshotCapture.capture("filtered-pin-reordered.png")
            element(filter).click()
            text(R.string.chat_inbox).click()
            text(middleTitle)
            assertTrue(above(lastTitle, firstTitle))
            assertTrue(above(firstTitle, middleTitle))
            assertEquals(listOf(last), pinTargets)

            text(lastTitle).longClick()
            text(R.string.chat_archive).click()
            awaitState("Expected one retry while the optimistic archive is visible") {
                retryIds.size == 2
            }
            assertFalse(device.hasObject(selector(lastTitle)))
            assertFalse(device.hasObject(selector(app.getString(R.string.chat_undo))))
            ScreenshotCapture.capture("archive-retry-pending.png")
            releaseRetry.complete(Unit)
            val connectionFailure =
                app.getString(
                    R.string.chat_row_action_offline_named,
                    app.getString(R.string.chat_archive),
                )
            text(connectionFailure)
            assertTrue(above(lastTitle, firstTitle))
            assertEquals(3, retryIds.size)
            assertEquals(1, retryIds.distinct().size)
            ScreenshotCapture.capture("archive-rollback.png")
            assertTrue(device.wait(Until.gone(selector(connectionFailure)), 10_000))

            text(firstTitle).longClick()
            text(R.string.chat_archive).click()
            text(R.string.chat_row_action_failed)
            assertFalse(device.hasObject(selector(firstTitle)))
            ScreenshotCapture.capture("archive-awaiting-confirmation.png")

            val readsBeforeRefresh = readbacks.get()
            text(R.string.chat_refresh).click()
            awaitState("Expected the inconclusive refresh to complete") {
                val state = chats.uiState.value
                readbacks.get() > readsBeforeRefresh &&
                    state.listPhase == ChatReadPhase.Ready &&
                    state.failedRowAction?.action == ChatRowAction.Archive
            }
            text(R.string.chat_row_action_failed)
            assertTrue(text(R.string.chat_refresh).isEnabled)
            assertEquals(1, unknownIds.size)
            ScreenshotCapture.capture("archive-after-inconclusive-refresh.png")

            events += 24L to chatEventWire(eventId(24), 24, CHAT_PERSONAL, "archived")
            text(R.string.chat_refresh).click()
            awaitState("Expected the external archive to reach the confirmed list") {
                chats.uiState.value.confirmedThreads.any { it.id == CHAT_PERSONAL && it.archived }
            }
            assertTrue(
                device.wait(
                    Until.gone(selector(app.getString(R.string.chat_row_action_failed))),
                    10_000,
                ),
            )
            element(filter).click()
            text(R.string.chat_archived).click()
            text(firstTitle)
            assertEquals(1, unknownIds.size)
            assertFalse(device.hasObject(selector(app.getString(R.string.chat_undo))))
            ScreenshotCapture.capture("archive-confirmed-on-another-device.png")

            text(firstTitle).longClick()
            text(R.string.chat_mark_read).click()
            text(R.string.chat_row_action_failed)
            assertEquals(ChatRowAction.MarkRead, chats.uiState.value.failedRowAction?.action)
            assertFalse(chats.uiState.value.isUnread(CHAT_PERSONAL))
            ScreenshotCapture.capture("read-awaiting-confirmation.png")

            text(firstTitle).longClick()
            text(R.string.chat_mark_unread).click()
            awaitState("Expected the confirmed unread state to replace the earlier read") {
                val state = chats.uiState.value
                state.isUnread(CHAT_PERSONAL) &&
                    state.readIntents.isEmpty() &&
                    state.failedRowAction == null
            }
            assertTrue(
                device.wait(
                    Until.gone(selector(app.getString(R.string.chat_row_action_failed))),
                    10_000,
                ),
            )
            ScreenshotCapture.capture("unread-after-confirmation.png")

            val displaySize = device.executeShellCommand("wm size")
            val displayDensity = device.executeShellCommand("wm density")
            check(
                displaySize.contains("Physical size:") &&
                    displayDensity.contains("Physical density:"),
            )
            val originalSize =
                Regex("Override size: (\\d+x\\d+)").find(displaySize)?.groupValues?.get(1)
            val originalDensity =
                Regex("Override density: (\\d+)").find(displayDensity)?.groupValues?.get(1)
            try {
                device.executeShellCommand("wm size 1000x1000")
                device.executeShellCommand("wm density 160")
                awaitState("Expected the expanded display configuration") {
                    app.resources.configuration.screenWidthDp >= 840 &&
                        app.resources.configuration.densityDpi == 160
                }
                val listBounds = device.awaitChatList(app).visibleBounds
                fixture.historyMarkRead = { jsonResponse("""{"lastReadAt":"$CHAT_DATE"}""") }
                element(selector(firstTitle).hasAncestor(chatListRegion(app))).click()
                confirmUnarchive.set(true)
                element(By.pkg(app.packageName).desc(app.getString(R.string.chat_actions))).click()
                text(R.string.chat_unarchive).click()
                text(R.string.chat_undo_unarchived)
                assertTrue(text(R.string.chat_undo).visibleBounds.left >= listBounds.right)
                ScreenshotCapture.capture("conversation-undo-split.png")
            } finally {
                device.executeShellCommand("wm size ${originalSize ?: "reset"}")
                device.executeShellCommand("wm density ${originalDensity ?: "reset"}")
            }
            assertTrue(device.wait(Until.gone(chatListRegion(app)), 10_000))
            val back = By.pkg(app.packageName).desc(app.getString(R.string.back))
            element(back)
            text(R.string.chat_undo_unarchived)
            assertTrue(text(R.string.chat_undo).isEnabled)
            ScreenshotCapture.capture("conversation-undo-compact.png")

            element(back).click()
            device.awaitChatList(app)
            text(R.string.chat_back_to_inbox).click()
            fun deleteProject() {
                text("Research").longClick()
                text(R.string.chat_project_delete).click()
                text(R.string.chat_project_delete_title)
                text(R.string.chat_project_delete).click()
            }
            deleteProject()
            text(R.string.chat_project_delete_rejected)
            assertTrue(text(R.string.chat_project_delete).isEnabled)
            ScreenshotCapture.capture("project-delete-rejection-dialog.png")
            text(R.string.settings_cancel).click()

            deleteProject()
            awaitState("Expected the second Project deletion to be held") {
                projectDeletes.get() == 2
            }
            text(R.string.settings_cancel).click()
            text(firstTitle).click()
            assertTrue(device.wait(Until.gone(chatListRegion(app)), 10_000))
            releaseProjectDelete.countDown()
            awaitState("Expected the project deletion to be rejected") {
                chats.uiState.value.projectDeleteFeedback?.status == ProjectDeleteStatus.Rejected
            }
            assertFalse(
                device.hasObject(selector(app.getString(R.string.chat_project_delete_rejected))),
            )
            element(back).click()
            device.awaitChatList(app)
            text(R.string.chat_project_delete_rejected)
            text("Research")
            ScreenshotCapture.capture("project-delete-rejection-list.png")
        } catch (error: Throwable) {
            failures += error
            try {
                ScreenshotCapture.capture("failure.png")
            } catch (diagnostic: Throwable) {
                error.addSuppressed(diagnostic)
            }
        } finally {
            staleRead.countDown()
            freshRead.countDown()
            retryRecoveryRead.countDown()
            releaseProjectDelete.countDown()
            releaseRetry.complete(Unit)
            for (cleanup in
                listOf<() -> Unit>(
                    { scenario?.close() },
                    { runBlocking { withTimeout(10_000) { chatJob?.join() } } },
                    { fixture.close() },
                    { savedCache.restore() },
                    ::restoreAnimatorScale,
                    { app.restoreApiPreferences(savedPreferences) },
                    { app.chatService = savedService },
                    { app.connectivity.value = savedOnline },
                    { auth.state.value = savedAuth },
                )) {
                try {
                    cleanup()
                } catch (error: Throwable) {
                    failures += error
                }
            }
        }
        MultipleFailureException.assertEmpty(failures)
    }

    @Test
    fun capturesTheSkeletonDuringTheFirstReadRetry() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val app = instrumentation.targetContext.applicationContext as TestOkouApplication
        val device = UiDevice.getInstance(instrumentation)
        val animatorScale =
            device.executeShellCommand("settings get global animator_duration_scale").trim()
        val auth = app.authentication as TestAuthentication
        val savedAuth = auth.state.value
        val savedService = app.chatService
        val savedOnline = app.connectivity.value
        val savedPreferences = app.snapshotApiPreferences()
        val savedCache = ChatCacheSnapshot(app.noBackupFilesDir.resolve("chat-list"), app.chatCache)
        val fixture = ChatListApiFixture()
        val attempts = AtomicInteger()
        val firstRead = CountDownLatch(1)
        val recovery = CountDownLatch(1)
        val title = "First synced chat"
        fixture.events = { request ->
            val attempt = attempts.incrementAndGet()
            if (attempt == 1) firstRead.await()
            if (attempt <= 3) MockResponse().setResponseCode(503)
            else {
                recovery.await()
                val events =
                    if (request.requestUrl?.queryParameter("sinceSeqId") == null)
                        chatEventWire(title = title)
                    else ""
                jsonResponse("""{"events":[$events],"hasMore":false}""")
            }
        }
        app.chatService = fixture.service
        app.connectivity.value = true
        auth.state.value = testAuthenticationState(user = "first-list-${UUID.randomUUID()}")
        val failures = mutableListOf<Throwable>()
        var scenario: ActivityScenario<MainActivity>? = null
        var chatJob: Job? = null
        try {
            device.executeShellCommand("settings put global animator_duration_scale 1")
            val activityScenario = ActivityScenario.launch(MainActivity::class.java)
            scenario = activityScenario
            device.awaitChatList(app)
            lateinit var chats: ChatListModel
            activityScenario.onActivity { activity ->
                chats =
                    checkNotNull(
                            ViewModelProvider(activity)[SessionModel::class.java]
                                .uiState
                                .value
                                .ready,
                        )
                        .chats
                chatJob = chats.viewModelScope.coroutineContext[Job]
            }
            val skeleton = By.pkg(app.packageName).desc(app.getString(R.string.chat_loading))
            val sync = By.pkg(app.packageName).desc(app.getString(R.string.chat_syncing))
            assertTrue(device.wait(Until.hasObject(skeleton), 10_000))
            firstRead.countDown()
            device.awaitState("Expected the first failed read to start retrying") {
                attempts.get() == 1 &&
                    chats.uiState.value.listReadFailure == ChatListReadFailure.Retrying
            }
            assertTrue(device.hasObject(skeleton))
            assertFalse(device.hasObject(sync))
            device.awaitState("Expected the third read failure without available rows") {
                attempts.get() == 3 && chats.uiState.value.listRetryProgressVisible
            }
            assertTrue(device.hasObject(skeleton))
            device.awaitProgressFrame(sync, app.getColor(R.color.okou_primary))
            assertEquals(ChatReadPhase.Failed, chats.uiState.value.listPhase)
            ScreenshotCapture.capture("first-chat-list-retry.png")
            recovery.countDown()
            assertTrue(device.wait(Until.hasObject(By.pkg(app.packageName).text(title)), 10_000))
            assertTrue(device.wait(Until.gone(sync), 10_000))
            assertFalse(device.hasObject(skeleton))
        } catch (error: Throwable) {
            failures += error
            try {
                ScreenshotCapture.capture("first-chat-list-failure.png")
            } catch (diagnostic: Throwable) {
                error.addSuppressed(diagnostic)
            }
        } finally {
            firstRead.countDown()
            recovery.countDown()
            for (cleanup in
                listOf<() -> Unit>(
                    { scenario?.close() },
                    { runBlocking { withTimeout(10_000) { chatJob?.join() } } },
                    { fixture.close() },
                    { savedCache.restore() },
                    { device.restoreAnimatorScale(animatorScale) },
                    { app.restoreApiPreferences(savedPreferences) },
                    { app.chatService = savedService },
                    { app.connectivity.value = savedOnline },
                    { auth.state.value = savedAuth },
                )) {
                try {
                    cleanup()
                } catch (error: Throwable) {
                    failures += error
                }
            }
        }
        MultipleFailureException.assertEmpty(failures)
    }
}

private fun UiDevice.awaitState(message: String, ready: () -> Boolean) {
    assertTrue(
        message,
        wait(
            object : Condition<UiDevice, Boolean> {
                override fun apply(device: UiDevice): Boolean = ready()
            },
            10_000,
        ),
    )
}

private fun UiDevice.restoreAnimatorScale(scale: String) {
    val command =
        if (scale == "null") "settings delete global animator_duration_scale"
        else "settings put global animator_duration_scale ${checkNotNull(scale.toFloatOrNull())}"
    executeShellCommand(command)
}

private fun UiDevice.awaitProgressFrame(selector: BySelector, color: Int) {
    val bounds = checkNotNull(wait(Until.findObject(selector), 10_000)).visibleBounds
    awaitState("Expected the active sync segment to be visible") {
        val frame = takeInstrumentationScreenshot()
        try {
            val y = bounds.centerY()
            val activePixels =
                (bounds.left until bounds.right).count { frame.getPixel(it, y) == color }
            activePixels >= bounds.width() / 10
        } finally {
            frame.recycle()
        }
    }
}
