package expo.modules.callkittelecom.telecom

import android.Manifest
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.telecom.Connection
import android.telecom.ConnectionRequest
import android.telecom.DisconnectCause
import android.telecom.PhoneAccount
import android.telecom.PhoneAccountHandle
import android.telecom.TelecomManager
import androidx.core.content.ContextCompat
import expo.modules.callkittelecom.errors.MissingCallPermissionsException
import expo.modules.callkittelecom.events.CallEventEmitter
import expo.modules.callkittelecom.events.CallEvents
import expo.modules.callkittelecom.managers.CallAudioManager
import expo.modules.callkittelecom.managers.DialtonePlayer
import expo.modules.callkittelecom.managers.FulfillRequestManager
import expo.modules.callkittelecom.models.CallEndedReason
import expo.modules.callkittelecom.models.CallOptions
import expo.modules.callkittelecom.models.CallParticipant
import expo.modules.callkittelecom.models.CallSession
import expo.modules.callkittelecom.models.CallSessionOrigin
import expo.modules.callkittelecom.models.CallSessionStatus
import expo.modules.callkittelecom.models.IncomingCallEvent
import expo.modules.callkittelecom.services.ExpoCallKitTelecomHeadlessService
import expo.modules.callkittelecom.services.CallMicrophoneService
import expo.modules.callkittelecom.store.CallStore
import expo.modules.callkittelecom.utils.CallKitTelecomLog
import java.time.Instant
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/**
 * Android call manager for a system-managed [android.telecom.ConnectionService].
 *
 * The registered PhoneAccount supplies calls while the user's default Phone app supplies the
 * InCallService UI. SIP/media remain in JavaScript for the migration-parity implementation.
 */
class ManagedCallManager private constructor() {
    companion object {
        private const val TAG = "ExpoCallKitTelecom.Managed"
        private const val PHONE_ACCOUNT_ID = "expo-callkit-telecom-managed"
        internal const val EXTRA_CALL_ID = "expo.modules.callkittelecom.extra.CALL_ID"

        val shared = ManagedCallManager()
    }

    private lateinit var context: Context
    private lateinit var telecomManager: TelecomManager
    private lateinit var accountHandle: PhoneAccountHandle
    private var initialized = false
    private var fulfillAnswerTimeoutMs = 30_000L
    private val connections = ConcurrentHashMap<UUID, ManagedCallConnection>()

    @Synchronized
    fun initialize(appContext: Context) {
        if (initialized) return

        context = appContext.applicationContext
        telecomManager = context.getSystemService(Context.TELECOM_SERVICE) as TelecomManager
        accountHandle =
            PhoneAccountHandle(
                ComponentName(context, ManagedConnectionService::class.java),
                PHONE_ACCOUNT_ID,
            )

        CallEventEmitter.setQueueLimit(CallEvents.CALL_INTENT_RECEIVED, 1)
        CallEventEmitter.setQueueLimit(CallEvents.AUDIO_SESSION_ACTIVATED, 1)
        CallEventEmitter.setQueueLimit(CallEvents.AUDIO_SESSION_DEACTIVATED, 1)
        CallEventEmitter.setQueueLimit(CallEvents.INCOMING_CALL_REPORTED, 1)
        CallEventEmitter.setQueueLimit(CallEvents.CALL_ANSWERED, 1)
        CallEventEmitter.setQueueLimit(CallEvents.VOIP_PUSH_TOKEN_UPDATED, 1)
        CallEventEmitter.setBroadcastContext(context)

        CallAudioManager.initialize(context)
        DialtonePlayer.initialize(context)
        fulfillAnswerTimeoutMs = readTimeoutMs("ExpoCallKitTelecomFulfillAnswerCallTimeout", 30_000L)
        registerPhoneAccount()
        initialized = true
        CallKitTelecomLog.d(TAG) { "Initialized system-managed Telecom provider" }
    }

    private fun ensureInitialized() {
        check(initialized) { "ManagedCallManager has not been initialized" }
    }

    private fun readTimeoutMs(key: String, defaultMs: Long): Long =
        try {
            val appInfo =
                context.packageManager.getApplicationInfo(
                    context.packageName,
                    android.content.pm.PackageManager.GET_META_DATA,
                )
            val seconds = appInfo.metaData?.getInt(key, (defaultMs / 1000).toInt())
            (seconds ?: (defaultMs / 1000).toInt()).toLong() * 1000
        } catch (_: Throwable) {
            defaultMs
        }

    fun registerPhoneAccount() {
        ensureManagerFields()
        val applicationInfo = context.applicationInfo
        val label = context.packageManager.getApplicationLabel(applicationInfo)
        val account =
            PhoneAccount.builder(accountHandle, label)
                .setCapabilities(PhoneAccount.CAPABILITY_CALL_PROVIDER)
                .setSupportedUriSchemes(listOf(PhoneAccount.SCHEME_TEL, PhoneAccount.SCHEME_SIP))
                .setShortDescription(label)
                .build()
        telecomManager.registerPhoneAccount(account)
    }

