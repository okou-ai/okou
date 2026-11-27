package ai.okou.android.connectors

import ai.okou.android.api.ApiClient
import ai.okou.android.api.ApiFailure
import ai.okou.android.api.generated.ChatConnectorAccess
import ai.okou.android.api.generated.ChatConnectorAccessAccountsItem
import ai.okou.android.api.generated.ChatConnectorAccessTargetVariant1
import ai.okou.android.api.generated.ChatConnectorOverrideRequest
import ai.okou.android.api.generated.ChatConnectorOverrideRequestTargetVariant1
import ai.okou.android.api.generated.ChatConnectorOverrideRequestTargetVariant1Kind
import ai.okou.android.api.generated.ConnectorAccountConnectionStatus
import ai.okou.android.api.generated.ConnectorAccountDefaultRequest
import ai.okou.android.api.generated.ConnectorAccountDefaultRequestTargetVariant1
import ai.okou.android.api.generated.ConnectorAccountDefaultRequestTargetVariant1Kind
import ai.okou.android.api.generated.ConnectorAccountDefaultsQueryVariant1
import ai.okou.android.api.generated.ConnectorAccountDefaultsQueryVariant1Kind
import ai.okou.android.api.generated.ConnectorAccountImpactQueryVariant1
import ai.okou.android.api.generated.ConnectorAccountImpactQueryVariant1Kind
import ai.okou.android.api.generated.ConnectorAccountInspectionRequest
import ai.okou.android.api.generated.ConnectorAccountInspectionRequestSelectionsItem
import ai.okou.android.api.generated.ConnectorAccountInspectionRequestSelectionsItemTargetVariant1
import ai.okou.android.api.generated.ConnectorAccountInspectionRequestSelectionsItemTargetVariant1Kind
import ai.okou.android.api.generated.ConnectorAccountInspectionResultsItemVariant1
import ai.okou.android.api.generated.ConnectorAccountInspectionResultsItemVariant1ConnectionStatus
import ai.okou.android.api.generated.ConnectorAccountInspectionResultsItemVariant1TargetVariant1
import ai.okou.android.api.generated.ConnectorAccountPoliciesQueryVariant1
import ai.okou.android.api.generated.ConnectorAccountPoliciesQueryVariant1Kind
import ai.okou.android.api.generated.ConnectorAccountPolicyRequest
import ai.okou.android.api.generated.ConnectorAccountPolicyRequestPolicy
import ai.okou.android.api.generated.ConnectorAccountPolicyRequestTargetVariant1
import ai.okou.android.api.generated.ConnectorAccountPolicyRequestTargetVariant1Kind
import ai.okou.android.api.generated.ConnectorAccountQueryVariant1
import ai.okou.android.api.generated.ConnectorAccountQueryVariant1Kind
import ai.okou.android.api.generated.ConnectorAccountRenameRequest
import ai.okou.android.api.generated.ConnectorAccountRenameRequestTargetVariant1
import ai.okou.android.api.generated.ConnectorAccountRenameRequestTargetVariant1Kind
import ai.okou.android.api.generated.ConnectorAccountTargetRequest
import ai.okou.android.api.generated.ConnectorAccountTargetRequestTargetVariant1
import ai.okou.android.api.generated.ConnectorAccountTargetRequestTargetVariant1Kind
import ai.okou.android.api.generated.ConnectorAccountTargetVariant1
import ai.okou.android.api.generated.ConnectorAccountsConnectionsItemConnectionStatus
import ai.okou.android.api.generated.ConnectorAccountsConnectionsItemTargetVariant1
import ai.okou.android.api.generated.ConnectorAccountsQueryVariant1
import ai.okou.android.api.generated.ConnectorAccountsQueryVariant1IncludeScopeMismatch
import ai.okou.android.api.generated.ConnectorAccountsQueryVariant1Kind
import ai.okou.android.api.generated.ConnectorAutomaticStartRequest
import ai.okou.android.api.generated.ConnectorAutomaticStartRequestAccountVariant1
import ai.okou.android.api.generated.ConnectorAutomaticStartRequestAccountVariant1Intent
import ai.okou.android.api.generated.ConnectorAutomaticStartRequestAccountVariant2
import ai.okou.android.api.generated.ConnectorAutomaticStartRequestAccountVariant2Intent
import ai.okou.android.api.generated.ConnectorAutomaticStartVariant1
import ai.okou.android.api.generated.ConnectorAutomaticStartVariant2
import ai.okou.android.api.generated.ConnectorDetailConnectorAuthMethodsItem
import ai.okou.android.api.generated.ConnectorDetailConnectorAuthMethodsItemGrantKind
import ai.okou.android.api.generated.ConnectorDevicePollRequest
import ai.okou.android.api.generated.ConnectorDevicePollVariant1
import ai.okou.android.api.generated.ConnectorDevicePollVariant2
import ai.okou.android.api.generated.ConnectorDevicePollVariant3
import ai.okou.android.api.generated.ConnectorDevicePollVariant4
import ai.okou.android.api.generated.ConnectorDevicePollVariant5
import ai.okou.android.api.generated.ConnectorDeviceStartRequest
import ai.okou.android.api.generated.ConnectorDeviceStartRequestAccountVariant1
import ai.okou.android.api.generated.ConnectorDeviceStartRequestAccountVariant1Intent
import ai.okou.android.api.generated.ConnectorDeviceStartRequestAccountVariant2
import ai.okou.android.api.generated.ConnectorDeviceStartRequestAccountVariant2Intent
import ai.okou.android.api.generated.ConnectorDiscoveryConnectorsItem
import ai.okou.android.api.generated.ConnectorExternalCompleteRequest
import ai.okou.android.api.generated.ConnectorExternalStartRequest
import ai.okou.android.api.generated.ConnectorExternalStartRequestAccountVariant1
import ai.okou.android.api.generated.ConnectorExternalStartRequestAccountVariant1Intent
import ai.okou.android.api.generated.ConnectorExternalStartRequestAccountVariant2
import ai.okou.android.api.generated.ConnectorExternalStartRequestAccountVariant2Intent
import ai.okou.android.api.generated.ConnectorManualRequest
import ai.okou.android.api.generated.ConnectorManualRequestAccountVariant1
import ai.okou.android.api.generated.ConnectorManualRequestAccountVariant1Intent
import ai.okou.android.api.generated.ConnectorManualRequestAccountVariant2
import ai.okou.android.api.generated.ConnectorManualRequestAccountVariant2Intent
import ai.okou.android.api.generated.ConnectorNoAuthRequest
import ai.okou.android.api.generated.ConnectorNoAuthRequestAccountVariant1
import ai.okou.android.api.generated.ConnectorNoAuthRequestAccountVariant1Intent
import ai.okou.android.api.generated.ConnectorNoAuthRequestAccountVariant2
import ai.okou.android.api.generated.ConnectorNoAuthRequestAccountVariant2Intent
import ai.okou.android.api.generated.ConnectorOauthCompletionQueryVariant1
import ai.okou.android.api.generated.ConnectorOauthCompletionQueryVariant1Kind
import ai.okou.android.api.generated.ConnectorOauthStartRequest
import ai.okou.android.api.generated.ConnectorOauthStartRequestAccountVariant1
import ai.okou.android.api.generated.ConnectorOauthStartRequestAccountVariant1Intent
import ai.okou.android.api.generated.ConnectorOauthStartRequestAccountVariant2
import ai.okou.android.api.generated.ConnectorOauthStartRequestAccountVariant2Intent
import ai.okou.android.api.generated.ConnectorOpenIdStartRequest
import ai.okou.android.api.generated.ConnectorOpenIdStartRequestAccountVariant1
import ai.okou.android.api.generated.ConnectorOpenIdStartRequestAccountVariant1Intent
import ai.okou.android.api.generated.ConnectorOpenIdStartRequestAccountVariant2
import ai.okou.android.api.generated.ConnectorOpenIdStartRequestAccountVariant2Intent
import ai.okou.android.api.generated.ConnectorOverviewItem
import ai.okou.android.api.generated.ConnectorOverviewItemTargetVariant1
import ai.okou.android.api.generated.connectorAccount
import ai.okou.android.api.generated.connectorAccountDefaults
import ai.okou.android.api.generated.connectorAccountImpact
import ai.okou.android.api.generated.connectorAccountPolicies
import ai.okou.android.api.generated.connectorAccounts
import ai.okou.android.api.generated.connectorOauthCompletion
import kotlin.time.Duration
import kotlin.time.Duration.Companion.seconds
import kotlin.time.Instant
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

