package ai.okou.android.workflows

import ai.okou.android.CHAT_DATE
import ai.okou.android.api.ApiFailure
import ai.okou.android.api.generated.CanonicalOptional
import ai.okou.android.api.generated.CreateWorkflowAutomationRequest
import ai.okou.android.api.generated.UpdateWorkflowAutomationRequest
import ai.okou.android.api.generated.UpdateWorkflowRequest
import ai.okou.android.api.generated.WorkflowAutomation
import ai.okou.android.api.generated.WorkflowAutomationVariant1
import ai.okou.android.api.generated.WorkflowAutomationVariant1Kind
import ai.okou.android.api.generated.WorkflowAutomationVariant1ScheduleVariant1
import ai.okou.android.api.generated.WorkflowAutomationVariant1ScheduleVariant1Type
import ai.okou.android.api.generated.WorkflowDetail
import ai.okou.android.api.generated.WorkflowDetailVisibility
import ai.okou.android.api.generated.WorkflowRunHistory
import ai.okou.android.api.generated.WorkflowRunHistoryEntry
import ai.okou.android.api.generated.WorkflowRunHistoryEntryStatus
import ai.okou.android.api.generated.WorkflowRunHistoryEntryTrigger
import ai.okou.android.api.generated.WorkflowSummary
import ai.okou.android.api.generated.WorkflowSummaryVisibility
import ai.okou.android.api.generated.WorkspaceWorkflowAutomations
import ai.okou.android.api.generated.WorkspaceWorkflowAutomationsItem
import ai.okou.android.chat.SearchRead
import ai.okou.android.chat.SearchRefresh
import ai.okou.android.chat.SearchWorkflowHit
import ai.okou.android.chat.searchCatalog
import ai.okou.android.state.WorkflowTab
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import java.io.IOException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
internal abstract class WorkflowModelTestFixture {
    protected val recentRun =
        WorkflowRunHistoryEntry(
            id = "48da3630-376b-4a70-82ce-f1d8e17a4433",
            createdAt = "2026-11-23T01:00:00.000Z",
            status = WorkflowRunHistoryEntryStatus.RUNNING,
            trigger = WorkflowRunHistoryEntryTrigger.SCHEDULE,
            eventType = null,
            chatThreadId = "80d3cd3c-76aa-477f-90de-bdf6d58705d6",
        )
    protected val earlierRun =
        recentRun.copy(
            id = "f84ea6d9-3243-450b-a58e-488fd5428130",
            createdAt = "2026-11-22T01:00:00.000Z",
            status = WorkflowRunHistoryEntryStatus.FAILED,
            chatThreadId = null,
        )

    protected fun check(action: suspend TestScope.(Service, WorkflowModel) -> Unit) = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        val service = Service()
        val store = ViewModelStore()
        val model =
            ViewModelProvider(
                store,
                viewModelFactory {
                    initializer {
                        WorkflowModel(service, { true }, { throw it }) { testScheduler.currentTime }
                    }
                },
            )[WorkflowModel::class.java]
        try {
            model.foregroundChanged(true)
            action(service, model)
        } finally {
            store.clear()
            runCurrent()
            Dispatchers.resetMain()
        }
    }

    protected class Service : WorkflowService {
        val historyCursors = mutableListOf<String?>()
        var historyRead: suspend (String, String?) -> WorkflowRunHistory = { _, _ ->
            WorkflowRunHistory(emptyList(), null)
        }
        val summary =
            WorkflowSummary(
                id = "a1111111-1111-4111-8111-111111111111",
                name = "release-review",
                displayName = "Release review",
                description = null,
                visibility = WorkflowSummaryVisibility.PRIVATE,
                ownerUserId = "user-a",
                createdAt = CHAT_DATE,
                canManage = true,
                canPublish = true,
                official = null,
                importSource = null,
            )
        var detail =
            WorkflowDetail(
                id = summary.id,
                name = summary.name,
                displayName = summary.displayName,
                description = null,
                visibility = WorkflowDetailVisibility.PRIVATE,
                ownerUserId = summary.ownerUserId,
                createdAt = CHAT_DATE,
                canManage = true,
                canPublish = true,
                official = null,
                importSource = null,
                createdByUserId = summary.ownerUserId,
                updatedByUserId = summary.ownerUserId,
                updatedAt = CHAT_DATE,
                instruction = null,
                files = null,
                fileContents = null,
                automations = emptyList(),
            )
        var catalogRead: suspend () -> List<WorkflowSummary> = { listOf(summary) }
        var detailRead: suspend (String) -> WorkflowDetail = { detail }
        var rulesRead: suspend () -> WorkspaceWorkflowAutomations = { emptyList() }
        var connectionsRead: suspend () -> Set<String> = { emptySet() }
        var toggle: suspend (String, Boolean) -> WorkflowAutomation = { _, _ ->
            error("Unexpected automation toggle")
        }
        var updateRule: suspend (String, UpdateWorkflowAutomationRequest) -> WorkflowAutomation =
            { _, _ ->
                error("Unexpected automation update")
            }
        val toggleRequests = mutableListOf<Pair<String, Boolean>>()
        val workflowUpdates = mutableListOf<UpdateWorkflowRequest>()
        var detailReads = 0
            private set

        var catalogReads = 0
            private set

        var ruleReads = 0
            private set

        var connectionReads = 0
            private set

        var createAttempts = 0
            private set

        fun weeklyRule() =
            WorkflowAutomationVariant1(
                id = "weekly",
                ownerUserId = summary.ownerUserId,
                enabled = true,
                chatThreadId = null,
                nextRunAt = CHAT_DATE,
                lastRunAt = null,
                official = null,
                kind = WorkflowAutomationVariant1Kind.SCHEDULE,
                schedule =
                    WorkflowAutomationVariant1ScheduleVariant1(
                        WorkflowAutomationVariant1ScheduleVariant1Type.CRON,
                        "0 9 * * 1",
                        "UTC",
                    ),
                scheduleSummary = "Weekly at 09:00",
            )

        override suspend fun workflows(): List<WorkflowSummary> {
            catalogReads++
            return catalogRead()
        }

        override suspend fun workflow(id: String): WorkflowDetail {
            detailReads++
            return detailRead(id)
        }

        override suspend fun workflowRunHistory(id: String, cursor: String?): WorkflowRunHistory {
            historyCursors.add(cursor)
            return historyRead(id, cursor)
        }

        override suspend fun workflowAutomations(): WorkspaceWorkflowAutomations {
            ruleReads++
            return rulesRead()
        }

        override suspend fun workflowConnections(): Set<String> {
            connectionReads++
            return connectionsRead()
        }

        override suspend fun updateWorkflow(
            id: String,
            request: UpdateWorkflowRequest,
        ): WorkflowDetail {
            workflowUpdates += request
            detail =
                detail.copy(instruction = (request.instruction as CanonicalOptional.Present).value)
            return detail
        }

        override suspend fun createAutomation(
            workflowId: String,
            request: CreateWorkflowAutomationRequest,
        ): Nothing {
            createAttempts++
            throw ApiFailure.Network(IOException("Automation response was lost"))
        }

        override suspend fun updateAutomation(
            id: String,
            request: UpdateWorkflowAutomationRequest,
        ): WorkflowAutomation = updateRule(id, request)

        override suspend fun setAutomationEnabled(
            id: String,
            enabled: Boolean,
        ): WorkflowAutomation {
            toggleRequests += id to enabled
            return toggle(id, enabled)
        }
    }
}

