package ai.okou.android.auth

import ai.okou.android.TestAuthentication
import ai.okou.android.TestChatComposerService
import ai.okou.android.TestChatService
import ai.okou.android.TestOkouApplication
import ai.okou.android.api.ApiFailure
import ai.okou.android.api.RequiredUpdate
import ai.okou.android.api.WorkspaceTokenProvider
import ai.okou.android.api.generated.AcceptedInput
import ai.okou.android.api.generated.PersonalInstructions
import ai.okou.android.api.generated.SendRequest
import ai.okou.android.api.generated.UpdatePreferencesRequest
import ai.okou.android.api.generated.UserPreferencesColorTheme
import ai.okou.android.api.generated.UserPreferencesTheme
import ai.okou.android.chat.ChatCacheStore
import ai.okou.android.chat.ChatComposerService
import ai.okou.android.chat.ChatListService
import ai.okou.android.chat.ComposerJournalStore
import ai.okou.android.chat.ProjectExpansionStore
import ai.okou.android.chat.RunControlJournalStore
import ai.okou.android.instructions.PersonalInstructionsDraftStore
import ai.okou.android.preferences.MemberAppearance
import ai.okou.android.preferences.MemberAppearanceCache
import ai.okou.android.testAuthenticationState
import ai.okou.android.testOrganization
import ai.okou.android.testPreferences
import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.async
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import kotlinx.coroutines.withContext
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = TestOkouApplication::class)
class SessionModelTest {
    @get:Rule val temporary = TemporaryFolder()

    private class Resource(val identity: WorkspaceIdentity, val tokens: WorkspaceTokenProvider) :
        WorkspaceSession,
        ai.okou.android.chat.AssistantRecoveryService by ai.okou.android
            .TestAssistantRecoveryService(),
        ai.okou.android.chat.RealtimeService by ai.okou.android.TestRealtimeService(),
        ChatListService by TestChatService(),
        ChatComposerService by TestChatComposerService() {
        var closed = false

        override suspend fun sendControl(request: SendRequest): AcceptedInput =
            error("No control backend in this fixture")

        var verifyOrganization = suspend { testOrganization(identity.workspaceId) }
        var loadPreferences = suspend { testPreferences() }
        var update: suspend () -> Unit = {}

        override suspend fun organization() = verifyOrganization()

        override suspend fun preferences() = loadPreferences()

        override suspend fun personalInstructions(): PersonalInstructions =
            error("Instructions are not enabled in this fixture")

        override suspend fun updatePersonalInstructions(
            content: String,
            ifVersion: String,
        ): PersonalInstructions = error("Instructions are not enabled in this fixture")

        override suspend fun updatePreferences(update: UpdatePreferencesRequest) =
            preferences().also { this.update() }

        override fun close() {
            closed = true
        }
    }

    private fun check(
        auth: TestAuthentication = TestAuthentication(),
        configure: (Resource) -> Unit = {},
        prepareAppearance: suspend MemberAppearanceCache.() -> Unit = {},
        block: suspend TestScope.(SessionModel, MutableList<Resource>) -> Unit,
    ) = runTest {
        val dispatcher = StandardTestDispatcher(testScheduler)
        Dispatchers.setMain(dispatcher)
        val store = ViewModelStore()
        val resources = mutableListOf<Resource>()
        val drafts =
            PersonalInstructionsDraftStore(
                ApplicationProvider.getApplicationContext(),
                temporary.newFolder(),
                dispatcher,
            )
        val cache =
            ChatCacheStore(
                ApplicationProvider.getApplicationContext(),
                temporary.newFolder(),
                dispatcher,
            )
        val journal =
            ComposerJournalStore(
                ApplicationProvider.getApplicationContext(),
                temporary.newFolder(),
                dispatcher,
            )
        val controls =
            RunControlJournalStore(
                ApplicationProvider.getApplicationContext(),
                temporary.newFolder(),
                dispatcher,
            )
        val appearanceDirectory = temporary.newFolder()
        val appearance = MemberAppearanceCache({ appearanceDirectory }, dispatcher)
        val expansionFile = temporary.newFolder().resolve("project-expansion.preferences_pb")
        val expansion =
            ProjectExpansionStore(
                PreferenceDataStoreFactory.create(scope = backgroundScope) { expansionFile }
            )
        try {
            appearance.prepareAppearance()
            val model =
                ViewModelProvider(
                    store,
                    viewModelFactory {
                        initializer {
                            SessionModel(
                                auth,
                                WorkspaceSessionFactory { identity, tokens ->
                                    Resource(identity, tokens).also {
                                        configure(it)
                                        resources += it
                                    }
                                },
                                "https://api.okou.ai/",
                                cache,
                                drafts,
                                journal,
                                controls,
                                appearance,
                                expansion,
                                dispatcher,
                            )
                        }
                    },
                )[SessionModel::class.java]
            block(model, resources)
        } finally {
            store.clear()
            cache.close()
            drafts.close()
            journal.close()
            controls.close()
            runCurrent()
            Dispatchers.resetMain()
        }
    }