    fun isPhoneAccountEnabled(): Boolean {
        ensureInitialized()
        return telecomManager.getPhoneAccount(accountHandle)?.isEnabled == true
    }

    fun openPhoneAccountSettings() {
        ensureInitialized()
        val intent = Intent(TelecomManager.ACTION_CHANGE_PHONE_ACCOUNTS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(intent)
    }

    private fun ensureManagerFields() {
        check(::context.isInitialized && ::telecomManager.isInitialized && ::accountHandle.isInitialized)
    }

    fun startOutgoingCall(
        recipient: CallParticipant,
        options: CallOptions,
    ): String {
        ensureInitialized()
        require(!options.hasVideo) { "Managed migration mode supports audio calls only" }
        check(isPhoneAccountEnabled()) { "The Evercall phone account is not enabled" }

        val id = UUID.randomUUID()
        CallStore.add(newOutgoingSession(id, recipient))
        CallAudioManager.prepareAudioSessionForCall(false)

        val outgoingExtras = Bundle().apply { putString(EXTRA_CALL_ID, id.toString()) }
        val telecomExtras =
            Bundle().apply {
                putParcelable(TelecomManager.EXTRA_PHONE_ACCOUNT_HANDLE, accountHandle)
                putBundle(TelecomManager.EXTRA_OUTGOING_CALL_EXTRAS, outgoingExtras)
            }

        try {
            // Request the service while the Activity is visible, without changing the
            // existing Telecom/headless/JS startup sequence or module execution queue.
            CallMicrophoneService.start(context, id) { ready ->
                if (!ready) reportCallEnded(id, CallEndedReason.FAILED)
            }
            ExpoCallKitTelecomHeadlessService.dispatch(context, "callActive", id.toString())
            telecomManager.placeCall(participantUri(recipient), telecomExtras)
        } catch (error: Throwable) {
            reportCallEnded(id, CallEndedReason.FAILED)
            throw error
        }
        return id.toString()
    }

    fun reportIncomingCall(event: IncomingCallEvent): String {
        ensureInitialized()
        requirePermissions(Manifest.permission.READ_PHONE_NUMBERS)
        require(!event.hasVideo) { "Managed migration mode supports audio calls only" }
        check(isPhoneAccountEnabled()) { "The Evercall phone account is not enabled" }

        val id = UUID.randomUUID()
        val caller = participantFrom(event)
        val session =
            CallSession(
                id = id,
                options = CallOptions(hasVideo = false),
                origin = CallSessionOrigin.INCOMING,
                remoteParticipants = listOf(caller),
                incomingCallEvent = event,
                status = CallSessionStatus.RINGING,
            )
        CallStore.add(session)
        CallAudioManager.prepareAudioSessionForCall(false)

        try {
            telecomManager.addNewIncomingCall(
                accountHandle,
                Bundle().apply { putString(EXTRA_CALL_ID, id.toString()) },
            )
            CallEventEmitter.send(CallEvents.INCOMING_CALL_REPORTED, mapOf("id" to id.toString()))
        } catch (error: Throwable) {
            CallStore.remove(id)
            throw error
        }
        return id.toString()
    }

    private fun requirePermissions(vararg permissions: String) {
        val missing =
            permissions.filter {
                ContextCompat.checkSelfPermission(context, it) != PackageManager.PERMISSION_GRANTED
            }
        if (missing.isNotEmpty()) throw MissingCallPermissionsException(*missing.toTypedArray())
    }

    internal fun createIncomingConnection(request: ConnectionRequest): Connection {
        ensureInitialized()
        val id = request.callIdOrNull() ?: return Connection.createFailedConnection(
            DisconnectCause(DisconnectCause.ERROR, "Missing call identifier"),
        )
        val session = CallStore.session(id) ?: return Connection.createFailedConnection(
            DisconnectCause(DisconnectCause.ERROR, "Unknown incoming call"),
        )
        return attachConnection(id, session, incoming = true)
    }

    internal fun createOutgoingConnection(request: ConnectionRequest): Connection {
        ensureInitialized()
        val requestedId = request.callIdOrNull()
        val address = request.address
        val id = requestedId ?: UUID.randomUUID()
        val existing = CallStore.session(id)
        val session =
            existing
                ?: newOutgoingSession(
                    id,
                    CallParticipant(
                        id = address?.schemeSpecificPart ?: id.toString(),
                        phoneNumber = address?.takeIf { it.scheme == PhoneAccount.SCHEME_TEL }?.schemeSpecificPart,
                        email = address?.takeIf { it.scheme == PhoneAccount.SCHEME_SIP }?.schemeSpecificPart,
                        displayName = address?.schemeSpecificPart,
                    ),
                    CallSessionOrigin.OUTGOING_SYSTEM,
                ).also { CallStore.add(it) }

        val connection = attachConnection(id, session, incoming = false)
        CallEventEmitter.send(CallEvents.OUTGOING_CALL_STARTED, mapOf("id" to id.toString()))
        if (requestedId == null) {
            CallMicrophoneService.start(context, id) { ready ->
                if (CallStore.session(id) == null) return@start
                if (!ready) {
                    reportCallEnded(id, CallEndedReason.FAILED)
                    return@start
                }

                ExpoCallKitTelecomHeadlessService.dispatch(context, "callActive", id.toString())
                CallEventEmitter.send(
                    CallEvents.CALL_INTENT_RECEIVED,
                    mapOf(
                        "nativeCallId" to id.toString(),
                        "handle" to (address?.schemeSpecificPart ?: ""),
                        "handleType" to if (address?.scheme == PhoneAccount.SCHEME_TEL) "phoneNumber" else "unknown",
                        "hasVideo" to false,
                    ),
                )
            }
        }
        return connection
    }

    internal fun onCreateConnectionFailed(request: ConnectionRequest) {
        request.callIdOrNull()?.let { id -> finishCall(id, DisconnectCause(DisconnectCause.ERROR), true) }
    }

    private fun attachConnection(
        id: UUID,
        session: CallSession,
        incoming: Boolean,
    ): ManagedCallConnection {
        val participant = session.remoteParticipants.firstOrNull()
        return ManagedCallConnection(id).also { connection ->
            participant?.let {
                connection.setAddress(participantUri(it), TelecomManager.PRESENTATION_ALLOWED)
                connection.setCallerDisplayName(it.displayName, TelecomManager.PRESENTATION_ALLOWED)
            }
            if (incoming) connection.markRinging() else connection.markDialing()
            connections[id] = connection
        }
    }

    fun answerCall(id: UUID) {
        ensureInitialized()
        onSystemAnswer(id)
    }

    internal fun onSystemAnswer(id: UUID) {
        val session = CallStore.session(id) ?: return
        if (session.status == CallSessionStatus.CONNECTED || session.status == CallSessionStatus.CONNECTING) return

        CallStore.updateStatus(id, CallSessionStatus.CONNECTING)
        val request =
            FulfillRequestManager.createRequest(id, fulfillAnswerTimeoutMs) { callId ->
                reportCallEnded(callId, CallEndedReason.FAILED)
            }
        CallMicrophoneService.start(context, id) { ready ->
            if (CallStore.session(id)?.status != CallSessionStatus.CONNECTING) return@start
            if (!ready) {
                reportCallEnded(id, CallEndedReason.FAILED)
                return@start
            }

            ExpoCallKitTelecomHeadlessService.dispatch(context, "answer", id.toString())
            CallAudioManager.onAudioActivated(CallStore.allSessions())
            CallEventEmitter.send(
                CallEvents.CALL_ANSWERED,
                mapOf("id" to id.toString(), "requestId" to request.requestId.toString()),
            )
        }
    }

    fun fulfillIncomingCallConnected(requestId: UUID): Boolean {
        val id = FulfillRequestManager.fulfill(requestId) ?: return false
        markConnected(id)
        return true
    }

    fun reportOutgoingCallConnected(id: UUID) {
        markConnected(id)
    }

    private fun markConnected(id: UUID) {
        val now = Instant.now()
        CallStore.update(id) { it.copy(status = CallSessionStatus.CONNECTED, connectedAt = now) }
        connections[id]?.markActive()
        DialtonePlayer.stop()
        CallAudioManager.onAudioActivated(CallStore.allSessions())
    }

    fun endCall(id: UUID) {
        finishCall(id, DisconnectCause(DisconnectCause.LOCAL), true)
    }

    internal fun onSystemEnd(id: UUID, cause: DisconnectCause) {
        finishCall(id, cause, true)
    }

    fun reportCallEnded(id: UUID, reason: CallEndedReason) {
        finishCall(id, disconnectCauseFor(reason), false, reason)
    }

    fun reportServerCallEnded(serverCallId: String, reason: CallEndedReason): Boolean {
        val session = CallStore.allSessions().firstOrNull {
            it.incomingCallEvent?.serverCallId == serverCallId
        } ?: return false
        reportCallEnded(session.id, reason)
        return true
    }

    private fun finishCall(
        id: UUID,
        cause: DisconnectCause,
        emitEnded: Boolean,
        reportedReason: CallEndedReason? = null,
    ) {
        val session = CallStore.session(id) ?: return
        FulfillRequestManager.cancelForCall(id)
        CallStore.updateStatus(id, CallSessionStatus.ENDED)
        val ended = CallStore.session(id) ?: session
        connections.remove(id)?.finish(cause)

        val body = mapOf("id" to id.toString(), "session" to ended.toMap())
        if (emitEnded) CallEventEmitter.send(CallEvents.CALL_ENDED, body)
        if (reportedReason != null) {
            CallEventEmitter.send(
                CallEvents.CALL_REPORTED_ENDED,
                body + ("reason" to reportedReason.value),
            )
        }
        CallStore.remove(id)
        if (CallStore.allSessions().isEmpty()) {
            CallMicrophoneService.stop(context)
            CallAudioManager.onAudioDeactivated(emptyList())
        }
    }

    fun setMuted(id: UUID, muted: Boolean) {
        onSystemMute(id, muted)
    }

    fun reportVideo(id: UUID, enabled: Boolean) {
        require(!enabled) { "Managed migration mode supports audio calls only" }
        if (CallStore.session(id) == null) return
        CallStore.update(id) { it.copy(options = CallOptions(hasVideo = false)) }
    }

    internal fun onSystemMute(id: UUID, muted: Boolean) {
        val session = CallStore.session(id) ?: return
        if (session.isMuted == muted) return
        CallStore.updateMuted(id, muted)
        CallEventEmitter.send(
            CallEvents.SET_MUTED_ACTION,
            mapOf("id" to id.toString(), "isMuted" to muted),
        )
    }

    fun setHeld(id: UUID, onHold: Boolean) {
        onSystemHold(id, onHold)
        if (onHold) connections[id]?.markHeld() else connections[id]?.markActive()
    }

    internal fun onSystemHold(id: UUID, onHold: Boolean) {
        val session = CallStore.session(id) ?: return
        if (session.isOnHold == onHold) return
        CallStore.updateHeld(id, onHold)
        CallEventEmitter.send(
            CallEvents.SET_HELD_ACTION,
            mapOf("id" to id.toString(), "isOnHold" to onHold),
        )
    }

    fun playDTMF(id: UUID, digits: String) {
        onSystemDtmf(id, digits)
    }

    internal fun onSystemDtmf(id: UUID, digits: String) {
        if (CallStore.session(id) == null) return
        CallStore.update(id) { it.copy(dtmfDigits = digits) }
        CallEventEmitter.send(CallEvents.DTMF, mapOf("id" to id.toString(), "digits" to digits))
    }

    private fun newOutgoingSession(
        id: UUID,
        recipient: CallParticipant,
        origin: CallSessionOrigin = CallSessionOrigin.OUTGOING_APP,
    ): CallSession =
        CallSession(
            id = id,
            options = CallOptions(hasVideo = false),
            origin = origin,
            remoteParticipants = listOf(recipient),
            status = CallSessionStatus.REQUESTING,
        )

    private fun participantFrom(event: IncomingCallEvent): CallParticipant =
        CallParticipant(
            id = event.caller.id,
            phoneNumber = event.caller.phoneNumber,
            email = event.caller.email,
            displayName = event.caller.displayName,
            avatarUrl = event.caller.avatarUrl,
        )

    private fun participantUri(participant: CallParticipant): Uri =
        when {
            !participant.phoneNumber.isNullOrBlank() ->
                Uri.fromParts(PhoneAccount.SCHEME_TEL, participant.phoneNumber, null)
            !participant.email.isNullOrBlank() ->
                Uri.fromParts(PhoneAccount.SCHEME_SIP, participant.email, null)
            else -> Uri.fromParts(PhoneAccount.SCHEME_SIP, participant.id, null)
        }

    private fun ConnectionRequest.callIdOrNull(): UUID? {
        val raw =
            extras?.getString(EXTRA_CALL_ID)
                ?: extras
                    ?.getBundle(TelecomManager.EXTRA_OUTGOING_CALL_EXTRAS)
                    ?.getString(EXTRA_CALL_ID)
                ?: return null
        return try {
            UUID.fromString(raw)
        } catch (_: IllegalArgumentException) {
            null
        }
    }

    private fun disconnectCauseFor(reason: CallEndedReason): DisconnectCause =
        when (reason) {
            CallEndedReason.REMOTE_ENDED -> DisconnectCause(DisconnectCause.REMOTE)
            CallEndedReason.UNANSWERED -> DisconnectCause(DisconnectCause.MISSED)
            CallEndedReason.ANSWERED_ELSEWHERE,
            CallEndedReason.DECLINED_ELSEWHERE -> DisconnectCause(DisconnectCause.REMOTE)
            CallEndedReason.FAILED,
            CallEndedReason.UNKNOWN -> DisconnectCause(DisconnectCause.ERROR)
        }
}