@OptIn(ExperimentalCoroutinesApi::class)
internal class WorkflowModelTest : WorkflowModelTestFixture() {
    @Test
    fun detailReadKeepsItsDispatchTimeThroughRetryAndResetsOnSelection() = check { service, model ->
        val firstId = service.summary.id
        val nextId = "a2222222-2222-4222-8222-222222222222"
        val finish = CompletableDeferred<Unit>()
        val attempts = mutableListOf<String>()
        service.detailRead = { id ->
            attempts += id
            if (attempts.size == 1) throw ApiFailure.Http(503, null, null, null)
            finish.await()
            service.detail.copy(id = id)
        }

        model.select(firstId)
        model.visibilityChanged(true)
        assertNull(model.state.value.detailReadStart)
        runCurrent()
        val first = checkNotNull(model.state.value.detailReadStart)
        advanceTimeBy(3_000)
        runCurrent()
        assertEquals(listOf(firstId, firstId), attempts)
        assertEquals(first, model.state.value.detailReadStart)
        assertEquals(3_000L, first.startedAt.elapsedNow().inWholeMilliseconds)

        model.select(nextId)
        assertNull(model.state.value.detailReadStart)
        runCurrent()
        val next = checkNotNull(model.state.value.detailReadStart)
        assertEquals(listOf(firstId, firstId, nextId), attempts)
        assertEquals(nextId, next.workflowId)
        assertEquals(0L, next.startedAt.elapsedNow().inWholeMilliseconds)

        finish.complete(Unit)
        runCurrent()
        assertEquals(nextId, model.state.value.detail?.id)
        assertNull(model.state.value.detailReadStart)
    }

    @Test
    fun workspaceSearchReusesTheUnexpiredCatalogAndSharesItsRefreshWithTheDirectory() =
        check { service, model ->
            model.visibilityChanged(true)
            runCurrent()
            model.visibilityChanged(false)
            val saved = listOf(service.summary)
            val noMatches = SearchRead.Ready(emptyList<SearchWorkflowHit>())
            assertEquals(noMatches, model.state.value.searchCatalog("unmatched"))
            val refresh = CompletableDeferred<Unit>()
            service.catalogRead = {
                refresh.await()
                throw ApiFailure.Http(503, null, null, null)
            }

            model.searchVisibilityChanged(true)
            runCurrent()
            assertEquals(saved, model.state.value.catalog)
            val matches = model.state.value.searchCatalog("release") as SearchRead.Ready
            assertEquals(SearchRefresh.Reading, matches.refresh)
            assertEquals(listOf(service.summary.id), matches.rows.map { it.id })
            assertEquals(
                noMatches.copy(refresh = SearchRefresh.Reading),
                model.state.value.searchCatalog("unmatched"),
            )
            assertEquals(2, service.catalogReads)
            assertEquals(1, service.ruleReads)
            assertEquals(1, service.connectionReads)

            model.visibilityChanged(true)
            runCurrent()
            assertEquals(2, service.catalogReads)
            model.visibilityChanged(false)
            refresh.complete(Unit)
            runCurrent()
            assertEquals(saved, model.state.value.catalog)
            assertNull(model.state.value.catalogFailure)
            assertEquals(matches, model.state.value.searchCatalog("release"))

            model.searchVisibilityChanged(false)
            assertEquals(
                matches.copy(refresh = SearchRefresh.Idle),
                model.state.value.searchCatalog("release"),
            )
            advanceTimeBy(600_000)
            val newCatalog = CompletableDeferred<List<WorkflowSummary>>()
            service.catalogRead = { newCatalog.await() }
            model.searchVisibilityChanged(true)
            runCurrent()
            assertNull(model.state.value.catalog)
            assertNull(model.state.value.catalogFailure)
            assertEquals(SearchRead.Loading, model.state.value.searchCatalog("release"))
            newCatalog.complete(saved)
            runCurrent()
            assertEquals(saved, model.state.value.catalog)
            assertEquals(
                SearchRead.Ready(emptyList<Nothing>()),
                model.state.value.searchCatalog("unmatched"),
            )
        }

    @Test
    fun searchReplacesAFailedInitialCatalogWithLoadingOnResume() = check { service, model ->
        service.catalogRead = { throw ApiFailure.Network(IOException("Connection failed")) }
        model.searchVisibilityChanged(true)
        runCurrent()

        advanceTimeBy(3_000)
        runCurrent()
        assertEquals(SearchRead.Loading, model.state.value.searchCatalog("release"))
        advanceTimeBy(3_000)
        runCurrent()
        assertEquals(SearchRead.Failed, model.state.value.searchCatalog("release"))

        val recovered = CompletableDeferred<List<WorkflowSummary>>()
        service.catalogRead = { recovered.await() }
        model.foregroundChanged(false)
        model.foregroundChanged(true)
        runCurrent()
        assertEquals(SearchRead.Loading, model.state.value.searchCatalog("release"))
        recovered.complete(emptyList())
        runCurrent()
        assertEquals(
            SearchRead.Ready(emptyList<Nothing>()),
            model.state.value.searchCatalog("release"),
        )
    }

    @Test
    fun switchingBackShowsCachedDetailAndReadsTheLatestWhileItIsVisible() =
        check { service, model ->
            val first = service.detail
            val second = first.copy(id = "b2222222-2222-4222-8222-222222222222", name = "other")
            service.catalogRead = { listOf(service.summary, service.summary.copy(id = second.id)) }
            service.detailRead = { if (it == first.id) first else second }
            model.visibilityChanged(true)
            model.select(first.id)
            runCurrent()
            model.select(second.id)
            runCurrent()
            assertEquals(second, model.state.value.detail)

            val updated = CompletableDeferred<WorkflowDetail>()
            service.detailRead = { updated.await() }
            model.select(first.id)
            assertEquals(first, model.state.value.detail)
            runCurrent()
            assertEquals(3, service.detailReads)
            assertEquals(first, model.state.value.detail)

            model.select(first.id, WorkflowTab.History)
            runCurrent()
            assertEquals(3, service.detailReads)

            val refreshed = first.copy(displayName = "Refreshed")
            updated.complete(refreshed)
            runCurrent()
            assertEquals(refreshed, model.state.value.detail)
        }

