package ai.okou.android

import ai.okou.android.auth.OpeningWorkspace
import ai.okou.android.auth.SessionModel
import android.graphics.Point
import android.os.SystemClock
import android.util.Log
import android.view.InputDevice
import android.view.KeyEvent
import android.view.MotionEvent
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.takeScreenshot
import androidx.test.core.graphics.writeToTestStorage
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
import androidx.test.uiautomator.Condition
import androidx.test.uiautomator.Direction
import androidx.test.uiautomator.StaleObjectException
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiSelector
import androidx.test.uiautomator.Until
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.abs
import kotlinx.coroutines.Job
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.mockwebserver.MockResponse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.model.MultipleFailureException

@RunWith(AndroidJUnit4::class)
class NativeChatListTest {
    @Test
    fun emptyProjectKeepsItsOwnActionAndFilteredEmptyReturnsToInbox() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val app = instrumentation.targetContext.applicationContext as TestOkouApplication
        val device = UiDevice.getInstance(instrumentation)
        val auth = app.authentication as TestAuthentication
        val previousAuth = auth.state.value
        val previousService = app.chatService
        val savedPreferences = app.snapshotApiPreferences()
        val savedCache = ChatCacheSnapshot(app.noBackupFilesDir.resolve("chat-list"), app.chatCache)
        val fixture = ChatListApiFixture()
        fixture.events = { jsonResponse("""{"events":[],"hasMore":false}""") }
        fixture.indicators = { jsonResponse("""{"threads":{},"unreadAt":{}}""") }
        app.chatService = fixture.service
        auth.state.value = testAuthenticationState(user = "empty-list-${UUID.randomUUID()}")
        val failures = mutableListOf<Throwable>()
        var scenario: ActivityScenario<MainActivity>? = null
        var chatJob: Job? = null
        fun await(selector: BySelector) =
            checkNotNull(device.wait(Until.findObject(selector), 10_000)) { "Missing $selector" }
        fun text(value: String) = await(By.pkg(app.packageName).text(value))