    @Test
    fun pendingAuthenticationAndSignedOutNeverOpenWorkspaceResources() {
        val auth = TestAuthentication(AuthenticationState())
        check(auth) { model, resources ->
            runCurrent()
            assertEquals(SessionStage.Restoring, model.uiState.value.stage)
            assertTrue(resources.isEmpty())
            auth.state.value = AuthenticationState(initialized = true)
            runCurrent()
            assertEquals(SessionStage.SignIn, model.uiState.value.stage)
            assertTrue(resources.isEmpty())
        }
    }

    @Test
    fun organizationGatesAccessAndTokenRenewalKeepsThePresentationOwner() {
        val auth = TestAuthentication()
        val gate = CompletableDeferred<Unit>()
        check(
            auth,
            configure = { resource ->
                resource.verifyOrganization = {
                    gate.await()
                    testOrganization()
                }
            },
        ) { model, resources ->
            runCurrent()
            assertEquals(SessionStage.LoadingWorkspace, model.uiState.value.stage)
            assertTrue(model.uiState.value.opening is OpeningWorkspace.CheckingAccess)
            assertNull(model.uiState.value.ready)
            gate.complete(Unit)
            runCurrent()
            val ready = requireNotNull(model.uiState.value.ready)
            assertEquals("org-a", ready.identity.workspaceId)
            assertEquals("test-token", resources.single().tokens.token())
            auth.tokenAction = { "renewed-token" }
            assertEquals("renewed-token", resources.single().tokens.token())
            runCurrent()
            assertSame(ready, model.uiState.value.ready)
            assertFalse(resources.single().closed)
        }
    }

    @Test
    fun startupAppearanceIsScopedAndReplacedByTheConfirmedWorkspacePreferences() {
        val auth = TestAuthentication()
        val cached = MemberAppearance(UserPreferencesTheme.DARK, UserPreferencesColorTheme.DAYDREAM)
        val confirmed =
            MemberAppearance(UserPreferencesTheme.LIGHT, UserPreferencesColorTheme.BERRY_BLUSH)
        val previousSession = WorkspaceIdentity("https://api.okou.ai", "user-a", "old", "org-a")
        var preferences = CompletableDeferred<Unit>()
        lateinit var disk: MemberAppearanceCache
        check(
            auth,
            configure = { resource ->
                resource.loadPreferences = {
                    preferences.await()
                    testPreferences()
                        .copy(theme = confirmed.theme, colorTheme = confirmed.colorTheme)
                }
            },
            prepareAppearance = {
                disk = this
                save(previousSession, cached)
            },
        ) { model, _ ->
            runCurrent()
            assertEquals(SessionStage.LoadingWorkspace, model.uiState.value.stage)
            assertEquals(cached, model.uiState.value.cachedAppearance)
            assertNull(model.uiState.value.ready)

            preferences.complete(Unit)
            runCurrent()
            val ready = requireNotNull(model.uiState.value.ready)
            assertEquals(confirmed.theme, ready.preferences.uiState.value.theme)
            assertEquals(confirmed.colorTheme, ready.preferences.uiState.value.colorTheme)
            assertEquals(confirmed, disk.load(ready.identity))

            preferences = CompletableDeferred()
            model.chooseWorkspace("org-b", model.uiState.value.generation)
            runCurrent()
            assertEquals(SessionStage.LoadingWorkspace, model.uiState.value.stage)
            assertNull(model.uiState.value.cachedAppearance)

            auth.state.value = testAuthenticationState("user-b", "session-b", "org-a")
            runCurrent()
            assertEquals(SessionStage.LoadingWorkspace, model.uiState.value.stage)
            assertNull(model.uiState.value.cachedAppearance)
        }
    }