internal data class ConnectorEntry(
    val slug: String,
    val name: String,
    val description: String,
    val category: String?,
    val rank: Long?,
    val icon: ConnectorBrandIcon?,
)

internal data class ConnectorBrandIcon(
    val url: HttpUrl,
    val invertInDarkMode: Boolean,
    val scale: Float,
)

internal enum class ConnectorAccountStatus {
    Connected,
    Reauthorize,
    UpdatePermissions,
    Unknown,
}

internal data class ConnectorSavedAccount(
    val id: String,
    val authMethod: String,
    val displayName: String?,
    val identity: String?,
    val status: ConnectorAccountStatus,
    val defaultEnabled: Boolean?,
    val policy: ConnectorMemberPolicy? = null,
)

internal data class ConnectorMemberPolicy(
    val allowed: Boolean,
    val enabled: Boolean,
    val expiresAt: Instant?,
)

internal data class ConnectedService(
    val entry: ConnectorEntry,
    val accounts: List<ConnectorSavedAccount>,
)

internal data class ConnectorBrowse(val entries: List<ConnectorEntry>, val categories: Set<String>)

internal data class ConnectorServiceDetail(
    val entry: ConnectorEntry,
    val methods: List<ConnectorDetailConnectorAuthMethodsItem>,
    val googleSecurityWarning: Boolean,
    val hasPermissions: Boolean,
)