    @Test
    fun failedCatalogReadRecoversWhenTheAppReturnsToTheForeground() = check { service, model ->
        service.catalogRead = { throw ApiFailure.Network(IOException("Offline")) }
        model.visibilityChanged(true)
        runCurrent()

        assertEquals(1, service.catalogReads)
        assertNull(model.state.value.catalogFailure)
        assertNull(model.state.value.catalog)
        advanceTimeBy(6_000)
        runCurrent()
        assertEquals(3, service.catalogReads)
        assertTrue(model.state.value.catalogFailure is WorkflowReadFailure.Failed)

        val response = CompletableDeferred<List<WorkflowSummary>>()
        service.catalogRead = { response.await() }
        model.foregroundChanged(false)
        model.foregroundChanged(true)
        runCurrent()
        assertEquals(4, service.catalogReads)
        assertTrue(model.state.value.catalogRefreshing)
        assertNull(model.state.value.catalogFailure)
        assertNull(model.state.value.catalog)

        response.complete(listOf(service.summary))
        runCurrent()
        assertEquals(listOf(service.summary), model.state.value.catalog)
        assertNull(model.state.value.catalogFailure)
    }

    @Test
    fun foregroundingRefreshesTheFailedCatalogWhileOnlySearchIsOpen() = check { service, model ->
        model.searchVisibilityChanged(true)
        runCurrent()
        val saved = listOf(service.summary)
        assertEquals(saved, model.state.value.catalog)
        model.searchVisibilityChanged(false)

        service.catalogRead = { throw ApiFailure.Network(IOException("Offline")) }
        model.searchVisibilityChanged(true)
        runCurrent()
        advanceTimeBy(6_000)
        runCurrent()
        assertEquals(4, service.catalogReads)
        assertEquals(saved, model.state.value.catalog)
        val first = model.state.value.catalogFailure as WorkflowReadFailure.Failed

        model.foregroundChanged(false)
        model.foregroundChanged(true)
        runCurrent()
        advanceTimeBy(6_000)
        runCurrent()
        assertEquals(7, service.catalogReads)
        assertEquals(saved, model.state.value.catalog)
        val second = model.state.value.catalogFailure as WorkflowReadFailure.Failed
        assertTrue(second.sequence > first.sequence)

        val refreshed = listOf(service.summary.copy(displayName = "Refreshed"))
        service.catalogRead = { refreshed }
        model.foregroundChanged(false)
        model.foregroundChanged(true)
        runCurrent()
        assertEquals(8, service.catalogReads)
        assertEquals(refreshed, model.state.value.catalog)
        assertNull(model.state.value.catalogFailure)
        assertEquals(0, service.ruleReads)
        assertEquals(0, service.connectionReads)

        model.searchVisibilityChanged(false)
        advanceTimeBy(600_000)
        model.foregroundChanged(false)
        model.foregroundChanged(true)
        runCurrent()
        assertEquals(8, service.catalogReads)
    }

    @Test
    fun readRetriesRespectTheServerSchedule() = check { service, model ->
        service.catalogRead = {
            when (service.catalogReads) {
                1 -> throw ApiFailure.Http(429, null, null, 9)
                2 -> throw ApiFailure.Http(503, null, null, 1)
            }
            listOf(service.summary)
        }
        model.visibilityChanged(true)
        runCurrent()
        assertNull(model.state.value.catalogFailure)

        advanceTimeBy(8_999)
        runCurrent()
        assertEquals(1, service.catalogReads)
        advanceTimeBy(1)
        runCurrent()
        assertEquals(2, service.catalogReads)
        advanceTimeBy(999)
        runCurrent()
        assertEquals(2, service.catalogReads)
        assertNull(model.state.value.catalogFailure)
        advanceTimeBy(1)
        runCurrent()

        assertEquals(listOf(service.summary), model.state.value.catalog)
        assertNull(model.state.value.catalogFailure)
        assertEquals(3, service.catalogReads)
        assertEquals(1, service.connectionReads)
    }

    @Test
    fun foregroundingRestartsTheFailedDetailWhileConnectionsArePending() = check { service, model ->
        val connections = CompletableDeferred<Set<String>>()
        service.connectionsRead = { connections.await() }
        service.detailRead = {
            if (service.detailReads <= 3) throw ApiFailure.Network(IOException("Offline"))
            service.detail
        }
        model.select(service.summary.id)
        model.visibilityChanged(true)
        advanceTimeBy(6_000)
        runCurrent()
        assertTrue(model.state.value.detailFailure is WorkflowReadFailure.Failed)

        model.foregroundChanged(false)
        model.foregroundChanged(true)
        runCurrent()
        assertEquals(service.detail, model.state.value.detail)
        assertNull(model.state.value.detailFailure)
        assertNull(model.state.value.connections)
    }

    @Test
    fun cachedReadsWaitForTwoRetriesAndRetainTheEditorOnTerminalFailure() =
        check { service, model ->
            model.select(service.summary.id)
            model.visibilityChanged(true)
            runCurrent()
            assertNotNull(model.state.value.catalog)
            val opened = checkNotNull(model.state.value.detail).editableInstructions()
            val editing = opened.copy(value = opened.value.copy(instruction = "Unsaved edit"))
            model.edit(editing)

            val catalogAttempts = mutableListOf<Long>()
            val start = testScheduler.currentTime
            service.catalogRead = {
                catalogAttempts += testScheduler.currentTime - start
                if (catalogAttempts.size <= 3) throw ApiFailure.Network(IOException("Offline"))
                listOf(service.summary)
            }
            model.foregroundChanged(false)
            model.foregroundChanged(true)
            runCurrent()

            advanceTimeBy(5_999)
            runCurrent()
            assertEquals(listOf(0L, 3_000L), catalogAttempts)
            assertEquals(listOf(service.summary), model.state.value.catalog)
            assertNull(model.state.value.catalogFailure)
            assertNull(model.state.value.detailFailure)
            assertEquals(editing, model.state.value.editor)
            assertEquals(2, service.detailReads)

            advanceTimeBy(1)
            runCurrent()
            assertTrue(model.state.value.catalogFailure is WorkflowReadFailure.Failed)
            assertEquals(listOf(service.summary), model.state.value.catalog)
            assertEquals(editing, model.state.value.editor)
            advanceTimeBy(60_000)
            runCurrent()
            assertEquals(listOf(0L, 3_000L, 6_000L), catalogAttempts)

            model.foregroundChanged(false)
            model.foregroundChanged(true)
            runCurrent()
            assertEquals(listOf(0L, 3_000L, 6_000L, 66_000L), catalogAttempts)
            assertNull(model.state.value.catalogFailure)
            assertEquals(3, service.detailReads)
        }