    @Test
    fun accountReplacementRejectsEvenNonCooperativeLatePreferences() {
        val old = CompletableDeferred<Unit>()
        val auth = TestAuthentication()
        check(
            auth,
            configure = { resource ->
                if (resource.identity.userId == "user-a")
                    resource.loadPreferences = {
                        withContext(NonCancellable) { old.await() }
                        testPreferences()
                    }
            },
        ) { model, resources ->
            runCurrent()
            assertTrue(model.uiState.value.opening is OpeningWorkspace.Authorized)
            auth.state.value = testAuthenticationState("user-b", "session-b", "org-b")
            runCurrent()
            assertTrue(resources.first().closed)
            assertEquals("user-b", requireNotNull(model.uiState.value.ready).identity.userId)
            old.complete(Unit)
            runCurrent()
            assertEquals("org-b", requireNotNull(model.uiState.value.ready).identity.workspaceId)
        }
    }

    @Test
    fun lateTokenCannotEscapeAReplacedWorkspaceAndOldListStateIsDiscarded() {
        val auth = TestAuthentication()
        val token = CompletableDeferred<String>()
        check(auth) { model, resources ->
            runCurrent()
            val original = requireNotNull(model.uiState.value.ready)
            original.chats.selectFilter(ai.okou.android.chat.ChatListFilter.Muted)
            auth.tokenAction = { withContext(NonCancellable) { token.await() } }
            val request = async { runCatching { resources.first().tokens.token() } }
            runCurrent()
            model.chooseWorkspace("not-a-membership", model.uiState.value.generation)
            assertSame(original, model.uiState.value.ready)
            model.chooseWorkspace("org-b", model.uiState.value.generation)
            runCurrent()
            assertTrue(resources.first().closed)
            val next = requireNotNull(model.uiState.value.ready)
            assertNotSame(original.chats, next.chats)
            assertEquals(ai.okou.android.chat.ChatListFilter.Inbox, next.chats.uiState.value.filter)
            token.complete("old-token")
            runCurrent()
            assertTrue(request.await().exceptionOrNull() is CancellationException)
        }
    }

    @Test
    fun additionalAuthenticationOrRevokedMembershipRetiresAccess() {
        val auth = TestAuthentication()
        check(auth) { model, resources ->
            runCurrent()
            auth.state.value = auth.state.value.copy(complete = false)
            runCurrent()
            assertEquals(SessionStage.SignIn, model.uiState.value.stage)
            assertNull(model.uiState.value.ready)
            assertTrue(resources.single().closed)
            auth.available = emptyList()
            auth.state.value = auth.state.value.copy(complete = true)
            runCurrent()
            assertEquals(SessionStage.ChooseWorkspace, model.uiState.value.stage)
            assertTrue(model.uiState.value.memberships.isEmpty())
            assertEquals(1, resources.size)
        }
    }

    @Test
    fun selectedWorkspaceBecomesReadyWhileFullMembershipListIsPending() {
        val auth =
            TestAuthentication(
                testAuthenticationState()
                    .copy(
                        membershipAccess =
                            listOf(MembershipAccess("org-a", "org:member", emptyList()))
                    )
            )
        val memberships = CompletableDeferred<List<WorkspaceMembership>>()
        auth.membershipsAction = { memberships.await() }
        check(auth) { model, _ ->
            runCurrent()
            assertEquals(SessionStage.Ready, model.uiState.value.stage)
            assertEquals(listOf("org-a"), model.uiState.value.memberships.map { it.id })
            memberships.complete(auth.available)
            runCurrent()
            assertEquals(listOf("org-a", "org-b"), model.uiState.value.memberships.map { it.id })
        }
    }