internal data class ConnectorPermission(val name: String, val description: String?)

internal data class ConnectorAccountTarget(val slug: String, val connectionId: String?)

internal sealed interface ConnectorAuthorization {
    data class Receipt(val connectionId: String, val externalCodeSessionId: String? = null) :
        ConnectorAuthorization

    data class Browser(val url: HttpUrl, val attemptId: String) : ConnectorAuthorization

    data class Device(
        val url: HttpUrl,
        val code: String,
        val sessionId: String,
        val sessionToken: String,
        val expiresIn: Duration,
        val interval: Duration,
    ) : ConnectorAuthorization

    data class DeviceVerification(val attempt: Device) : ConnectorAuthorization

    data class External(
        val url: HttpUrl,
        val sessionId: String,
        val sessionToken: String,
        val expiresIn: Duration,
    ) : ConnectorAuthorization
}

internal sealed interface ConnectorDeviceResult {
    data class Waiting(val interval: Duration) : ConnectorDeviceResult

    data class Complete(val connectionId: String) : ConnectorDeviceResult

    enum class Terminal : ConnectorDeviceResult {
        Denied,
        Expired,
        Failed,
    }
}

class ConnectorService(private val api: ApiClient) {
    internal suspend fun memberAccessEnabled(): Boolean =
        api.featureSwitches().effectiveSwitches["memberConnectorAccountAccess"] == true

    internal suspend fun discover(keyword: String?, category: String?): ConnectorBrowse {
        val response = api.read { connectorDiscovery(it, keyword, category) }
        return ConnectorBrowse(
            response.connectors.map(ConnectorDiscoveryConnectorsItem::entry),
            response.categoryConnectorCounts?.keys
                ?: response.connectors.map { it.category }.toSet(),
        )
    }

    internal suspend fun connected(): Map<String, ConnectedService> =
        api.read { connectorOverview(it) }
            .mapNotNull { entry ->
                val target = entry.target as? ConnectorOverviewItemTargetVariant1
                if (target == null || entry.accounts.isEmpty()) return@mapNotNull null
                target.connectorSlug to
                    ConnectedService(
                        entry.directoryEntry(target.connectorSlug),
                        entry.accounts.map { account ->
                            ConnectorSavedAccount(
                                account.connectionId,
                                account.authMethod,
                                account.displayName,
                                identity(
                                    account.externalEmail,
                                    account.externalUsername,
                                    account.externalId,
                                ),
                                ConnectorAccountStatus.Unknown,
                                account.defaultEnabled,
                            )
                        },
                    )
            }
            .toMap()

