package expo.modules.callkittelecom.telecom

import android.telecom.CallAudioState
import android.telecom.Connection
import android.telecom.DisconnectCause
import expo.modules.callkittelecom.utils.CallKitTelecomLog
import java.util.UUID

/**
 * A system-managed Telecom connection.
 *
 * The device's current InCallService (normally the stock Phone app) owns the UI. This class only
 * translates Telecom actions into the module's normalized call events.
 */
internal class ManagedCallConnection(
    internal val callId: UUID,
) : Connection() {
    companion object {
        private const val TAG = "ExpoCallKitTelecom.ManagedConnection"
    }

    init {
        setAudioModeIsVoip(true)
        connectionCapabilities = CAPABILITY_SUPPORT_HOLD or CAPABILITY_HOLD
    }

    override fun onAnswer() {
        CallKitTelecomLog.d(TAG) { "System answered call - id: $callId" }
        ManagedCallManager.shared.onSystemAnswer(callId)
    }

    override fun onReject() {
        CallKitTelecomLog.d(TAG) { "System rejected call - id: $callId" }
        ManagedCallManager.shared.onSystemEnd(callId, DisconnectCause(DisconnectCause.REJECTED))
    }

    override fun onReject(rejectReason: Int) {
        onReject()
    }

    override fun onAbort() {
        CallKitTelecomLog.d(TAG) { "System aborted call - id: $callId" }
        ManagedCallManager.shared.onSystemEnd(callId, DisconnectCause(DisconnectCause.CANCELED))
    }

    override fun onDisconnect() {
        CallKitTelecomLog.d(TAG) { "System disconnected call - id: $callId" }
        ManagedCallManager.shared.onSystemEnd(callId, DisconnectCause(DisconnectCause.LOCAL))
    }

    override fun onHold() {
        ManagedCallManager.shared.onSystemHold(callId, true)
        setOnHold()
    }

    override fun onUnhold() {
        ManagedCallManager.shared.onSystemHold(callId, false)
        setActive()
    }

    override fun onPlayDtmfTone(c: Char) {
        ManagedCallManager.shared.onSystemDtmf(callId, c.toString())
    }

    override fun onStopDtmfTone() = Unit

    @Suppress("DEPRECATION")
    override fun onCallAudioStateChanged(state: CallAudioState) {
        super.onCallAudioStateChanged(state)
        ManagedCallManager.shared.onSystemMute(callId, state.isMuted)
    }

    internal fun markDialing() {
        setDialing()
    }

    internal fun markRinging() {
        setRinging()
    }

    internal fun markActive() {
        setActive()
    }

    internal fun markHeld() {
        setOnHold()
    }

    internal fun finish(cause: DisconnectCause) {
        setDisconnected(cause)
        destroy()
    }
}