        try {
            scenario = ActivityScenario.launch(MainActivity::class.java)
            device.awaitChatList(app)
            val projectName = "Research"
            val projectAction = app.getString(R.string.composer_new_project)
            val projectUnavailable =
                By.pkg(app.packageName).text(app.getString(R.string.chat_project_empty))
            val filterMenu = By.pkg(app.packageName).desc(app.getString(R.string.chat_filter))
            text(projectName).click()
            text(projectAction)
            assertTrue(device.wait(Until.gone(projectUnavailable), 10_000))
            assertFalse(
                device.hasObject(By.pkg(app.packageName).text(app.getString(R.string.chat_empty)))
            )
            takeScreenshot().writeToTestStorage("android-list-empty-project")
            text(projectAction).click()
            assertTrue(device.wait(Until.gone(chatListRegion(app)), 10_000))
            text(projectName)
            await(By.pkg(app.packageName).desc(app.getString(R.string.back))).click()
            device.awaitChatList(app)

            for ((filter, title) in
                listOf(
                    R.string.chat_unread to R.string.chat_empty_unread,
                    R.string.chat_archived to R.string.chat_empty_archived,
                    R.string.chat_muted to R.string.chat_empty_muted,
                )) {
                await(filterMenu).click()
                text(app.getString(filter)).click()
                text(app.getString(title))
                assertFalse(device.hasObject(By.pkg(app.packageName).text(projectName)))
                if (filter == R.string.chat_archived) {
                    takeScreenshot().writeToTestStorage("android-list-empty-archived")
                }
                text(app.getString(R.string.chat_back_to_inbox)).click()
                text(projectAction)
            }
        } catch (error: Throwable) {
            failures.add(error)
            try {
                takeScreenshot().writeToTestStorage("android-list-empty-failure")
            } catch (diagnostic: Throwable) {
                error.addSuppressed(diagnostic)
            }
        } finally {
            for (cleanup in
                listOf<() -> Unit>(
                    {
                        scenario?.onActivity { activity ->
                            val state =
                                ViewModelProvider(activity)[SessionModel::class.java].uiState.value
                            val chats =
                                state.ready?.chats
                                    ?: (state.opening as? OpeningWorkspace.Authorized)?.chats
                            chatJob = chats?.viewModelScope?.coroutineContext?.get(Job)
                        }
                    },
                    { scenario?.close() },
                    { runBlocking { withTimeout(10_000) { chatJob?.join() } } },
                    { fixture.close() },
                    { savedCache.restore() },
                    { app.restoreApiPreferences(savedPreferences) },
                    { app.chatService = previousService },
                    { auth.state.value = previousAuth },
                )) {
                try {
                    cleanup()
                } catch (error: Throwable) {
                    failures.add(error)
                }
            }
        }
        MultipleFailureException.assertEmpty(failures)
    }

    @Test
    fun cachedUnreadFilterOpensBeforeIndicatorsAndRemainsUsableAfterFailure() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val app = instrumentation.targetContext.applicationContext as TestOkouApplication
        val device = UiDevice.getInstance(instrumentation)
        val previous = app.chatService
        val savedPreferences = app.snapshotApiPreferences()
        val directory = app.noBackupFilesDir.resolve("chat-list")
        val savedCache = ChatCacheSnapshot(directory, app.chatCache)
        fun unreadFiles() =
            directory
                .listFiles { file -> file.name.endsWith("-unread.json") }
                .orEmpty()
                .associate { it.name to it.readText() }
        val originalUnread = unreadFiles()
        val fixture = ChatListApiFixture()
        val requested = CountDownLatch(1)
        val release = CountDownLatch(1)
        val fail = AtomicBoolean(true)
        val jobs = mutableListOf<Job>()
        val failures = mutableListOf<Throwable>()
        var scenario: ActivityScenario<MainActivity>? = null
        app.chatService = fixture.service
        fun text(value: String) =
            checkNotNull(
                device.wait(Until.findObject(By.pkg(app.packageName).text(value)), 10_000)
            ) {
                "Missing $value"
            }
        fun launch() {
            scenario = ActivityScenario.launch(MainActivity::class.java)
            device.awaitChatList(app)
            checkNotNull(scenario).onActivity { activity ->
                val chats =
                    checkNotNull(
                            ViewModelProvider(activity)[SessionModel::class.java]
                                .uiState
                                .value
                                .ready
                        )
                        .chats
                jobs += checkNotNull(chats.viewModelScope.coroutineContext[Job])
            }
        }
        try {
            launch()
            text("Research")
            assertTrue(
                device.wait(
                    object : Condition<UiDevice, Boolean> {
                        override fun apply(device: UiDevice) = unreadFiles() != originalUnread
                    },
                    10_000,
                )
            )
            checkNotNull(scenario).close()
            runBlocking { withTimeout(10_000) { jobs.last().join() } }

            fixture.indicators = {
                requested.countDown()
                release.await()
                if (fail.get()) MockResponse().setResponseCode(503)
                else jsonResponse("""{"threads":{},"unreadAt":{}}""")
            }
            val launchedAt = SystemClock.elapsedRealtime()
            launch()
            checkNotNull(
                    device.wait(
                        Until.findObject(
                            By.pkg(app.packageName).desc(app.getString(R.string.chat_filter))
                        ),
                        10_000,
                    )
                )
                .click()
            val unread = app.getString(R.string.chat_unread)
            text(unread).click()
            assertTrue(
                device.wait(
                    Until.hasObject(
                        By.pkg(app.packageName).text(unread).hasAncestor(chatListRegion(app))
                    ),
                    10_000,
                )
            )
            // An unread Project remains visible with its chat rows folded.
            text("Research")
            Log.i(
                "OkouNativeUnread",
                "launch-to-usable-unread=${SystemClock.elapsedRealtime() - launchedAt}ms chats=2 projects=1",
            )
            assertTrue(requested.await(10, TimeUnit.SECONDS))
            assertTrue(!device.hasObject(By.pkg(app.packageName).text("Personal chat")))

            release.countDown()
            text(app.getString(R.string.chat_refresh_failed))
            text("Research")
            fail.set(false)
            text(app.getString(R.string.retry)).click()
            text(app.getString(R.string.chat_empty_unread))
        } catch (error: Throwable) {
            failures.add(error)
            try {
                takeScreenshot().writeToTestStorage("native-cached-unread-failure.png")
            } catch (diagnostic: Throwable) {
                error.addSuppressed(diagnostic)
            }
        } finally {
            release.countDown()
            for (cleanup in
                listOf<() -> Unit>(
                    { scenario?.close() },
                    { runBlocking { withTimeout(10_000) { jobs.forEach { it.join() } } } },
                    { fixture.close() },
                    { savedCache.restore() },
                    { app.restoreApiPreferences(savedPreferences) },
                    { app.chatService = previous },
                )) {
                try {
                    cleanup()
                } catch (error: Throwable) {
                    failures.add(error)
                }
            }
        }
        MultipleFailureException.assertEmpty(failures)
    }

    @Test
    fun pendingTransportAllowsSettingsAndLoadedProjectsSurviveActivityRecreation() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val app = instrumentation.targetContext.applicationContext as TestOkouApplication
        val device = UiDevice.getInstance(instrumentation)
        val auth = app.authentication as TestAuthentication
        val previousAuth = auth.state.value
        val previous = app.chatService
        val savedPreferences = app.snapshotApiPreferences()
        val savedCache = ChatCacheSnapshot(app.noBackupFilesDir.resolve("chat-list"), app.chatCache)
        val fixture = ChatListApiFixture()
        val rowEvents = fixture.rowEventTail()
        fixture.commandResponse = { request ->
            when (request.requestUrl?.encodedPath) {
                "/api/chat-threads/$CHAT_PERSONAL/archive" -> {
                    rowEvents.add(24L to request.rowEvent(24, CHAT_PERSONAL, "archived"))
                    MockResponse().setResponseCode(204)
                }
                "/api/chat-threads/$CHAT_PERSONAL/unarchive" -> {
                    rowEvents.add(25L to request.rowEvent(25, CHAT_PERSONAL, "unarchived"))
                    MockResponse().setResponseCode(204)
                }
                else -> null
            }
        }
        val gate = CountDownLatch(1)
        fixture.beforeResponse = { gate.await() }
        app.chatService = fixture.service
        auth.state.value = testAuthenticationState(user = "project-list-${UUID.randomUUID()}")
        val firstHistory = CountDownLatch(1)
        val firstSnapshotResponse = fixture.historySnapshot
        val firstRowsResponse = fixture.historyRows
        val firstCatchUpResponse = fixture.historyCatchUp
        fixture.historySnapshot = {
            firstHistory.await()
            firstSnapshotResponse()
        }
        fixture.historyRows = { request ->
            firstHistory.await()
            firstRowsResponse(request)
        }
        fixture.historyCatchUp = { request ->
            firstHistory.await()
            firstCatchUpResponse(request)
        }
        var scenario: ActivityScenario<MainActivity>? = null
        var chatJob: Job? = null
        val failures = mutableListOf<Throwable>()
        val toolLabels =
            listOf(
                    R.string.workspace_workflows,
                    R.string.workspace_connectors,
                    R.string.workspace_artifacts,
                )
                .map(app::getString)
        try {
            scenario = ActivityScenario.launch(MainActivity::class.java)
            fun text(value: String) =
                checkNotNull(
                    device.wait(Until.findObject(By.pkg(app.packageName).text(value)), 10_000)
                )
            fun tool(label: String) =
                checkNotNull(
                        device.wait(Until.findObject(By.pkg(app.packageName).desc(label)), 10_000)
                    ) {
                        "Missing workspace tool $label"
                    }
                    .also {
                        val enabled = label == app.getString(R.string.workspace_artifacts)
                        assertEquals("Workspace tool $label availability", enabled, it.isEnabled)
                        assertEquals("Workspace tool $label click action", enabled, it.isClickable)
                    }
            fun click(selector: UiSelector) {
                // Resolve at action time. The SDK return acknowledges accessibility events;
                // verify Compose's actual application outcomes below instead.
                device.findObject(selector.packageName(app.packageName)).click()
            }
            fun clickText(value: String) = click(UiSelector().text(value))
            fun revealText(value: String) {
                val target = By.pkg(app.packageName).text(value).hasAncestor(chatListRegion(app))
                val scrollable = chatListRegion(app).scrollable(true)
                var direction = Direction.UP
                var reachedEnd = false
                assertTrue(
                    "Missing $value",
                    device.wait(
                        object : Condition<UiDevice, Boolean> {
                            override fun apply(device: UiDevice): Boolean {
                                if (device.hasObject(target)) return true
                                if (reachedEnd) return false
                                val container = device.findObject(scrollable) ?: return false
                                try {
                                    // A gesture can replace the list's accessibility node.
                                    if (!container.scroll(direction, 0.8f)) {
                                        if (direction == Direction.UP) direction = Direction.DOWN
                                        else reachedEnd = true
                                    }
                                } catch (_: StaleObjectException) {
                                    // Observe the current window again within the same wait.
                                }
                                return device.hasObject(target)
                            }
                        },
                        10_000,
                    ),
                )
            }
            device.awaitChatList(app)
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
            assertNotNull(
                device.wait(Until.findObject(By.desc(app.getString(R.string.chat_loading))), 10_000)
            )
            takeScreenshot().writeToTestStorage("android-list-loading")
            click(UiSelector().description(app.getString(R.string.settings)))
            text(app.getString(R.string.appearance))
            gate.countDown()
            assertTrue(device.pressKeyCode(KeyEvent.KEYCODE_BACK))
            device.awaitChatList(app)
            revealText("Research")
            toolLabels.forEach { tool(it) }
            takeScreenshot().writeToTestStorage("android-list-home")
            click(UiSelector().description(app.getString(R.string.chat_search_workspace)))
            text(app.getString(R.string.chat_search_recent))
            takeScreenshot().writeToTestStorage("android-list-search")
            click(UiSelector().description(app.getString(R.string.back)))
            device.awaitChatList(app)
            revealText("Research")
            assertTrue(device.wait(Until.gone(By.text("Project chat")), 10_000))
            text("Research").longClick()
            val renameProject = app.getString(R.string.chat_rename_confirm)
            val renameAction = text(renameProject)
            takeScreenshot().writeToTestStorage("android-project-row-menu")
            renameAction.click()
            text(app.getString(R.string.chat_project_rename_save))
            takeScreenshot().writeToTestStorage("android-project-rename-dialog")
            clickText(app.getString(R.string.chat_rename_cancel))
            clickText("Research")
            revealText("Project chat")
            takeScreenshot().writeToTestStorage("android-project-expanded")
            scenario.recreate()
            revealText("Project chat")
            clickText("Project chat")
            assertNotNull(
                device.wait(
                    Until.findObject(By.desc(app.getString(R.string.history_loading))),
                    10_000,
                )
            )
            takeScreenshot().writeToTestStorage("android-conversation-loading")
            firstHistory.countDown()
            text("Native history reply")
            text("Research")
            click(UiSelector().description(app.getString(R.string.chat_actions)))
            clickText(app.getString(R.string.settings))
            text(app.getString(R.string.appearance))
            scenario.recreate()
            text(app.getString(R.string.appearance))
            assertTrue(device.pressKeyCode(KeyEvent.KEYCODE_BACK))
            assertNotNull(device.wait(Until.findObject(By.textContains("Native history")), 10_000))
            assertTrue(device.pressKeyCode(KeyEvent.KEYCODE_BACK))
            assertTrue(device.wait(Until.gone(By.textContains("Native history")), 10_000))
            revealText("Research")
            clickText("Research")
            assertTrue(device.wait(Until.gone(By.text("Project chat")), 10_000))
            clickText("Research")
            revealText("Project chat")
            clickText("Project chat")
            text("Native history reply")
            click(UiSelector().description(app.getString(R.string.back)))
            assertTrue(device.wait(Until.gone(By.textContains("Native history")), 10_000))
            text("Project chat")
            clickText("Project chat")
            text("Native history reply")

            assertTrue(device.pressKeyCode(KeyEvent.KEYCODE_BACK))
            revealText("Personal chat")
            clickText("Personal chat")
            text("Hello history")
            assertTrue(device.pressKeyCode(KeyEvent.KEYCODE_BACK))
            assertTrue(device.wait(Until.gone(By.text("Hello history")), 10_000))
            revealText("Personal chat")
            text("Personal chat").longClick()
            val renameChat = app.getString(R.string.chat_rename)
            text(renameChat)
            text(app.getString(R.string.chat_archive))
            takeScreenshot().writeToTestStorage("android-chat-row-menu")
            assertTrue(device.pressKeyCode(KeyEvent.KEYCODE_BACK))
            assertTrue(device.wait(Until.gone(By.text(renameChat)), 10_000))
            revealText("Project chat")
            val historyRows = fixture.historyRows
            val releaseHistory = CountDownLatch(1)
            fixture.historyRows = { request ->
                if (request.requestUrl?.pathSegments?.getOrNull(2) == CHAT_IN_PROJECT)
                    releaseHistory.await()
                historyRows(request)
            }
            try {
                val tappedAt = SystemClock.elapsedRealtime()
                clickText("Project chat")
                text("Hello history")
                Log.i(
                    "OkouNativeHistory",
                    "warm revisit tap-to-first-message=${SystemClock.elapsedRealtime() - tappedAt}ms",
                )
            } finally {
                releaseHistory.countDown()
                fixture.historyRows = historyRows
            }

            // Resize the actual emulator display around the open destination.
            val size = device.executeShellCommand("wm size")
            val density = device.executeShellCommand("wm density")
            check(size.contains("Physical size:") && density.contains("Physical density:"))
            val originalSize = Regex("Override size: (\\d+x\\d+)").find(size)?.groupValues?.get(1)
            val originalDensity =
                Regex("Override density: (\\d+)").find(density)?.groupValues?.get(1)
            try {
                device.executeShellCommand("wm size 1000x1000")
                device.executeShellCommand("wm density 160")
                val listTitle = device.awaitChatList(app)
                val conversation = text("Native history reply")
                assertTrue(listTitle.visibleBounds.right < conversation.visibleBounds.left)
                toolLabels.forEach { label ->
                    assertTrue(tool(label).visibleBounds.right < conversation.visibleBounds.left)
                }
                val toolbarBack = By.pkg(app.packageName).desc(app.getString(R.string.back))
                assertTrue(device.wait(Until.gone(toolbarBack), 10_000))
                takeScreenshot().writeToTestStorage("android-list-home-two-pane")
                val filter = app.getString(R.string.chat_filter)
                val archived = app.getString(R.string.chat_archived)
                val inbox = By.pkg(app.packageName).text(app.getString(R.string.chat_inbox))
                click(UiSelector().description(filter))
                text(app.getString(R.string.chat_inbox))
                instrumentation.setInTouchMode(false)
                // The popup can close without the accessibility event that pressBack() awaits.
                assertTrue("Could not inject Back", device.pressKeyCode(KeyEvent.KEYCODE_BACK))
                assertTrue(
                    "Chat filter popup stayed open after Back",
                    device.wait(Until.gone(inbox), 10_000),
                )
                device.awaitKeyboardFocus(By.pkg(app.packageName).desc(filter))
                assertTrue(device.pressDPadCenter())
                text(app.getString(R.string.chat_inbox))
                assertTrue(device.pressKeyCode(KeyEvent.KEYCODE_MOVE_END))
                device.awaitKeyboardFocus(
                    By.pkg(app.packageName).text(app.getString(R.string.chat_muted))
                )
                assertTrue(device.pressDPadUp())
                device.awaitKeyboardFocus(By.pkg(app.packageName).text(archived))
                assertTrue(device.pressDPadCenter())
                text(app.getString(R.string.chat_empty_archived))
                device.awaitKeyboardFocus(By.pkg(app.packageName).desc(filter))
                assertTrue(
                    device.wait(
                        Until.hasObject(
                            By.pkg(app.packageName).text(archived).hasAncestor(chatListRegion(app))
                        ),
                        10_000,
                    )
                )
                text("Native history reply")
                assertTrue(device.pressDPadCenter())
                clickText(app.getString(R.string.chat_inbox))
                revealText("Project chat")
                click(UiSelector().description(app.getString(R.string.settings)))
                text(app.getString(R.string.appearance))
                assertTrue(device.pressKeyCode(KeyEvent.KEYCODE_BACK))
                device.awaitChatList(app)
                text("Native history reply")
            } finally {
                device.executeShellCommand("wm size ${originalSize ?: "reset"}")
                device.executeShellCommand("wm density ${originalDensity ?: "reset"}")
            }
            assertTrue(device.wait(Until.gone(chatListRegion(app)), 10_000))
            text("Native history reply")
            click(UiSelector().description(app.getString(R.string.back)))
            revealText("Project chat")
            revealText("Research")
            clickText("Research")
            assertTrue(device.wait(Until.gone(By.text("Project chat")), 10_000))

            revealText("Personal chat")
            val row = text("Personal chat").visibleBounds
            val swipeDensity = app.resources.displayMetrics.density
            val start = Point(row.centerX(), row.centerY())
            fun swipePoint(horizontal: Int, vertical: Int) =
                Point(
                    start.x + (horizontal * swipeDensity).toInt(),
                    start.y + (vertical * swipeDensity).toInt(),
                )
            val downAt = SystemClock.uptimeMillis()
            val finger =
                MotionEvent.PointerProperties().apply {
                    id = 0
                    toolType = MotionEvent.TOOL_TYPE_FINGER
                }
            fun injectSwipeEvent(action: Int, point: Point): Boolean {
                val coordinates =
                    MotionEvent.PointerCoords().apply {
                        x = point.x.toFloat()
                        y = point.y.toFloat()
                        pressure =
                            if (
                                action == MotionEvent.ACTION_UP ||
                                    action == MotionEvent.ACTION_CANCEL
                            )
                                0f
                            else 1f
                        this.size = 1f
                    }
                val event =
                    MotionEvent.obtain(
                        downAt,
                        SystemClock.uptimeMillis(),
                        action,
                        1, // pointerCount
                        arrayOf(finger),
                        arrayOf(coordinates),
                        0, // metaState
                        0, // buttonState
                        1f, // xPrecision
                        1f, // yPrecision
                        0, // deviceId
                        0, // edgeFlags
                        InputDevice.SOURCE_TOUCHSCREEN,
                        0, // flags
                    )
                try {
                    return instrumentation.uiAutomation.injectInputEvent(event, true)
                } finally {
                    event.recycle()
                }
            }
            val personalChat = By.pkg(app.packageName).text("Personal chat")
            fun captureSwipe(displacement: Int, name: String) {
                val point = swipePoint(displacement, 0)
                // A second sample at the same point lets platform resampling settle at the target.
                repeat(2) { assertTrue(injectSwipeEvent(MotionEvent.ACTION_MOVE, point)) }
                val targetRight = row.right + point.x - start.x
                assertTrue(
                    "Chat row failed to follow the $displacement dp swipe",
                    device.wait(
                        object : Condition<UiDevice, Boolean> {
                            override fun apply(device: UiDevice): Boolean =
                                device.findObject(personalChat)?.visibleBounds?.right?.let {
                                    abs(it - targetRight) <= 2
                                } == true
                        },
                        10_000,
                    ),
                )
                takeScreenshot().writeToTestStorage(name)
            }
            assertTrue(injectSwipeEvent(MotionEvent.ACTION_DOWN, start))
            var released = false
            try {
                captureSwipe(-36, "android-swipe-archive-icon")
                captureSwipe(-104, "android-swipe-archive-ready")
                val diagonal = swipePoint(-96, 72)
                assertTrue(injectSwipeEvent(MotionEvent.ACTION_MOVE, diagonal))
                assertTrue(injectSwipeEvent(MotionEvent.ACTION_UP, diagonal))
                released = true
            } finally {
                if (!released) {
                    runCatching { check(injectSwipeEvent(MotionEvent.ACTION_CANCEL, start)) }
                        .exceptionOrNull()
                        ?.let(failures::add)
                }
            }
            text("Personal chat")
            device.waitForIdle()
            assertTrue("A diagonal release must not archive the chat", rowEvents.isEmpty())
            assertTrue(device.swipe(arrayOf(start, swipePoint(-96, 0)), 16))
            val message = By.pkg(app.packageName).text(app.getString(R.string.chat_undo_archived))
            val undo = By.pkg(app.packageName).text(app.getString(R.string.chat_undo))
            val dismiss =
                By.pkg(app.packageName).desc(app.getString(R.string.chat_feedback_dismiss))
            fun awaitUndoLayout(stacked: Boolean) {
                assertTrue(
                    "Expected the Undo action group to be ${if (stacked) "stacked" else "inline"}",
                    device.wait(
                        object : Condition<UiDevice, Boolean> {
                            override fun apply(device: UiDevice): Boolean {
                                val body = device.findObject(message)?.visibleBounds ?: return false
                                val button = device.findObject(undo)?.visibleBounds ?: return false
                                val close =
                                    device.findObject(dismiss)?.visibleBounds ?: return false
                                val sameActions =
                                    kotlin.math.abs(button.centerY() - close.centerY()) <= 1 &&
                                        button.right <= close.left
                                return sameActions &&
                                    if (stacked) body.bottom <= button.top
                                    else body.centerY() in button.top until button.bottom
                            }
                        },
                        10_000,
                    ),
                )
            }
            awaitUndoLayout(stacked = false)
            takeScreenshot().writeToTestStorage("android-chat-list-undo")
            val fontScale = device.executeShellCommand("settings get system font_scale").trim()
            try {
                device.executeShellCommand("wm size 320x800")
                device.executeShellCommand("wm density 160")
                device.executeShellCommand("settings put system font_scale 2.0")
                device.awaitChatList(app)
                awaitUndoLayout(stacked = true)
                scenario.onActivity { activity ->
                    assertTrue(activity.resources.configuration.fontScale >= 2f)
                    assertTrue(activity.resources.configuration.screenWidthDp <= 320)
                }
                takeScreenshot().writeToTestStorage("android-chat-list-undo-large-text")
                checkNotNull(device.findObject(undo)).click()
                assertTrue(device.wait(Until.gone(undo), 10_000))
                revealText("Personal chat")
                assertTrue(rowEvents.size == 2)
                toolLabels.forEach { tool(it) }
                takeScreenshot().writeToTestStorage("android-list-home-large-text")
            } finally {
                if (fontScale.toFloatOrNull() == null)
                    device.executeShellCommand("settings delete system font_scale")
                else device.executeShellCommand("settings put system font_scale $fontScale")
                device.executeShellCommand("wm size ${originalSize ?: "reset"}")
                device.executeShellCommand("wm density ${originalDensity ?: "reset"}")
            }
        } catch (error: Throwable) {
            failures.add(error)
            try {
                takeScreenshot().writeToTestStorage("native-chat-list-failure.png")
            } catch (diagnostic: Throwable) {
                error.addSuppressed(diagnostic)
            }
        } finally {
            gate.countDown()
            firstHistory.countDown()
            for (cleanup in
                listOf<() -> Unit>(
                    { scenario?.close() },
                    { runBlocking { withTimeout(10_000) { chatJob?.join() } } },
                    { fixture.close() },
                    { savedCache.restore() },
                    { app.restoreApiPreferences(savedPreferences) },
                    { app.chatService = previous },
                    { auth.state.value = previousAuth },
                    { instrumentation.resetInTouchMode() },
                )) {
                try {
                    cleanup()
                } catch (error: Throwable) {
                    failures.add(error)
                }
            }
        }
        MultipleFailureException.assertEmpty(failures)
    }
}