    internal suspend fun chatOverview(threadId: String?): List<ChatConnectorSummary> =
        api.read { connectorOverview(it, threadId) }
            .mapNotNull { entry ->
                val target = entry.target as? ConnectorOverviewItemTargetVariant1
                if (target == null || entry.accounts.isEmpty()) null
                else
                    ChatConnectorSummary(entry.directoryEntry(target.connectorSlug), entry.accounts)
            }

    internal suspend fun chatAccounts(
        summary: ChatConnectorSummary,
        cachedMemberAccess: Boolean? = null,
    ): ChatConnectorAccounts = coroutineScope {
        val memberAccess = async { cachedMemberAccess ?: memberAccessEnabled() }
        val byId = summary.accounts.associateBy { it.connectionId }
        val accounts = accounts(summary.entry.slug, byId.mapValues { it.value.defaultEnabled })
        val usePolicy = memberAccess.await()
        ChatConnectorAccounts(
            accounts.mapNotNull { account ->
                byId[account.id]?.let { ChatConnectorAccount(account, it.overrideEnabled) }
            },
            usePolicy,
        )
    }

    internal suspend fun setChatOverride(
        threadId: String,
        choice: ChatConnectorOverride,
    ): List<ChatConnectorAccessAccountsItem> =
        api.write {
                chatConnectorOverride(
                    it,
                    threadId,
                    choice.connectionId,
                    ChatConnectorOverrideRequest(
                        ChatConnectorOverrideRequestTargetVariant1(
                            ChatConnectorOverrideRequestTargetVariant1Kind.BUILTIN,
                            choice.slug,
                        ),
                        choice.enabled,
                    ),
                )
            }
            .accountsFor(choice.slug)
            .also { if (!it.confirms(choice)) throw ApiFailure.IncompatibleResponse() }

    internal suspend fun inspect(
        connected: Map<String, ConnectedService>,
    ): Map<String, ConnectorAccountStatus> {
        val selections = connected.flatMap { (slug, service) ->
            service.accounts.map { account ->
                ConnectorAccountInspectionRequestSelectionsItem(
                    account.id,
                    ConnectorAccountInspectionRequestSelectionsItemTargetVariant1(
                        ConnectorAccountInspectionRequestSelectionsItemTargetVariant1Kind.BUILTIN,
                        slug,
                    ),
                )
            }
        }
        val slugs = selections.associate { selection ->
            selection.connectionId to
                (selection.target as ConnectorAccountInspectionRequestSelectionsItemTargetVariant1)
                    .connectorSlug
        }
        return buildMap {
            for (batch in selections.chunked(256)) {
                val response = api.read {
                    connectorAccountInspect(it, ConnectorAccountInspectionRequest(batch))
                }
                for (item in
                    response.results.filterIsInstance<
                        ConnectorAccountInspectionResultsItemVariant1,
                    >()) {
                    val target =
                        item.target as? ConnectorAccountInspectionResultsItemVariant1TargetVariant1
                    if (target?.connectorSlug != slugs[item.connectionId] || target == null)
                        continue
                    put(
                        item.connectionId,
                        status(
                            item.connectionStatus ==
                                ConnectorAccountInspectionResultsItemVariant1ConnectionStatus
                                    .RECONNECT_REQUIRED,
                            false,
                        ),
                    )
                }
            }
        }
    }

    internal suspend fun detail(slug: String): ConnectorServiceDetail {
        val connector = api.read { connectorDetail(it, slug) }.connector
        if (connector.slug != slug) throw ApiFailure.IncompatibleResponse()
        return ConnectorServiceDetail(
            ConnectorEntry(
                slug,
                connector.label,
                connector.description,
                connector.category,
                connector.popularityRank,
                brandIcon(
                    connector.icon.url,
                    connector.icon.invertInDarkMode,
                    connector.icon.scale,
                ),
            ),
            connector.authMethods.filter {
                it.grantKind != ConnectorDetailConnectorAuthMethodsItemGrantKind.MANAGED
            },
            connector.connectNotice != null,
            connector.permissionSummary.hasPermissions,
        )
    }