    @Test
    fun leavingTheDirectoryCancelsScheduledReadRetries() = check { service, model ->
        service.catalogRead = { throw ApiFailure.Http(503, null, null, null) }
        model.visibilityChanged(true)
        runCurrent()
        assertEquals(1, service.catalogReads)

        model.visibilityChanged(false)
        advanceTimeBy(6_000)
        runCurrent()
        assertEquals(1, service.catalogReads)

        service.catalogRead = { listOf(service.summary) }
        model.visibilityChanged(true)
        runCurrent()
        assertEquals(2, service.catalogReads)
        assertEquals(listOf(service.summary), model.state.value.catalog)
    }

    @Test
    fun olderDetailCannotReplaceNewerCatalogAndRules() = check { service, model ->
        val olderDetail = CompletableDeferred<WorkflowDetail>()
        val latestSummary = service.summary.copy(displayName = "Renamed on another device")
        val active = service.weeklyRule()
        service.detailRead = { olderDetail.await() }
        service.catalogRead = { listOf(latestSummary) }
        service.rulesRead = { listOf(WorkspaceWorkflowAutomationsItem(latestSummary, active)) }

        model.select(service.summary.id)
        model.visibilityChanged(true)
        runCurrent()
        assertNull(model.state.value.detail)
        assertEquals(listOf(latestSummary), model.state.value.catalog)
        assertEquals(listOf(active), model.state.value.rules?.get(service.summary.id))

        olderDetail.complete(
            service.detail.copy(automations = listOf(active.copy(enabled = false))),
        )
        runCurrent()
        assertEquals(latestSummary.displayName, model.state.value.detail?.displayName)
        assertEquals(listOf(latestSummary), model.state.value.catalog)
        assertEquals(listOf(active), model.state.value.detail?.automations)
        assertEquals(listOf(active), model.state.value.rules?.get(service.summary.id))
    }

    @Test
    fun directoryKeepsConfirmedRulesAfterLeavingDetail() = check { service, model ->
        val rules = CompletableDeferred<WorkspaceWorkflowAutomations>()
        val connections = CompletableDeferred<Set<String>>()
        val active = service.weeklyRule()
        service.detail = service.detail.copy(automations = listOf(active))
        service.rulesRead = { rules.await() }
        service.connectionsRead = { connections.await() }
        model.visibilityChanged(true)
        runCurrent()
        model.select(service.summary.id)
        runCurrent()
        assertEquals(listOf(active), model.state.value.detail?.automations)
        model.select(null)
        assertNull(model.state.value.detail)

        val paused = active.copy(enabled = false)
        rules.complete(listOf(WorkspaceWorkflowAutomationsItem(service.summary, paused)))
        runCurrent()
        assertNull(model.state.value.connections)
        assertEquals(listOf(active), model.state.value.rules?.get(service.summary.id))

        connections.complete(emptySet())
        runCurrent()
        assertEquals(emptySet<String>(), model.state.value.connections)
        assertEquals(listOf(active), model.state.value.rules?.get(service.summary.id))

        model.select(service.summary.id)
        runCurrent()
        assertEquals(listOf(active), model.state.value.detail?.automations)
        assertEquals(2, service.detailReads)
        advanceTimeBy(600_000)
        val refreshedDetail = CompletableDeferred<WorkflowDetail>()
        service.detailRead = { refreshedDetail.await() }
        model.foregroundChanged(false)
        model.foregroundChanged(true)
        runCurrent()
        assertEquals(listOf(paused), model.state.value.rules?.get(service.summary.id))
        assertEquals(listOf(paused), model.state.value.detail?.automations)

        refreshedDetail.complete(service.detail.copy(automations = listOf(paused)))
        runCurrent()
        assertEquals(listOf(paused), model.state.value.detail?.automations)
    }

    @Test
    fun directoryKeepsConfirmedSummaryWhenOlderCatalogArrives() = check { service, model ->
        model.visibilityChanged(true)
        runCurrent()
        assertEquals(listOf(service.summary), model.state.value.catalog)

        val catalog = CompletableDeferred<List<WorkflowSummary>>()
        service.catalogRead = { catalog.await() }
        advanceTimeBy(600_000)
        model.foregroundChanged(false)
        model.foregroundChanged(true)
        runCurrent()

        val published =
            service.summary.copy(
                displayName = "Published release review",
                description = "Review the deployment",
                visibility = WorkflowSummaryVisibility.PUBLIC,
            )
        service.detail =
            service.detail.copy(
                displayName = published.displayName,
                description = published.description,
                visibility = WorkflowDetailVisibility.PUBLIC,
            )
        model.select(service.summary.id)
        runCurrent()
        assertEquals(published.displayName, model.state.value.detail?.displayName)
        model.select(null)
        catalog.complete(listOf(service.summary))
        runCurrent()
        assertEquals(listOf(published), model.state.value.catalog)

        model.visibilityChanged(false)
        advanceTimeBy(600_000)
        model.visibilityChanged(true)
        runCurrent()
        assertEquals(listOf(service.summary), model.state.value.catalog)
    }

    @Test
    fun lateCatalogLeavesUnavailableWorkflowRemoved() = check { service, model ->
        val other = service.summary.copy(id = "b2222222-2222-4222-8222-222222222222")
        val previous = listOf(service.summary, other)
        service.catalogRead = { previous }
        model.visibilityChanged(true)
        runCurrent()
        assertEquals(previous, model.state.value.catalog)

        val catalog = CompletableDeferred<List<WorkflowSummary>>()
        service.catalogRead = { catalog.await() }
        advanceTimeBy(600_000)
        model.foregroundChanged(false)
        model.foregroundChanged(true)
        runCurrent()

        service.detailRead = { throw ApiFailure.Http(404, null, null, null) }
        model.select(service.summary.id)
        runCurrent()
        assertEquals(WorkflowReadFailure.Unavailable, model.state.value.detailFailure)
        assertEquals(listOf(other), model.state.value.catalog)
        model.select(null)

        catalog.complete(previous)
        runCurrent()
        assertEquals(listOf(other), model.state.value.catalog)
    }

    @Test
    fun aRefreshedCatalogRemovesAStillFreshDetailThatIsNoLongerVisible() = check { service, model ->
        model.visibilityChanged(true)
        runCurrent()
        advanceTimeBy(60_000)
        model.select(service.summary.id)
        runCurrent()
        assertEquals(service.detail, model.state.value.detail)
        model.select(null)

        service.catalogRead = { emptyList() }
        model.visibilityChanged(false)
        advanceTimeBy(540_000)
        model.visibilityChanged(true)
        runCurrent()
        assertEquals(emptyList<WorkflowSummary>(), model.state.value.catalog)
        assertEquals(1, service.detailReads)

        service.detailRead = { throw ApiFailure.Http(404, null, null, null) }
        model.select(service.summary.id)
        assertNull(model.state.value.detail)
        runCurrent()
        assertEquals(2, service.detailReads)
        assertNull(model.state.value.detail)
        assertEquals(WorkflowReadFailure.Unavailable, model.state.value.detailFailure)
    }
}

