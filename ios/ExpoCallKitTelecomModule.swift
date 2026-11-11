import CallKit
import ExpoModulesCore

public class ExpoCallKitTelecomModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ExpoCallKitTelecom")

    // MARK: - Events

    Events(
      CallSessionAddedEvent.name,
      CallSessionUpdatedEvent.name,
      CallSessionRemovedEvent.name,
      AudioSessionActivatedEvent.name,
      AudioSessionDeactivatedEvent.name,
      AudioRouteChangedEvent.name,
      IncomingCallReportedEvent.name,
      OutgoingCallStartedEvent.name,
      CallAnsweredEvent.name,
      CallEndedEvent.name,
      CallReportedEnded.name,
      SetMutedActionEvent.name,
      VideoChangedEvent.name,
      SetHeldActionEvent.name,
      DTMFEvent.name,
      CallIntentReceivedEvent.name,
      VoIPPushTokenUpdatedEvent.name
    )

    // MARK: - Lifecycle

    OnCreate { [weak self] in
      Task { @MainActor in
        CallEventEmitter.shared.module = self
      }
    }

    // Register per-event observers
    OnStartObserving(CallSessionAddedEvent.name) {
      Task { @MainActor in
        CallEventEmitter.shared.startObserving(
          eventName: CallSessionAddedEvent.name
        )
      }
    }
    OnStopObserving(CallSessionAddedEvent.name) {
      Task { @MainActor in
        CallEventEmitter.shared.stopObserving(
          eventName: CallSessionAddedEvent.name
        )
      }
    }

    OnStartObserving(CallSessionUpdatedEvent.name) {
      Task { @MainActor in
        CallEventEmitter.shared.startObserving(
          eventName: CallSessionUpdatedEvent.name
        )
      }
    }
    OnStopObserving(CallSessionUpdatedEvent.name) {
      Task { @MainActor in
        CallEventEmitter.shared.stopObserving(
          eventName: CallSessionUpdatedEvent.name
        )
      }
    }

    OnStartObserving(CallSessionRemovedEvent.name) {
      Task { @MainActor in
        CallEventEmitter.shared.startObserving(
          eventName: CallSessionRemovedEvent.name
        )
      }
    }
    OnStopObserving(CallSessionRemovedEvent.name) {
      Task { @MainActor in
        CallEventEmitter.shared.stopObserving(
          eventName: CallSessionRemovedEvent.name
        )
      }
    }

    OnStartObserving(AudioSessionActivatedEvent.name) {
      Task { @MainActor in
        CallEventEmitter.shared.startObserving(
          eventName: AudioSessionActivatedEvent.name
        )
      }
    }
    OnStopObserving(AudioSessionActivatedEvent.name) {
      Task { @MainActor in
        CallEventEmitter.shared.stopObserving(
          eventName: AudioSessionActivatedEvent.name
        )
      }
    }

    OnStartObserving(AudioSessionDeactivatedEvent.name) {
      Task { @MainActor in
        CallEventEmitter.shared.startObserving(
          eventName: AudioSessionDeactivatedEvent.name
        )
      }
    }
    OnStopObserving(AudioSessionDeactivatedEvent.name) {
      Task { @MainActor in
        CallEventEmitter.shared.stopObserving(
          eventName: AudioSessionDeactivatedEvent.name
        )
      }
    }

    OnStartObserving(AudioRouteChangedEvent.name) {
      Task { @MainActor in
        CallEventEmitter.shared.startObserving(
          eventName: AudioRouteChangedEvent.name
        )
      }
    }
    OnStopObserving(AudioRouteChangedEvent.name) {
      Task { @MainActor in
        CallEventEmitter.shared.stopObserving(
          eventName: AudioRouteChangedEvent.name
        )
      }
    }

    OnStartObserving(IncomingCallReportedEvent.name) {
      Task { @MainActor in
        CallEventEmitter.shared.startObserving(
          eventName: IncomingCallReportedEvent.name
        )
      }
    }
    OnStopObserving(IncomingCallReportedEvent.name) {
      Task { @MainActor in
        CallEventEmitter.shared.stopObserving(
          eventName: IncomingCallReportedEvent.name
        )
      }
    }

    OnStartObserving(OutgoingCallStartedEvent.name) {
      Task { @MainActor in
        CallEventEmitter.shared.startObserving(
          eventName: OutgoingCallStartedEvent.name
        )
      }
    }
    OnStopObserving(OutgoingCallStartedEvent.name) {
      Task { @MainActor in
        CallEventEmitter.shared.stopObserving(
          eventName: OutgoingCallStartedEvent.name
        )
      }
    }

    OnStartObserving(CallAnsweredEvent.name) {
      Task { @MainActor in
        CallEventEmitter.shared.startObserving(
          eventName: CallAnsweredEvent.name
        )
      }
    }
    OnStopObserving(CallAnsweredEvent.name) {
      Task { @MainActor in
        CallEventEmitter.shared.stopObserving(
          eventName: CallAnsweredEvent.name
        )
      }
    }

    OnStartObserving(CallEndedEvent.name) {
      Task { @MainActor in
        CallEventEmitter.shared.startObserving(
          eventName: CallEndedEvent.name
        )
      }
    }
    OnStopObserving(CallEndedEvent.name) {
      Task { @MainActor in
        CallEventEmitter.shared.stopObserving(
          eventName: CallEndedEvent.name
        )
      }
    }

    OnStartObserving(CallReportedEnded.name) {
      Task { @MainActor in
        CallEventEmitter.shared.startObserving(
          eventName: CallReportedEnded.name
        )
      }
    }
    OnStopObserving(CallReportedEnded.name) {
      Task { @MainActor in
        CallEventEmitter.shared.stopObserving(
          eventName: CallReportedEnded.name
        )
      }
    }

    OnStartObserving(SetMutedActionEvent.name) {
      Task { @MainActor in
        CallEventEmitter.shared.startObserving(
          eventName: SetMutedActionEvent.name
        )
      }
    }
    OnStopObserving(SetMutedActionEvent.name) {
      Task { @MainActor in
        CallEventEmitter.shared.stopObserving(
          eventName: SetMutedActionEvent.name
        )
      }
    }

    OnStartObserving(VideoChangedEvent.name) {
      Task { @MainActor in
        CallEventEmitter.shared.startObserving(
          eventName: VideoChangedEvent.name
        )
      }
    }
    OnStopObserving(VideoChangedEvent.name) {
      Task { @MainActor in
        CallEventEmitter.shared.stopObserving(
          eventName: VideoChangedEvent.name
        )
      }
    }

    OnStartObserving(SetHeldActionEvent.name) {
      Task { @MainActor in
        CallEventEmitter.shared.startObserving(
          eventName: SetHeldActionEvent.name
        )
      }
    }
    OnStopObserving(SetHeldActionEvent.name) {
      Task { @MainActor in
        CallEventEmitter.shared.stopObserving(
          eventName: SetHeldActionEvent.name
        )
      }
    }

    OnStartObserving(DTMFEvent.name) {
      Task { @MainActor in
        CallEventEmitter.shared.startObserving(
          eventName: DTMFEvent.name
        )
      }
    }
    OnStopObserving(DTMFEvent.name) {
      Task { @MainActor in
        CallEventEmitter.shared.stopObserving(eventName: DTMFEvent.name)
      }
    }

    OnStartObserving(CallIntentReceivedEvent.name) {
      Task { @MainActor in
        CallEventEmitter.shared.startObserving(
          eventName: CallIntentReceivedEvent.name
        )
      }
    }
    OnStopObserving(CallIntentReceivedEvent.name) {
      Task { @MainActor in
        CallEventEmitter.shared.stopObserving(
          eventName: CallIntentReceivedEvent.name
        )
      }
    }

    OnStartObserving(VoIPPushTokenUpdatedEvent.name) {
      Task { @MainActor in
        CallEventEmitter.shared.startObserving(
          eventName: VoIPPushTokenUpdatedEvent.name
        )
      }
    }
    OnStopObserving(VoIPPushTokenUpdatedEvent.name) {
      Task { @MainActor in
        CallEventEmitter.shared.stopObserving(
          eventName: VoIPPushTokenUpdatedEvent.name
        )
      }
    }

    // MARK: - Call Session

    AsyncFunction("getActiveCallSession") { () -> [String: Any]? in
      guard let session = await CallManager.shared.store.firstSession
      else {
        return nil
      }
      return session.toDictionary()
    }

    AsyncFunction("getCallSessions") { () -> [[String: Any]] in
      let sessions = await CallManager.shared.store.allSessions
      return sessions.map { $0.toDictionary() }
    }

    // Internal SIP admission APIs. Kept native so queued JS events cannot resurrect calls.
    AsyncFunction("claimIncomingSipCall") {
      (sipCallId: String, handle: String, accountId: String?) -> [String: String] in
      IncomingCallRegistry.shared.claim(sipCallId: sipCallId, handle: handle, accountId: accountId)
    }

    AsyncFunction("validateIncomingSipCall") {
      (id: String, sipCallId: String?, requestId: String?) -> Bool in
      guard let uuid = UUID(uuidString: id),
            IncomingCallRegistry.shared.validate(id: uuid, sipCallId: sipCallId, answering: requestId != nil)
      else { return false }
      guard let requestId else { return true }
      guard let requestUUID = UUID(uuidString: requestId) else { return false }
      return await FulfillRequestManager.shared.callId(for: requestUUID) == uuid
    }

    AsyncFunction("getCallSession") { (id: String) -> [String: Any]? in
      guard let uuid = UUID(uuidString: id) else {
        throw Exception(name: "InvalidUUID", description: "Invalid call ID: \(id)")
      }
      let session = await CallManager.shared.store.session(for: uuid)
      return session?.toDictionary()
    }

    // MARK: - Audio Session

    Function("getAudioDevices") { (direction: String) throws -> [[String: Any]] in
      return try AudioManager.shared.getAudioDevices(direction: direction)
    }

    AsyncFunction("setAudioDevice") { (callId: String, direction: String, id: String) async throws in
      guard let uuid = UUID(uuidString: callId),
        let session = await CallManager.shared.store.session(for: uuid), session.status != .ended else {
        throw NSError(domain: "AudioDevice", code: 3, userInfo: [NSLocalizedDescriptionKey: "Call is no longer available"])
      }
      try AudioManager.shared.setAudioDevice(direction: direction, id: id)
    }

    Function("getAudioSessionState") { () -> [String: Any] in
      return AudioManager.shared.getAudioSessionState()
    }

    AsyncFunction("requestMicrophonePermission") { () async -> Bool in
      return await AudioManager.shared.requestMicrophonePermission()
    }

    Function("setRTCAudioSessionConfiguration") { (hasVideo: Bool) in
      AudioManager.shared.setRTCAudioSessionConfiguration(hasVideo: hasVideo)
    }

    Function("prepareAudioSessionForCall") { (hasVideo: Bool) in
      AudioManager.shared.prepareAudioSessionForCall(hasVideo: hasVideo)
    }

    Function("restoreAudioSession") {
      AudioManager.shared.restoreAudioSession()
    }

    Function("setAudioSessionPortOverride") { (enabled: Bool) in
      AudioManager.shared.setAudioSessionPortOverride(enabled)
    }

    // MARK: - Capture Session

    Function("getCaptureSessionState") { () -> [String: Any] in
      return CaptureSessionManager.shared.getCaptureSessionState()
    }

    // MARK: - Start Outgoing Call

    AsyncFunction("startOutgoingCall") {
      (recipient: CallParticipantRecord, options: CallOptionsRecord)
        -> String in
      let id = try await CallManager.shared.startOutgoingCall(
        recipient: recipient.toModel(),
        options: options.toModel()
      )
      return id.uuidString
    }

    // MARK: - Report Incoming Call

    AsyncFunction("reportIncomingCall") {
      (event: IncomingCallEventRecord) -> String in
      let incomingCallEvent = try event.toModel()
      let id = try await CallManager.shared.reportIncomingCall(event: incomingCallEvent)
      return id.uuidString
    }

    // MARK: - Answer Call

    AsyncFunction("answerCall") { (id: String) in
      guard let uuid = UUID(uuidString: id) else {
        throw Exception(
          name: "InvalidUUID",
          description: "Invalid call ID: \(id)"
        )
      }

      try await CallManager.shared.answerCall(for: uuid)
    }

    AsyncFunction("fulfillIncomingCallAnswered") { (requestId: String) in
      guard let requestUUID = UUID(uuidString: requestId) else {
        throw Exception(
          name: "InvalidUUID",
          description: "Invalid request ID: \(requestId)"
        )
      }

      return await CallManager.shared.fulfillIncomingCall(requestId: requestUUID)
    }

    AsyncFunction("failIncomingCallConnected") { (requestId: String) in
      guard let requestUUID = UUID(uuidString: requestId) else {
        throw Exception(
          name: "InvalidUUID",
          description: "Invalid request ID: \(requestId)"
        )
      }

      await CallManager.shared.failIncomingCallConnected(requestId: requestUUID)
    }

    AsyncFunction("reportOutgoingCallConnected") { (id: String) in
      guard let uuid = UUID(uuidString: id) else {
        throw Exception(
          name: "InvalidUUID",
          description: "Invalid call ID: \(id)"
        )
      }

      await CallManager.shared.reportOutgoingCallConnected(for: uuid)
    }

    // MARK: - End Call

    AsyncFunction("endCall") { (id: String) in
      guard let uuid = UUID(uuidString: id) else {
        throw Exception(
          name: "InvalidUUID",
          description: "Invalid call ID: \(id)"
        )
      }

      try await CallManager.shared.endCall(for: uuid)
    }

    AsyncFunction("reportCallEnded") { (id: String, reason: String) in
      guard let uuid = UUID(uuidString: id) else {
        throw Exception(
          name: "InvalidUUID",
          description: "Invalid call ID: \(id)"
        )
      }

      let endedReason: CXCallEndedReason
      switch reason {
      case "failed": endedReason = .failed
      case "remoteEnded": endedReason = .remoteEnded
      case "unanswered": endedReason = .unanswered
      case "answeredElsewhere": endedReason = .answeredElsewhere
      case "declinedElsewhere": endedReason = .declinedElsewhere
      default: endedReason = .failed
      }

      await CallManager.shared.reportCallEnded(
        for: uuid,
        reason: endedReason
      )
    }

    // MARK: - Mute Support

    AsyncFunction("setMuted") { (id: String, muted: Bool) in
      guard let uuid = UUID(uuidString: id) else {
        throw Exception(
          name: "InvalidUUID",
          description: "Invalid call ID: \(id)"
        )
      }

      try await CallManager.shared.setMuted(for: uuid, muted: muted)
    }

    // MARK: - Video Support

    AsyncFunction("reportVideo") { (id: String, enabled: Bool) in
      guard let uuid = UUID(uuidString: id) else {
        throw Exception(
          name: "InvalidUUID",
          description: "Invalid call ID: \(id)"
        )
      }

      await CallManager.shared.reportVideo(for: uuid, enabled: enabled)
    }

    // MARK: - Hold Support

    AsyncFunction("setHeld") { (id: String, onHold: Bool) in
      guard let uuid = UUID(uuidString: id) else {
        throw Exception(
          name: "InvalidUUID",
          description: "Invalid call ID: \(id)"
        )
      }

      try await CallManager.shared.setHeld(for: uuid, onHold: onHold)
    }

    // MARK: - DTMF Support

    AsyncFunction("playDTMF") { (id: String, digits: String) in
      guard let uuid = UUID(uuidString: id) else {
        throw Exception(
          name: "InvalidUUID",
          description: "Invalid call ID: \(id)"
        )
      }

      try await CallManager.shared.playDTMF(for: uuid, digits: digits)
    }

    // MARK: - VoIP Push

    Function("configurePushPayloadProfiles") { (profilesJson: String) in
      try PushPayloadProfileStore.save(json: profilesJson)
    }

    Function("getPushPayloadProfilesJson") { () -> String? in
      PushPayloadProfileStore.read()
    }

    Function("registerVoIPPush") {
      Task { @MainActor in
        VoIPPushManager.shared.register()
      }
    }

    Function("getVoIPPushToken") { () -> [String: Any?] in
      return [
        "token": VoIPPushManager.shared.token as Any?,
        "type": "APNS_VOIP",
      ]
    }

  }
}