    internal suspend fun permissions(slug: String): List<ConnectorPermission> {
        val result = api.read { connectorPermissions(it, slug) }.permissions
        if (result.connectorSlug != slug) throw ApiFailure.IncompatibleResponse()
        return result.permissions.map { ConnectorPermission(it.name, it.description) }
    }

    internal suspend fun accounts(slug: String): List<ConnectorSavedAccount> {
        if (memberAccessEnabled()) {
            return accounts(slug, emptyMap(), accountPolicies(slug))
        }
        val defaults =
            api.read {
                    connectorAccountDefaults(
                        it,
                        ConnectorAccountDefaultsQueryVariant1(
                            ConnectorAccountDefaultsQueryVariant1Kind.BUILTIN,
                            slug,
                        ),
                    )
                }
                .associate { it.connectionId to it.defaultEnabled }
        return accounts(slug, defaults)
    }

    private suspend fun accounts(
        slug: String,
        defaults: Map<String, Boolean>,
        policies: Map<String, ConnectorMemberPolicy> = emptyMap(),
    ): List<ConnectorSavedAccount> {
        return buildList {
            var cursor: String? = null
            val visited = mutableSetOf<String>()
            do {
                val page = api.read {
                    connectorAccounts(
                        it,
                        ConnectorAccountsQueryVariant1(
                            ConnectorAccountsQueryVariant1Kind.BUILTIN,
                            slug,
                            ConnectorAccountsQueryVariant1IncludeScopeMismatch.TRUE,
                            cursor,
                            limit = 100,
                        ),
                    )
                }
                for (account in page.connections) {
                    val target = account.target as? ConnectorAccountsConnectionsItemTargetVariant1
                    if (target?.connectorSlug != slug) throw ApiFailure.IncompatibleResponse()
                    add(
                        ConnectorSavedAccount(
                            account.id,
                            account.authMethod,
                            account.displayName,
                            identity(
                                account.externalEmail,
                                account.externalUsername,
                                account.externalId,
                            ),
                            status(
                                account.connectionStatus ==
                                    ConnectorAccountsConnectionsItemConnectionStatus
                                        .RECONNECT_REQUIRED,
                                account.scopeMismatch == true,
                            ),
                            defaults[account.id],
                            policy = policies[account.id],
                        ),
                    )
                }
                cursor = page.nextCursor
                if (cursor != null && !visited.add(cursor)) throw ApiFailure.IncompatibleResponse()
            } while (cursor != null)
        }
    }

    internal suspend fun accountPolicies(slug: String): Map<String, ConnectorMemberPolicy> =
        api.read {
                connectorAccountPolicies(
                    it,
                    ConnectorAccountPoliciesQueryVariant1(
                        ConnectorAccountPoliciesQueryVariant1Kind.BUILTIN,
                        slug,
                    ),
                )
            }
            .associate { it.connectionId to memberPolicy(it.allowed, it.enabled, it.expiresAt) }

    internal suspend fun setAccountPolicy(
        slug: String,
        id: String,
        choice: ConnectorAccountPolicyRequestPolicy,
    ): ConnectorMemberPolicy {
        val result = api.write {
            connectorAccountPolicyUpdate(
                it,
                id,
                ConnectorAccountPolicyRequest(
                    ConnectorAccountPolicyRequestTargetVariant1(
                        ConnectorAccountPolicyRequestTargetVariant1Kind.BUILTIN,
                        slug,
                    ),
                    choice,
                ),
            )
        }
        if (result.connectionId != id) throw ApiFailure.IncompatibleResponse()
        return memberPolicy(result.allowed, result.enabled, result.expiresAt)
    }

    internal suspend fun accountIsConnected(slug: String, id: String): Boolean {
        val account = api.read {
            connectorAccount(
                it,
                id,
                ConnectorAccountQueryVariant1(ConnectorAccountQueryVariant1Kind.BUILTIN, slug),
            )
        }
        if (
            (account.target as? ConnectorAccountTargetVariant1)?.connectorSlug != slug ||
                account.id != id
        ) {
            throw ApiFailure.IncompatibleResponse()
        }
        return account.connectionStatus == ConnectorAccountConnectionStatus.CONNECTED
    }