@OptIn(ExperimentalCoroutinesApi::class)
internal class WorkflowWriteModelTest : WorkflowModelTestFixture() {
    @Test
    fun successfulSaveRestartsCatalogWithoutRestartingAnIndependentConnectionRead() =
        check { service, model ->
            var holdCatalog = true
            val connections = CompletableDeferred<Set<String>>()
            service.catalogRead = {
                if (holdCatalog) awaitCancellation()
                listOf(service.summary)
            }
            service.connectionsRead = { connections.await() }
            model.select(service.summary.id)
            model.visibilityChanged(true)
            runCurrent()
            assertNotNull(model.state.value.detail)
            assertNull(model.state.value.catalog)

            holdCatalog = false
            val opened = checkNotNull(model.state.value.detail).editableInstructions()
            val edited = opened.copy(value = opened.value.copy(instruction = "Confirmed"))
            model.edit(edited)
            model.save(edited)
            runCurrent()

            assertEquals("Confirmed", model.state.value.detail?.instruction)
            assertEquals(listOf(service.summary), model.state.value.catalog)
            assertTrue(model.state.value.rules?.isEmpty() == true)
            assertEquals(1, service.connectionReads)
            connections.complete(setOf("gmail"))
            runCurrent()
            assertEquals(setOf("gmail"), model.state.value.connections)
        }

    @Test
    fun instructionSaveUsesTheCurrentEditor() = check { service, model ->
        model.select(service.summary.id)
        model.visibilityChanged(true)
        runCurrent()
        val opened = checkNotNull(model.state.value.detail).editableInstructions()
        val previous = opened.copy(value = opened.value.copy(instruction = "Older edit"))
        val current = opened.copy(value = opened.value.copy(instruction = "Current edit"))
        model.edit(previous)
        model.edit(current)
        model.save(previous)
        runCurrent()

        assertEquals(current, model.state.value.editor)
        assertNull(model.state.value.detail?.instruction)
        model.save(current)
        runCurrent()
        assertEquals("Current edit", model.state.value.detail?.instruction)
        assertNull(model.state.value.editor)
    }

    @Test
    fun workflowRefreshFillsAPristineEditorAndSavesDifferencesFromTheLatestFields() =
        check { service, model ->
            model.select(service.summary.id)
            model.visibilityChanged(true)
            runCurrent()
            model.edit(checkNotNull(model.state.value.detail).editableInstructions())
            val session = model.state.value.editing as WorkflowEditSession.Instructions
            val summary = service.summary.copy(displayName = "New name")
            service.catalogRead = { listOf(summary) }
            val latestDetail = CompletableDeferred<WorkflowDetail>()
            service.detailRead = { latestDetail.await() }
            model.foregroundChanged(false)
            model.foregroundChanged(true)
            runCurrent()

            val pristine = model.state.value.editor as WorkflowEdit.Instructions
            assertSame(session, model.state.value.editing)
            assertEquals("New name", pristine.value.title)
            assertFalse(pristine.canSave)
            val selection = androidx.compose.ui.text.TextRange(2, 5)
            session.purpose.edit {
                replace(0, length, "My purpose")
                this.selection = selection
            }
            val edited = session.draft
            service.detail =
                service.detail.copy(
                    displayName = summary.displayName,
                    description = "Updated purpose",
                    instruction = "Updated instruction",
                )
            latestDetail.complete(service.detail)
            runCurrent()

            val draft = model.state.value.editor as WorkflowEdit.Instructions
            assertSame(session, model.state.value.editing)
            assertEquals(selection, session.purpose.selection)
            assertEquals(edited.value, draft.value)
            assertEquals("Updated instruction", draft.original.instruction)
            assertTrue(draft.canSave)
            model.save(draft)
            runCurrent()
            val sent = service.workflowUpdates.single()
            assertEquals(CanonicalOptional.Absent, sent.displayName)
            assertEquals(CanonicalOptional.Present("My purpose"), sent.description)
            assertEquals(CanonicalOptional.Present(""), sent.instruction)
            assertNull(model.state.value.editor)
        }

    @Test
    fun instructionSaveKeepsTheConfirmedNameWhenTheCommandWasPrefilled() = check { service, model ->
        service.detail = service.detail.copy(displayName = "   ")
        service.catalogRead = {
            listOf(service.summary.copy(displayName = service.detail.displayName))
        }
        model.select(service.summary.id)
        model.visibilityChanged(true)
        runCurrent()
        model.edit(checkNotNull(model.state.value.detail).editableInstructions())

        val editing = model.state.value.editing as WorkflowEditSession.Instructions
        val instructions = "Review the final launch assets."
        editing.instruction.edit { replace(0, length, instructions) }
        val confirmedTitle = "Release review from another device"
        service.detail = service.detail.copy(displayName = confirmedTitle)
        model.foregroundChanged(false)
        model.foregroundChanged(true)
        runCurrent()

        val draft = model.state.value.editor as WorkflowEdit.Instructions
        assertEquals(confirmedTitle, draft.original.title)
        assertEquals(service.summary.name, editing.title.text.toString())
        model.save(draft)
        runCurrent()

        val sent = service.workflowUpdates.single()
        assertEquals(CanonicalOptional.Absent, sent.displayName)
        assertEquals(CanonicalOptional.Present(instructions), sent.instruction)
        assertEquals(confirmedTitle, model.state.value.detail?.displayName)
    }

    @Test
    fun workflowEditFromThePreviousFrameUsesTheLatestConfirmedValue() = check { service, model ->
        model.select(service.summary.id)
        model.visibilityChanged(true)
        runCurrent()
        val opened = checkNotNull(model.state.value.detail).editableInstructions()
        val rendered = opened.copy(value = opened.value.copy(instruction = "Local edit"))
        model.edit(rendered)
        service.detail = service.detail.copy(instruction = "Updated elsewhere")
        model.foregroundChanged(false)
        model.foregroundChanged(true)
        runCurrent()

        val refreshed = model.state.value.editor as WorkflowEdit.Instructions
        assertEquals("Updated elsewhere", refreshed.original.instruction)
        model.edit(
            rendered.copy(value = rendered.value.copy(instruction = opened.value.instruction)),
        )
        val current = model.state.value.editor as WorkflowEdit.Instructions
        assertEquals(opened.value, current.value)
        assertEquals(refreshed.original, current.original)
        assertTrue(current.canSave)
    }