    @Test
    fun fallbackScopesCacheToRefreshedPermissionsWhenObservationLags() {
        val auth =
            TestAuthentication(
                testAuthenticationState()
                    .copy(
                        membershipAccess =
                            listOf(MembershipAccess("org-a", "org:member", listOf("old")))
                    )
            )
        auth.refreshedMembership = { MembershipAccess("org-a", "org:member", emptyList()) }
        check(auth) { model, resources ->
            runCurrent()
            assertEquals(SessionStage.Ready, model.uiState.value.stage)
            assertEquals(
                ai.okou.android.chat.chatScopeHash(listOf("org:member", "org:member", "known")),
                resources.single().identity.authorizationScope,
            )
            assertEquals(auth.available, model.uiState.value.memberships)
        }
    }

    @Test
    fun membershipRevocationWithoutAnIdentityChangeRechecksAndClosesAccess() {
        val auth =
            TestAuthentication(
                testAuthenticationState()
                    .copy(
                        membershipAccess =
                            listOf(MembershipAccess("org-a", "org:member", emptyList()))
                    )
            )
        check(auth) { model, resources ->
            runCurrent()
            assertEquals(SessionStage.Ready, model.uiState.value.stage)
            auth.available = emptyList()
            auth.state.value = auth.state.value.copy(membershipAccess = emptyList())
            runCurrent()
            assertTrue(resources.single().closed)
            assertEquals(SessionStage.ChooseWorkspace, model.uiState.value.stage)
            assertNull(model.uiState.value.ready)
        }
    }

    @Test
    fun oldRenderedActionsCannotSwitchOrSignOutAReplacementAccount() {
        val auth = TestAuthentication()
        check(auth) { model, resources ->
            runCurrent()
            val original = model.uiState.value
            auth.state.value = testAuthenticationState("user-b", "session-b", "org-b")
            original.ready?.preferences?.selectColorTheme(UserPreferencesColorTheme.COTTON_SKY)
            // SDK state may advance before the ViewModel or Compose consumes the new snapshot.
            model.chooseWorkspace("org-a", original.generation)
            model.signOut(original.generation)
            model.retry(original.generation)
            assertSame(original, model.uiState.value)
            runCurrent()
            val replacement = model.uiState.value
            assertEquals("user-b", requireNotNull(replacement.ready).identity.userId)
            model.chooseWorkspace("org-a", original.generation)
            model.signOut(original.generation)
            model.retry(original.generation)
            runCurrent()
            assertSame(replacement, model.uiState.value)
            assertFalse(resources.last().closed)
        }
    }

    @Test
    fun postBootstrapAuthorizationAndUpgradeErrorsRetireTheWorkspace() {
        for ((failure, stage) in
            listOf(
                ApiFailure.Unauthenticated() to SessionStage.AccessRemoved,
                ApiFailure.UpdateRequired(RequiredUpdate("0.3.0")) to SessionStage.UpdateRequired,
            )) {
            check(configure = { resource -> resource.update = { throw failure } }) {
                model,
                resources ->
                runCurrent()
                val ready = requireNotNull(model.uiState.value.ready)
                ready.preferences.selectColorTheme(UserPreferencesColorTheme.BLUE_HORIZON)
                runCurrent()
                assertEquals(stage, model.uiState.value.stage)
                assertNull(model.uiState.value.ready)
                assertTrue(resources.single().closed)
            }
        }
    }

    @Test
    fun failedOrganizationCheckCanRetryButSignOutRetiresBeforeTheProviderResponds() {
        val auth = TestAuthentication()
        val signOut = CompletableDeferred<Unit>()
        var fail = true
        check(
            auth,
            configure = { resource ->
                resource.verifyOrganization = {
                    if (fail) error("offline")
                    testOrganization(resource.identity.workspaceId)
                }
            },
        ) { model, resources ->
            runCurrent()
            assertEquals(SessionStage.Unavailable, model.uiState.value.stage)
            assertTrue(resources.first().closed)
            fail = false
            model.retry(model.uiState.value.generation)
            runCurrent()
            assertEquals(SessionStage.Ready, model.uiState.value.stage)
            auth.signOutAction = {
                signOut.await()
                auth.state.value = AuthenticationState(initialized = true)
            }
            model.signOut(model.uiState.value.generation)
            assertTrue(resources.last().closed)
            assertNull(model.uiState.value.ready)
            signOut.complete(Unit)
            runCurrent()
            assertEquals(SessionStage.SignIn, model.uiState.value.stage)
        }
    }
}