    internal suspend fun impact(slug: String, id: String): Long {
        val response = api.read {
            connectorAccountImpact(
                it,
                id,
                ConnectorAccountImpactQueryVariant1(
                    ConnectorAccountImpactQueryVariant1Kind.BUILTIN,
                    slug,
                ),
            )
        }
        if (response.connectionId != id) throw ApiFailure.IncompatibleResponse()
        return response.explicitSelectionCount
    }

    internal suspend fun rename(slug: String, id: String, label: String): String? {
        val result = api.write {
            connectorAccountRename(
                it,
                id,
                ConnectorAccountRenameRequest(
                    ConnectorAccountRenameRequestTargetVariant1(
                        ConnectorAccountRenameRequestTargetVariant1Kind.BUILTIN,
                        slug,
                    ),
                    label,
                ),
            )
        }
        if (
            (result.target as? ConnectorAccountTargetVariant1)?.connectorSlug != slug ||
                result.id != id
        ) {
            throw ApiFailure.IncompatibleResponse()
        }
        return result.displayName
    }

    internal suspend fun setDefaultEnabled(slug: String, id: String, enabled: Boolean): Boolean {
        val result = api.write {
            connectorAccountDefaultUpdate(
                it,
                id,
                ConnectorAccountDefaultRequest(
                    ConnectorAccountDefaultRequestTargetVariant1(
                        ConnectorAccountDefaultRequestTargetVariant1Kind.BUILTIN,
                        slug,
                    ),
                    enabled,
                ),
            )
        }
        if (result.connectionId != id) throw ApiFailure.IncompatibleResponse()
        return result.defaultEnabled
    }

    internal suspend fun disconnect(slug: String, id: String) {
        val result = api.write {
            connectorAccountDelete(
                it,
                id,
                ConnectorAccountTargetRequest(
                    ConnectorAccountTargetRequestTargetVariant1(
                        ConnectorAccountTargetRequestTargetVariant1Kind.BUILTIN,
                        slug,
                    ),
                ),
            )
        }
        if (result.deletedConnectionId != id) throw ApiFailure.IncompatibleResponse()
    }