    @Test
    fun aConfirmedSaveRefreshesTheDetailCacheAge() = check { service, model ->
        model.select(service.summary.id)
        model.visibilityChanged(true)
        runCurrent()
        advanceTimeBy(590_000)
        val opened = checkNotNull(model.state.value.detail).editableInstructions()
        val edited = opened.copy(value = opened.value.copy(instruction = "Confirmed"))
        model.edit(edited)
        model.save(edited)
        runCurrent()
        assertEquals(1, service.detailReads)

        model.visibilityChanged(false)
        advanceTimeBy(20_000)
        service.detailRead = { awaitCancellation() }
        model.visibilityChanged(true)
        assertNull(model.state.value.catalog)
        assertEquals("Confirmed", model.state.value.detail?.instruction)
        runCurrent()
        assertEquals(2, service.detailReads)
        assertEquals("Confirmed", model.state.value.detail?.instruction)
    }

    @Test
    fun uncertainCreationIgnoresAnotherSaveFromTheSameEditor() = check { service, model ->
        model.select(service.summary.id)
        model.visibilityChanged(true)
        runCurrent()
        val editor = WorkflowEdit.Rule(id = null, original = RuleFields(timezone = "UTC"))
        model.edit(editor)
        model.save(editor)
        runCurrent()

        assertEquals(WorkflowWriteFailure.UncertainCreate, model.state.value.issue?.failure)
        assertEquals(editor, model.state.value.editor)
        assertEquals(2, service.detailReads)
        assertEquals(1, service.catalogReads)
        assertEquals(1, service.ruleReads)
        assertEquals(1, service.connectionReads)
        model.save(editor)
        runCurrent()
        assertEquals(1, service.createAttempts)
    }
}

@OptIn(ExperimentalCoroutinesApi::class)
internal class WorkflowToggleModelTest : WorkflowModelTestFixture() {
    private fun TestScope.openRule(
        service: Service,
        model: WorkflowModel,
        rule: WorkflowAutomationVariant1 = service.weeklyRule(),
    ): WorkflowAutomationVariant1 {
        service.detail = service.detail.copy(automations = listOf(rule))
        service.rulesRead = { listOf(WorkspaceWorkflowAutomationsItem(service.summary, rule)) }
        model.visibilityChanged(true)
        runCurrent()
        model.select(service.summary.id, WorkflowTab.Automations)
        runCurrent()
        return rule
    }

    @Test
    fun confirmedToggleRetainsTheRuleUntilItsReceiptWithoutAnExtraRead() = check { service, model ->
        val active = openRule(service, model)
        val receipt = CompletableDeferred<WorkflowAutomation>()
        service.toggle = { _, _ -> receipt.await() }
        val originalReads = service.detailReads

        model.toggle(active)
        runCurrent()
        assertEquals(
            WorkflowToggle(false, WorkflowTogglePhase.Submitting),
            model.state.value.toggles[active.id],
        )
        assertEquals(listOf(active), model.state.value.detail?.automations)
        model.toggle(active)
        runCurrent()

        val paused = active.copy(enabled = false, nextRunAt = null)
        receipt.complete(paused)
        runCurrent()
        assertEquals(listOf(active.id to false), service.toggleRequests)
        assertEquals(listOf(paused), model.state.value.detail?.automations)
        assertEquals(originalReads, service.detailReads)
        assertTrue(model.state.value.toggles.isEmpty())
    }

    @Test
    fun lostToggleReceiptChecksTheSameRuleBeforePublishingSuccess() = check { service, model ->
        val active = openRule(service, model)
        val paused = active.copy(enabled = false, nextRunAt = null)
        val readback = CompletableDeferred<WorkflowDetail>()
        service.detailRead = { readback.await() }
        service.toggle = { _, _ -> throw ApiFailure.Network(IOException("Lost response")) }

        model.toggle(active)
        runCurrent()
        assertEquals(
            WorkflowToggle(false, WorkflowTogglePhase.Checking),
            model.state.value.toggles[active.id],
        )
        assertEquals(listOf(active), model.state.value.detail?.automations)
        assertNull(model.state.value.issue)
        model.toggle(active)
        runCurrent()

        readback.complete(service.detail.copy(automations = listOf(paused)))
        runCurrent()
        assertEquals(listOf(active.id to false), service.toggleRequests)
        assertEquals(listOf(paused), model.state.value.detail?.automations)
        assertTrue(model.state.value.toggles.isEmpty())
        assertNull(model.state.value.issue)
    }

    @Test
    fun leavingDuringAToggleRequiresAReadBeforeTheRuleCanBeChangedAgain() =
        check { service, model ->
            val active = openRule(service, model)
            val receipt = CompletableDeferred<WorkflowAutomation>()
            val readback = CompletableDeferred<WorkflowDetail>()
            service.toggle = { _, _ -> receipt.await() }

            model.toggle(active)
            runCurrent()
            model.select(null)
            receipt.completeExceptionally(ApiFailure.Network(IOException("Lost response")))
            runCurrent()

            service.detailRead = { readback.await() }
            model.select(service.summary.id, WorkflowTab.Automations)
            runCurrent()
            model.toggle(active)
            runCurrent()
            assertEquals(listOf(active.id to false), service.toggleRequests)

            val paused = active.copy(enabled = false, nextRunAt = null)
            readback.complete(service.detail.copy(automations = listOf(paused)))
            runCurrent()
            assertEquals(listOf(paused), model.state.value.detail?.automations)
        }

    @Test
    fun savingAnEditToTheRuleClearsItsPreviousToggleFailure() = check { service, model ->
        val schedule =
            WorkflowAutomationVariant1ScheduleVariant1(
                WorkflowAutomationVariant1ScheduleVariant1Type.CRON,
                "0 9 * * 1-5",
                "UTC",
            )
        val active = openRule(service, model, service.weeklyRule().copy(schedule = schedule))
        service.toggle = { _, _ -> throw ApiFailure.Network(IOException("Lost response")) }
        model.toggle(active)
        runCurrent()
        assertEquals(WorkflowTogglePhase.Failed, model.state.value.toggles[active.id]?.phase)

        val original = checkNotNull(active.editableRule("UTC"))
        val changed = original.copy(value = original.value.copy(time = "09:30"))
        val confirmed = active.copy(schedule = schedule.copy(cronExpression = "30 9 * * 1-5"))
        service.updateRule = { id, request ->
            assertEquals(active.id, id)
            assertEquals(changed.value.updateRequest(), request)
            confirmed
        }
        model.edit(changed)
        model.save(changed)
        runCurrent()

        assertEquals(listOf(confirmed), model.state.value.detail?.automations)
        assertNull(model.state.value.editor)
        assertNull(model.state.value.toggles[active.id])
    }

