package expo.modules.callkittelecom

import com.facebook.react.bridge.ReactContext
import com.oney.WebRTCModule.ExpoCallKitDtmfBridge
import expo.modules.kotlin.Promise
import expo.modules.callkittelecom.events.CallEventEmitter
import expo.modules.callkittelecom.events.CallEvents
import expo.modules.callkittelecom.managers.CallAudioManager
import expo.modules.callkittelecom.managers.CaptureSessionManager
import expo.modules.callkittelecom.managers.VoIPPushManager
import expo.modules.callkittelecom.models.CallEndedReason
import expo.modules.callkittelecom.models.CallOptions
import expo.modules.callkittelecom.models.CallParticipant
import expo.modules.callkittelecom.models.IncomingCallEvent
import expo.modules.callkittelecom.store.CallStore
import expo.modules.callkittelecom.push.PushPayloadProfileStore
import expo.modules.callkittelecom.telecom.ManagedCallManager
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.UUID

class ExpoCallKitTelecomModule : Module() {
    override fun definition() = ModuleDefinition {
        Name("ExpoCallKitTelecom")

        // region Events

        Events(
            CallEvents.CALL_SESSION_ADDED,
            CallEvents.CALL_SESSION_UPDATED,
            CallEvents.CALL_SESSION_REMOVED,
            CallEvents.AUDIO_SESSION_ACTIVATED,
            CallEvents.AUDIO_SESSION_DEACTIVATED,
            CallEvents.AUDIO_ROUTE_CHANGED,
            CallEvents.INCOMING_CALL_REPORTED,
            CallEvents.OUTGOING_CALL_STARTED,
            CallEvents.CALL_ANSWERED,
            CallEvents.CALL_ENDED,
            CallEvents.CALL_REPORTED_ENDED,
            CallEvents.SET_MUTED_ACTION,
            CallEvents.VIDEO_CHANGED,
            CallEvents.SET_HELD_ACTION,
            CallEvents.DTMF,
            CallEvents.CALL_INTENT_RECEIVED,
            CallEvents.VOIP_PUSH_TOKEN_UPDATED,
        )

        // endregion

        // region Lifecycle

        OnCreate {
            val context = appContext.reactContext ?: return@OnCreate

            ManagedCallManager.shared.initialize(context)

            VoIPPushManager.register()

            CallEventEmitter.setSender { eventName, body -> sendEvent(eventName, body) }

        }

        OnDestroy { CallEventEmitter.setSender(null) }

        // Register per-event observers
        OnStartObserving(CallEvents.CALL_SESSION_ADDED) {
            CallEventEmitter.startObserving(CallEvents.CALL_SESSION_ADDED)
        }
        OnStopObserving(CallEvents.CALL_SESSION_ADDED) {
            CallEventEmitter.stopObserving(CallEvents.CALL_SESSION_ADDED)
        }

        OnStartObserving(CallEvents.CALL_SESSION_UPDATED) {
            CallEventEmitter.startObserving(CallEvents.CALL_SESSION_UPDATED)
        }
        OnStopObserving(CallEvents.CALL_SESSION_UPDATED) {
            CallEventEmitter.stopObserving(CallEvents.CALL_SESSION_UPDATED)
        }

        OnStartObserving(CallEvents.CALL_SESSION_REMOVED) {
            CallEventEmitter.startObserving(CallEvents.CALL_SESSION_REMOVED)
        }
        OnStopObserving(CallEvents.CALL_SESSION_REMOVED) {
            CallEventEmitter.stopObserving(CallEvents.CALL_SESSION_REMOVED)
        }

        OnStartObserving(CallEvents.AUDIO_SESSION_ACTIVATED) {
            CallEventEmitter.startObserving(CallEvents.AUDIO_SESSION_ACTIVATED)
        }
        OnStopObserving(CallEvents.AUDIO_SESSION_ACTIVATED) {
            CallEventEmitter.stopObserving(CallEvents.AUDIO_SESSION_ACTIVATED)
        }

        OnStartObserving(CallEvents.AUDIO_SESSION_DEACTIVATED) {
            CallEventEmitter.startObserving(CallEvents.AUDIO_SESSION_DEACTIVATED)
        }
        OnStopObserving(CallEvents.AUDIO_SESSION_DEACTIVATED) {
            CallEventEmitter.stopObserving(CallEvents.AUDIO_SESSION_DEACTIVATED)
        }

        OnStartObserving(CallEvents.AUDIO_ROUTE_CHANGED) {
            CallEventEmitter.startObserving(CallEvents.AUDIO_ROUTE_CHANGED)
        }
        OnStopObserving(CallEvents.AUDIO_ROUTE_CHANGED) {
            CallEventEmitter.stopObserving(CallEvents.AUDIO_ROUTE_CHANGED)
        }

        OnStartObserving(CallEvents.INCOMING_CALL_REPORTED) {
            CallEventEmitter.startObserving(CallEvents.INCOMING_CALL_REPORTED)
        }
        OnStopObserving(CallEvents.INCOMING_CALL_REPORTED) {
            CallEventEmitter.stopObserving(CallEvents.INCOMING_CALL_REPORTED)
        }

        OnStartObserving(CallEvents.OUTGOING_CALL_STARTED) {
            CallEventEmitter.startObserving(CallEvents.OUTGOING_CALL_STARTED)
        }
        OnStopObserving(CallEvents.OUTGOING_CALL_STARTED) {
            CallEventEmitter.stopObserving(CallEvents.OUTGOING_CALL_STARTED)
        }

        OnStartObserving(CallEvents.CALL_ANSWERED) {
            CallEventEmitter.startObserving(CallEvents.CALL_ANSWERED)
        }
        OnStopObserving(CallEvents.CALL_ANSWERED) {
            CallEventEmitter.stopObserving(CallEvents.CALL_ANSWERED)
        }

        OnStartObserving(CallEvents.CALL_ENDED) {
            CallEventEmitter.startObserving(CallEvents.CALL_ENDED)
        }
        OnStopObserving(CallEvents.CALL_ENDED) {
            CallEventEmitter.stopObserving(CallEvents.CALL_ENDED)
        }

        OnStartObserving(CallEvents.CALL_REPORTED_ENDED) {
            CallEventEmitter.startObserving(CallEvents.CALL_REPORTED_ENDED)
        }
        OnStopObserving(CallEvents.CALL_REPORTED_ENDED) {
            CallEventEmitter.stopObserving(CallEvents.CALL_REPORTED_ENDED)
        }

        OnStartObserving(CallEvents.SET_MUTED_ACTION) {
            CallEventEmitter.startObserving(CallEvents.SET_MUTED_ACTION)
        }
        OnStopObserving(CallEvents.SET_MUTED_ACTION) {
            CallEventEmitter.stopObserving(CallEvents.SET_MUTED_ACTION)
        }

        OnStartObserving(CallEvents.VIDEO_CHANGED) {
            CallEventEmitter.startObserving(CallEvents.VIDEO_CHANGED)
        }
        OnStopObserving(CallEvents.VIDEO_CHANGED) {
            CallEventEmitter.stopObserving(CallEvents.VIDEO_CHANGED)
        }

        OnStartObserving(CallEvents.SET_HELD_ACTION) {
            CallEventEmitter.startObserving(CallEvents.SET_HELD_ACTION)
        }
        OnStopObserving(CallEvents.SET_HELD_ACTION) {
            CallEventEmitter.stopObserving(CallEvents.SET_HELD_ACTION)
        }

        OnStartObserving(CallEvents.DTMF) { CallEventEmitter.startObserving(CallEvents.DTMF) }
        OnStopObserving(CallEvents.DTMF) { CallEventEmitter.stopObserving(CallEvents.DTMF) }

        OnStartObserving(CallEvents.CALL_INTENT_RECEIVED) {
            CallEventEmitter.startObserving(CallEvents.CALL_INTENT_RECEIVED)
        }
        OnStopObserving(CallEvents.CALL_INTENT_RECEIVED) {
            CallEventEmitter.stopObserving(CallEvents.CALL_INTENT_RECEIVED)
        }

        OnStartObserving(CallEvents.VOIP_PUSH_TOKEN_UPDATED) {
            CallEventEmitter.startObserving(CallEvents.VOIP_PUSH_TOKEN_UPDATED)
        }
        OnStopObserving(CallEvents.VOIP_PUSH_TOKEN_UPDATED) {
            CallEventEmitter.stopObserving(CallEvents.VOIP_PUSH_TOKEN_UPDATED)
        }

        // endregion

        // region Android Phone Account

        Function("registerAndroidPhoneAccount") {
            ManagedCallManager.shared.registerPhoneAccount()
        }

        Function("isAndroidPhoneAccountEnabled") {
            ManagedCallManager.shared.isPhoneAccountEnabled()
        }

        Function("openAndroidPhoneAccountSettings") {
            ManagedCallManager.shared.openPhoneAccountSettings()
        }

        // endregion

        // region Call Session

        // Returns the first active call session, if present.
        AsyncFunction("getActiveCallSession") { CallStore.firstSession()?.toMap() }
        AsyncFunction("getCallSessions") { CallStore.allSessions().map { it.toMap() } }
        AsyncFunction("getCallSession") { id: String -> CallStore.session(UUID.fromString(id))?.toMap() }

        // endregion

        // region Audio Session

        Function("getAudioDevices") { direction: String -> CallAudioManager.getAudioDevices(direction) }

        AsyncFunction("setAudioDevice") { callId: String, direction: String, id: String, promise: Promise ->
            CallAudioManager.setAudioDevice(UUID.fromString(callId), direction, id, promise)
        }

        // Returns current audio session snapshot for diagnostics/UI state.
        Function("getAudioSessionState") { CallAudioManager.getAudioSessionState() }

        // Prepares audio session state before starting/reporting a call.
        Function("prepareAudioSessionForCall") { hasVideo: Boolean ->
            CallAudioManager.prepareAudioSessionForCall(hasVideo)
        }

        // Restores pre-call audio mode/route state.
        Function("restoreAudioSession") { CallAudioManager.restoreAudioSession() }

        // Overrides route to speaker (true) or clears override (false).
        Function("setAudioSessionPortOverride") { enabled: Boolean ->
            CallAudioManager.setAudioSessionPortOverride(enabled)
        }

        // endregion

        // region Capture Session

        // Returns capture session state (currently camera permission).
        Function("getCaptureSessionState") { CaptureSessionManager.getCaptureSessionState() }

        // endregion

        // region Start Outgoing Call

        // Starts a new outgoing call and returns the native call session ID.
        AsyncFunction("startOutgoingCall") {
            recipient: Map<String, Any?>,
            options: Map<String, Any?> ->
            val callId =
                ManagedCallManager.shared.startOutgoingCall(
                    recipient = CallParticipant.fromMap(recipient),
                    options = CallOptions(hasVideo = options["hasVideo"] as? Boolean ?: false),
                )
            callId
        }

        // endregion

        // region Report Incoming Call

        // Reports an incoming call to Telecom from app/push events.
        AsyncFunction("reportIncomingCall") { event: Map<String, Any?> ->
            ManagedCallManager.shared.reportIncomingCall(IncomingCallEvent.fromMap(event))
        }

        // endregion

        // region Answer Call

        // Answers an existing incoming call session.
        AsyncFunction("answerCall") { id: String ->
            ManagedCallManager.shared.answerCall(UUID.fromString(id))
        }

        // Fulfills pending incoming-call answer once media is connected.
        AsyncFunction("fulfillIncomingCallAnswered") { requestId: String ->
            ManagedCallManager.shared.fulfillIncomingCallConnected(UUID.fromString(requestId))
        }

        // Reports outgoing call media connection established.
        AsyncFunction("reportOutgoingCallConnected") { id: String ->
            ManagedCallManager.shared.reportOutgoingCallConnected(UUID.fromString(id))
        }

        // endregion

        // region End Call

        // Ends an active call.
        AsyncFunction("endCall") { id: String -> ManagedCallManager.shared.endCall(UUID.fromString(id)) }

        // Reports an externally-ended call with explicit reason.
        AsyncFunction("reportCallEnded") { id: String, reason: String ->
            ManagedCallManager.shared.reportCallEnded(
                UUID.fromString(id),
                CallEndedReason.fromValue(reason),
            )
        }

        // endregion

        // region Mute Support

        // Sets mute state for a call.
        AsyncFunction("setMuted") { id: String, muted: Boolean ->
            ManagedCallManager.shared.setMuted(UUID.fromString(id), muted)
        }

        // endregion

        // region Video Support

        // Reports call video enabled state changes.
        AsyncFunction("reportVideo") { id: String, enabled: Boolean ->
            ManagedCallManager.shared.reportVideo(UUID.fromString(id), enabled)
        }

        // endregion

        // region Hold Support

        // Sets call hold state.
        AsyncFunction("setHeld") { id: String, onHold: Boolean ->
            ManagedCallManager.shared.setHeld(UUID.fromString(id), onHold)
        }

        // endregion

        // region DTMF Support

        // Observe queue processing, without exposing DTMF digits to JavaScript logs.
        AsyncFunction("getRtpDtmfState") { peerConnectionId: Int, senderId: String, promise: Promise ->
            val context = appContext.reactContext as? ReactContext
            if (context == null) {
                promise.reject("ERR_RTP_DTMF", "React context is unavailable", null)
            } else {
                ExpoCallKitDtmfBridge.inspect(context, peerConnectionId, senderId,
                    object : ExpoCallKitDtmfBridge.StateResult {
                        override fun onSuccess(remainingSymbols: Int, canInsert: Boolean, audioTrackEnabled: Boolean,
                                               durationMs: Int, interToneGapMs: Int) {
                            promise.resolve(mapOf(
                                "remainingSymbols" to remainingSymbols,
                                "canInsert" to canInsert,
                                "audioTrackEnabled" to audioTrackEnabled,
                                "durationMs" to durationMs,
                                "interToneGapMs" to interToneGapMs,
                            ))
                        }
                        override fun onFailure(error: Exception) {
                            promise.reject("ERR_RTP_DTMF", error.message, error)
                        }
                    },
                )
            }
        }

        // Inserts RFC2833/telephone-event tones into the existing SIP audio stream.
        AsyncFunction("sendRtpDtmf") { peerConnectionId: Int, senderId: String, tones: String, promise: Promise ->
            // Expo exposes this as Context even though its main runtime holds a
            // ReactApplicationContext. Narrow safely before accessing WebRTC.
            val context = appContext.reactContext as? ReactContext
            if (context == null) {
                promise.reject("ERR_RTP_DTMF", "React context is unavailable", null)
            } else {
                ExpoCallKitDtmfBridge.send(context, peerConnectionId, senderId, tones,
                    object : ExpoCallKitDtmfBridge.Result {
                        override fun onSuccess() { promise.resolve(null) }
                        override fun onFailure(error: Exception) {
                            promise.reject("ERR_RTP_DTMF", error.message, error)
                        }
                    },
                )
            }
        }

        // Sends requested DTMF digits for a call.
        AsyncFunction("playDTMF") { id: String, digits: String ->
            ManagedCallManager.shared.playDTMF(UUID.fromString(id), digits)
        }

        // endregion

        // region VoIP Push

        Function("configurePushPayloadProfiles") { profilesJson: String ->
            val context = appContext.reactContext ?: return@Function
            PushPayloadProfileStore.save(context, profilesJson)
        }

        Function("getPushPayloadProfilesJson") {
            val context = appContext.reactContext ?: return@Function null
            PushPayloadProfileStore.read(context)
        }

        // Registers for VoIP push by fetching the FCM token.
        Function("registerVoIPPush") { VoIPPushManager.register() }

        // Returns the current VoIP push token and its type.
        Function("getVoIPPushToken") { mapOf("token" to VoIPPushManager.token, "type" to "FCM") }

        // endregion
    }
}