    internal suspend fun start(
        target: ConnectorAccountTarget,
        method: ConnectorDetailConnectorAuthMethodsItem,
        values: Map<String, String>,
    ): ConnectorAuthorization {
        val (slug, id) = target
        return when (method.grantKind) {
            ConnectorDetailConnectorAuthMethodsItemGrantKind.AUTH_CODE -> {
                val account =
                    if (id == null)
                        ConnectorOauthStartRequestAccountVariant1(
                            ConnectorOauthStartRequestAccountVariant1Intent.ADD,
                        )
                    else
                        ConnectorOauthStartRequestAccountVariant2(
                            ConnectorOauthStartRequestAccountVariant2Intent.RECONNECT,
                            id,
                        )
                val response = api.write {
                    connectorOauthStart(
                        it,
                        slug,
                        ConnectorOauthStartRequest(method.id, account = account),
                    )
                }
                ConnectorAuthorization.Browser(
                    authorizationUrl(response.authorizationUrl),
                    response.oauthAttemptId,
                )
            }
            ConnectorDetailConnectorAuthMethodsItemGrantKind.OPENID_AUTH -> {
                val account =
                    if (id == null)
                        ConnectorOpenIdStartRequestAccountVariant1(
                            ConnectorOpenIdStartRequestAccountVariant1Intent.ADD,
                        )
                    else
                        ConnectorOpenIdStartRequestAccountVariant2(
                            ConnectorOpenIdStartRequestAccountVariant2Intent.RECONNECT,
                            id,
                        )
                val response = api.write {
                    connectorOpenIdStart(
                        it,
                        slug,
                        ConnectorOpenIdStartRequest(method.id, account),
                    )
                }
                ConnectorAuthorization.Browser(
                    authorizationUrl(response.authorizationUrl),
                    response.oauthAttemptId,
                )
            }
            ConnectorDetailConnectorAuthMethodsItemGrantKind.AUTOMATIC -> {
                val account =
                    if (id == null)
                        ConnectorAutomaticStartRequestAccountVariant1(
                            ConnectorAutomaticStartRequestAccountVariant1Intent.ADD,
                        )
                    else
                        ConnectorAutomaticStartRequestAccountVariant2(
                            ConnectorAutomaticStartRequestAccountVariant2Intent.RECONNECT,
                            id,
                        )
                val response = api.write {
                    connectorAutomaticStart(
                        it,
                        slug,
                        ConnectorAutomaticStartRequest(method.id, account),
                    )
                }
                when (response) {
                    is ConnectorAutomaticStartVariant1 ->
                        ConnectorAuthorization.Receipt(response.connectionId)
                    is ConnectorAutomaticStartVariant2 ->
                        ConnectorAuthorization.Browser(
                            authorizationUrl(response.authorizationUrl),
                            response.oauthAttemptId,
                        )
                }
            }
            ConnectorDetailConnectorAuthMethodsItemGrantKind.NONE -> {
                val account =
                    if (id == null)
                        ConnectorNoAuthRequestAccountVariant1(
                            ConnectorNoAuthRequestAccountVariant1Intent.ADD,
                        )
                    else
                        ConnectorNoAuthRequestAccountVariant2(
                            ConnectorNoAuthRequestAccountVariant2Intent.RECONNECT,
                            id,
                        )
                val response = api.write {
                    connectorNoAuth(it, slug, ConnectorNoAuthRequest(method.id, account))
                }
                ConnectorAuthorization.Receipt(response.connectionId)
            }
            ConnectorDetailConnectorAuthMethodsItemGrantKind.MANUAL -> {
                val account =
                    if (id == null)
                        ConnectorManualRequestAccountVariant1(
                            ConnectorManualRequestAccountVariant1Intent.ADD,
                        )
                    else
                        ConnectorManualRequestAccountVariant2(
                            ConnectorManualRequestAccountVariant2Intent.RECONNECT,
                            id,
                        )
                val response = api.write {
                    connectorManual(
                        it,
                        slug,
                        ConnectorManualRequest(method.id, account, values),
                    )
                }
                ConnectorAuthorization.Receipt(response.connectionId)
            }
            ConnectorDetailConnectorAuthMethodsItemGrantKind.DEVICE_AUTH -> {
                val account =
                    if (id == null)
                        ConnectorDeviceStartRequestAccountVariant1(
                            ConnectorDeviceStartRequestAccountVariant1Intent.ADD,
                        )
                    else
                        ConnectorDeviceStartRequestAccountVariant2(
                            ConnectorDeviceStartRequestAccountVariant2Intent.RECONNECT,
                            id,
                        )
                val response = api.write {
                    connectorDeviceStart(
                        it,
                        slug,
                        ConnectorDeviceStartRequest(method.id, account, values),
                    )
                }
                if (response.connectorSlug != slug) throw ApiFailure.IncompatibleResponse()
                ConnectorAuthorization.Device(
                    authorizationUrl(response.verificationUriComplete ?: response.verificationUri),
                    response.userCode,
                    response.sessionId,
                    response.sessionToken,
                    response.expiresIn.seconds,
                    response.interval.seconds,
                )
            }
            ConnectorDetailConnectorAuthMethodsItemGrantKind.EXTERNAL_CODE -> {
                val account =
                    if (id == null)
                        ConnectorExternalStartRequestAccountVariant1(
                            ConnectorExternalStartRequestAccountVariant1Intent.ADD,
                        )
                    else
                        ConnectorExternalStartRequestAccountVariant2(
                            ConnectorExternalStartRequestAccountVariant2Intent.RECONNECT,
                            id,
                        )
                val response = api.write {
                    connectorExternalStart(
                        it,
                        slug,
                        ConnectorExternalStartRequest(method.id, account),
                    )
                }
                if (response.connectorSlug != slug) throw ApiFailure.IncompatibleResponse()
                ConnectorAuthorization.External(
                    authorizationUrl(response.authorizationUrl),
                    response.sessionId,
                    response.sessionToken,
                    response.expiresIn.seconds,
                )
            }
            ConnectorDetailConnectorAuthMethodsItemGrantKind.MANAGED ->
                error("Managed grants have no start action")
        }
    }