    @Test
    fun editingAnExistingRuleFollowsConfirmedFieldsWithoutReplacingAnEdit() =
        check { service, model ->
            val schedule =
                WorkflowAutomationVariant1ScheduleVariant1(
                    WorkflowAutomationVariant1ScheduleVariant1Type.CRON,
                    "0 9 * * 1-5",
                    "UTC",
                )
            val rule = openRule(service, model, service.weeklyRule().copy(schedule = schedule))
            model.edit(checkNotNull(rule.editableRule("UTC")))
            fun update(next: WorkflowAutomationVariant1) {
                service.detail = service.detail.copy(automations = listOf(next))
                service.rulesRead = {
                    listOf(WorkspaceWorkflowAutomationsItem(service.summary, next))
                }
                model.foregroundChanged(false)
                model.foregroundChanged(true)
                runCurrent()
            }
            update(rule.copy(schedule = schedule.copy(cronExpression = "30 9 * * 1-5")))
            val pristine = model.state.value.editor as WorkflowEdit.Rule
            assertEquals("09:30", pristine.value.time)
            assertFalse(pristine.canSave)
            val local = pristine.value.copy(time = "10:00")
            model.edit(pristine.copy(value = local))
            update(rule.copy(schedule = schedule.copy(cronExpression = "15 9 * * 1-5")))
            val draft = model.state.value.editor as WorkflowEdit.Rule
            assertEquals(local, draft.value)
            assertEquals("09:15", draft.original.time)
            assertTrue(draft.canSave)
            update(rule.copy(schedule = schedule.copy(cronExpression = "0 10 * * 1-5")))
            val matching = model.state.value.editor as WorkflowEdit.Rule
            assertEquals(local, matching.value)
            assertFalse(matching.canSave)
        }

    @Test
    fun unavailableReadbackKeepsTheActionUnconfirmedUntilAReadSettlesIt() =
        check { service, model ->
            val active = openRule(service, model)
            service.toggle = { _, _ -> throw ApiFailure.Network(IOException("Lost response")) }
            val originalReads = service.detailReads
            service.detailRead = { throw ApiFailure.Network(IOException("Read unavailable")) }

            model.toggle(active)
            advanceTimeBy(6_000)
            runCurrent()
            assertEquals(originalReads + 3, service.detailReads)
            assertEquals(
                WorkflowToggle(false, WorkflowTogglePhase.Unconfirmed),
                model.state.value.toggles[active.id],
            )
            assertEquals(listOf(active), model.state.value.detail?.automations)
            model.toggle(active)
            runCurrent()
            assertEquals(listOf(active.id to false), service.toggleRequests)

            service.detailRead = { service.detail }
            model.foregroundChanged(false)
            model.foregroundChanged(true)
            runCurrent()
            assertEquals(
                WorkflowToggle(false, WorkflowTogglePhase.Failed),
                model.state.value.toggles[active.id],
            )
            val paused = active.copy(enabled = false, nextRunAt = null)
            service.toggle = { _, _ -> paused }
            model.toggle(active)
            runCurrent()
            assertEquals(listOf(active.id to false, active.id to false), service.toggleRequests)
            assertEquals(listOf(paused), model.state.value.detail?.automations)
            assertTrue(model.state.value.toggles.isEmpty())
        }
}

@OptIn(ExperimentalCoroutinesApi::class)
internal class WorkflowHistoryModelTest : WorkflowModelTestFixture() {
    @Test
    fun reopeningRevalidatesEachRangeAndOnlyShowsItsUnexpiredCache() = check { service, model ->
        val rules = CompletableDeferred<WorkspaceWorkflowAutomations>()
        val connections = CompletableDeferred<Set<String>>()
        service.rulesRead = { rules.await() }
        service.connectionsRead = { connections.await() }

        fun reopen() {
            model.visibilityChanged(false)
            model.visibilityChanged(true)
            runCurrent()
        }

        model.visibilityChanged(true)
        runCurrent()
        advanceTimeBy(1_000)
        rules.complete(emptyList())
        runCurrent()
        advanceTimeBy(1_000)
        connections.complete(setOf("gmail"))
        runCurrent()
        advanceTimeBy(1_000)
        model.select(service.summary.id)
        runCurrent()

        val refresh = CompletableDeferred<Unit>()
        service.catalogRead = {
            refresh.await()
            listOf(service.summary)
        }
        service.rulesRead = {
            refresh.await()
            emptyList()
        }
        service.connectionsRead = {
            refresh.await()
            setOf("gmail")
        }
        service.detailRead = {
            refresh.await()
            service.detail
        }

        reopen()
        assertEquals(listOf(service.summary), model.state.value.catalog)
        assertTrue(model.state.value.rules?.isEmpty() == true)
        assertEquals(setOf("gmail"), model.state.value.connections)
        assertEquals(service.detail, model.state.value.detail)
        assertEquals(2, service.catalogReads)
        assertEquals(2, service.ruleReads)
        assertEquals(2, service.connectionReads)
        assertEquals(2, service.detailReads)

        advanceTimeBy(597_000)
        assertEquals(listOf(service.summary), model.state.value.catalog)
        reopen()
        assertNull(model.state.value.catalog)
        assertTrue(model.state.value.rules?.isEmpty() == true)
        assertEquals(setOf("gmail"), model.state.value.connections)
        assertEquals(service.detail, model.state.value.detail)

        advanceTimeBy(1_000)
        reopen()
        assertNull(model.state.value.rules)
        assertEquals(setOf("gmail"), model.state.value.connections)
        assertEquals(service.detail, model.state.value.detail)

        advanceTimeBy(1_000)
        reopen()
        assertNull(model.state.value.connections)
        assertEquals(service.detail, model.state.value.detail)

        advanceTimeBy(1_000)
        reopen()
        assertNull(model.state.value.detail)
        refresh.complete(Unit)
        runCurrent()
        assertEquals(listOf(service.summary), model.state.value.catalog)
        assertEquals(service.detail, model.state.value.detail)
    }

    @Test
    fun historyKeepsLoadedPagesDuringRefreshAndClearsExpiredCacheOnReturn() =
        check { service, model ->
            val id = service.summary.id
            fun page(cursor: String?) =
                if (cursor == null) WorkflowRunHistory(listOf(recentRun), "earlier")
                else WorkflowRunHistory(listOf(earlierRun), null)
            service.historyRead = { workflowId, cursor ->
                assertEquals(id, workflowId)
                page(cursor)
            }
            model.visibilityChanged(true)
            model.select(id)
            runCurrent()
            assertTrue(service.historyCursors.isEmpty())

            model.select(id, WorkflowTab.History)
            runCurrent()
            assertEquals(listOf(recentRun), model.state.value.history?.runs)
            model.loadEarlierRuns()
            model.loadEarlierRuns()
            runCurrent()
            assertEquals(listOf(null, "earlier"), service.historyCursors)
            assertEquals(listOf(recentRun, earlierRun), model.state.value.history?.runs)

            val refresh = CompletableDeferred<Unit>()
            service.historyRead = { _, cursor ->
                refresh.await()
                val page = page(cursor)
                if (cursor == null)
                    page.copy(
                        runs =
                            listOf(
                                recentRun.copy(status = WorkflowRunHistoryEntryStatus.COMPLETED),
                            ),
                    )
                else page
            }
            model.select(id)
            model.select(id, WorkflowTab.History)
            runCurrent()
            assertEquals(listOf(recentRun, earlierRun), model.state.value.history?.runs)
            advanceTimeBy(600_000)
            assertEquals(listOf(recentRun, earlierRun), model.state.value.history?.runs)
            model.visibilityChanged(false)
            model.visibilityChanged(true)
            assertNull(model.state.value.history)
            refresh.complete(Unit)
            runCurrent()
            assertEquals(
                listOf(
                    WorkflowRunHistoryEntryStatus.COMPLETED,
                    WorkflowRunHistoryEntryStatus.FAILED,
                ),
                model.state.value.history?.runs?.map { it.status },
            )
            assertEquals(listOf(null, "earlier"), service.historyCursors.takeLast(2))
        }

    @Test
    fun historyRefreshPreservesTheBoundaryForLoadingEarlierRuns() = check { service, model ->
        val id = service.summary.id
        val olderRun =
            earlierRun.copy(
                id = "4af530dc-2f2d-4be2-9e85-8fd801a20828",
                createdAt = "2026-11-21T01:00:00.000Z",
            )
        val oldestRun =
            earlierRun.copy(
                id = "ebce6d58-1225-4eeb-80fb-861035eeac7d",
                createdAt = "2026-11-20T01:00:00.000Z",
            )
        val runs = mutableListOf(recentRun, earlierRun, olderRun, oldestRun)
        service.historyRead = { _, cursor ->
            val start = if (cursor == null) 0 else runs.indexOfFirst { it.id == cursor } + 1
            val page = runs.drop(start).take(2)
            WorkflowRunHistory(page, page.last().id.takeIf { start + page.size < runs.size })
        }
        model.visibilityChanged(true)
        model.select(id, WorkflowTab.History)
        runCurrent()
        assertEquals(listOf(recentRun, earlierRun), model.state.value.history?.runs)

        val newRun =
            recentRun.copy(
                id = "0fdf0291-fad4-4896-a33e-c7931f51a086",
                createdAt = "2026-11-23T02:00:00.000Z",
            )
        runs.add(0, newRun)
        model.select(id)
        model.select(id, WorkflowTab.History)
        runCurrent()
        assertEquals(listOf(newRun, recentRun, earlierRun), model.state.value.history?.runs)

        val newestRun =
            newRun.copy(
                id = "c98de40b-6ac1-429d-989d-2b5be0b330f3",
                createdAt = "2026-11-23T03:00:00.000Z",
            )
        runs.add(0, newestRun)
        model.select(id)
        model.select(id, WorkflowTab.History)
        runCurrent()
        assertEquals(
            listOf(newestRun, newRun, recentRun, earlierRun),
            model.state.value.history?.runs,
        )
        assertEquals(listOf(null, null, recentRun.id, null, newRun.id), service.historyCursors)

        model.loadEarlierRuns()
        runCurrent()
        assertEquals(earlierRun.id, service.historyCursors.last())
        assertEquals(runs, model.state.value.history?.runs)
        assertNull(model.state.value.history?.nextCursor)
    }

    @Test
    fun revokedHistoryClearsTheCachedRange() = check { service, model ->
        val id = service.summary.id
        model.visibilityChanged(true)
        model.select(id, WorkflowTab.History)
        runCurrent()
        assertNotNull(model.state.value.history)
        service.historyRead = { _, _ -> throw ApiFailure.Http(404, null, null, null) }
        model.select(id)
        model.select(id, WorkflowTab.History)
        assertNotNull(model.state.value.history)
        runCurrent()
        assertNull(model.state.value.history)
        assertEquals(WorkflowReadFailure.Unavailable, model.state.value.historyFailure)
        model.select(id)
        model.select(id, WorkflowTab.History)
        assertNull(model.state.value.history)
    }

    @Test
    fun restoringWorkflowAccessReloadsTheSelectedHistory() = check { service, model ->
        val id = service.summary.id
        model.visibilityChanged(true)
        model.select(id, WorkflowTab.History)
        runCurrent()
        assertNotNull(model.state.value.history)

        service.catalogRead = { emptyList() }
        service.detailRead = { throw ApiFailure.Http(404, null, null, null) }
        model.foregroundChanged(false)
        model.foregroundChanged(true)
        runCurrent()
        assertEquals(WorkflowReadFailure.Unavailable, model.state.value.detailFailure)
        assertNull(model.state.value.history)

        val restored = CompletableDeferred<WorkflowDetail>()
        service.catalogRead = { listOf(service.summary) }
        service.detailRead = { restored.await() }
        model.foregroundChanged(false)
        val historyReads = service.historyCursors.size
        model.foregroundChanged(true)
        runCurrent()
        assertEquals(historyReads, service.historyCursors.size)

        restored.complete(service.detail)
        runCurrent()
        assertNull(model.state.value.detailFailure)
        assertNotNull(model.state.value.history)
        assertEquals(historyReads + 1, service.historyCursors.size)
    }

    @Test
    fun foregroundingResumesTheRequestedEarlierHistoryPage() = check { service, model ->
        var reachable = true
        service.historyRead = { _, cursor ->
            if (!reachable) throw ApiFailure.Network(IOException())
            if (cursor == null) WorkflowRunHistory(listOf(recentRun), "earlier")
            else WorkflowRunHistory(listOf(earlierRun), null)
        }
        model.visibilityChanged(true)
        model.select(service.summary.id, WorkflowTab.History)
        runCurrent()

        reachable = false
        model.loadEarlierRuns()
        runCurrent()
        assertNull(model.state.value.historyFailure)
        advanceTimeBy(6_000)
        runCurrent()
        assertTrue(model.state.value.historyFailure is WorkflowReadFailure.Failed)
        assertEquals(listOf(recentRun), model.state.value.history?.runs)

        reachable = true
        model.foregroundChanged(false)
        model.foregroundChanged(true)
        runCurrent()
        assertNull(model.state.value.historyFailure)
        assertEquals(
            listOf(null, "earlier", "earlier", "earlier", "earlier"),
            service.historyCursors,
        )
        assertEquals(listOf(recentRun, earlierRun), model.state.value.history?.runs)
    }
}