    internal suspend fun oauthCompletion(slug: String, attemptId: String): String? =
        try {
            api.read {
                    connectorOauthCompletion(
                        it,
                        attemptId,
                        ConnectorOauthCompletionQueryVariant1(
                            ConnectorOauthCompletionQueryVariant1Kind.BUILTIN,
                            slug,
                        ),
                    )
                }
                .connectionId
        } catch (error: ApiFailure.Http) {
            if (error.status == 404) null else throw error
        }

    internal suspend fun pollDevice(
        slug: String,
        step: ConnectorAuthorization.Device,
    ): ConnectorDeviceResult =
        when (
            val result = api.write {
                connectorDevicePoll(
                    it,
                    slug,
                    step.sessionId,
                    ConnectorDevicePollRequest(step.sessionToken),
                )
            }
        ) {
            is ConnectorDevicePollVariant1 -> ConnectorDeviceResult.Waiting(result.interval.seconds)
            is ConnectorDevicePollVariant2 -> ConnectorDeviceResult.Complete(result.connectionId)
            is ConnectorDevicePollVariant3 -> ConnectorDeviceResult.Terminal.Denied
            is ConnectorDevicePollVariant4 -> ConnectorDeviceResult.Terminal.Expired
            is ConnectorDevicePollVariant5 -> ConnectorDeviceResult.Terminal.Failed
        }

    internal suspend fun completeExternal(
        slug: String,
        step: ConnectorAuthorization.External,
        code: String,
    ): String =
        api.write {
                connectorExternalComplete(
                    it,
                    slug,
                    step.sessionId,
                    ConnectorExternalCompleteRequest(step.sessionToken, code),
                )
            }
            .connectionId
}

private fun ChatConnectorAccess.accountsFor(slug: String): List<ChatConnectorAccessAccountsItem> {
    if (
        (target as? ChatConnectorAccessTargetVariant1)?.connectorSlug != slug ||
            accounts.distinctBy { it.connectionId }.size != accounts.size
    )
        throw ApiFailure.IncompatibleResponse()
    return accounts
}

private fun memberPolicy(
    allowed: Boolean,
    enabled: Boolean,
    expiresAt: String?,
): ConnectorMemberPolicy =
    try {
        ConnectorMemberPolicy(allowed, enabled, expiresAt?.let(Instant::parse))
    } catch (_: IllegalArgumentException) {
        throw ApiFailure.IncompatibleResponse()
    }

private fun List<ChatConnectorAccessAccountsItem>.confirms(choice: ChatConnectorOverride) =
    firstOrNull { it.connectionId == choice.connectionId }?.overrideEnabled == choice.enabled

private fun ConnectorOverviewItem.directoryEntry(slug: String) =
    ConnectorEntry(
        slug,
        label,
        "",
        null,
        null,
        icon?.let { brandIcon(it.url, it.invertInDarkMode, it.scale) },
    )

private fun ConnectorDiscoveryConnectorsItem.entry() =
    ConnectorEntry(
        slug,
        label,
        description,
        category,
        popularityRank,
        brandIcon(icon.url, icon.invertInDarkMode, icon.scale),
    )

private fun brandIcon(url: String, invertInDarkMode: Boolean, scale: Double?): ConnectorBrandIcon? =
    url.toHttpUrlOrNull()
        ?.takeIf { it.isHttps && it.username.isEmpty() && it.password.isEmpty() }
        ?.let { ConnectorBrandIcon(it, invertInDarkMode, scale?.toFloat() ?: 1f) }

private fun identity(vararg values: String?): String? = values.firstOrNull { !it.isNullOrBlank() }

private fun status(reconnect: Boolean, scopeMismatch: Boolean) =
    when {
        reconnect -> ConnectorAccountStatus.Reauthorize
        scopeMismatch -> ConnectorAccountStatus.UpdatePermissions
        else -> ConnectorAccountStatus.Connected
    }

internal fun authorizationUrl(value: String): HttpUrl =
    value.toHttpUrlOrNull()?.takeIf { it.isHttps && it.username.isEmpty() && it.password.isEmpty() }
        ?: throw ApiFailure.IncompatibleResponse()
