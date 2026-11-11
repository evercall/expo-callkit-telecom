import Foundation
import CallKit
import PushKit

extension VoIPPushManager: PKPushRegistryDelegate {
  /// Called when push credentials are updated.
  ///
  /// Converts the token data to a hex string and stores it for JS access.
  nonisolated func pushRegistry(
    _ registry: PKPushRegistry,
    didUpdate pushCredentials: PKPushCredentials,
    for type: PKPushType
  ) {
    guard type == .voIP else { return }

    let tokenData = pushCredentials.token
    let tokenString = tokenData.map { String(format: "%02x", $0) }.joined()

    Task { @MainActor in
      updateToken(tokenString)
    }
  }

  /// Called when push credentials are invalidated.
  ///
  /// Clears the stored token and notifies JS.
  nonisolated func pushRegistry(
    _ registry: PKPushRegistry,
    didInvalidatePushTokenFor type: PKPushType
  ) {
    guard type == .voIP else { return }

    Log.voipPush.debug("VoIP push token invalidated")

    Task { @MainActor in
      updateToken(nil)
    }
  }

  /// Called when a VoIP push notification is received.
  ///
  /// This method MUST report a call to CallKit before returning, per Apple's requirements.
  /// The payload is expected to wrap an `IncomingCallEvent` under the top-level
  /// key `"incomingCall"`, matching `IncomingCallEventParser`.
  ///
  /// - Parameters:
  ///   - registry: The push registry.
  ///   - payload: The push payload containing the incoming call event.
  ///   - type: The push type (should be .voIP).
  ///   - completion: Completion handler that must be called after processing.
  nonisolated func pushRegistry(
    _ registry: PKPushRegistry,
    didReceiveIncomingPushWith payload: PKPushPayload,
    for type: PKPushType,
    completion: @escaping () -> Void
  ) {
    guard type == .voIP else {
      completion()
      return
    }

    let dictionaryPayload = payload.dictionaryPayload

    Log.voipPush.debug("Received VoIP push - payload keys: \(dictionaryPayload.keys)")

    if let normalized = PushPayloadProfileStore.normalize(payload: dictionaryPayload) {
      processNormalizedPush(normalized, completion: completion)
      return
    }

    guard let parsedEvent = IncomingCallEventParser.parse(from: dictionaryPayload) else {
      Log.voipPush.error("Failed to parse VoIP push payload as IncomingCallEvent")
      // We must still report a call to CallKit even on parse failure, or the
      // app will be terminated.
      reportFailedIncomingCall(completion: completion)
      return
    }

    var metadata = parsedEvent.metadata ?? [:]
    metadata["incomingSource"] = "push"
    metadata["pushHasCallId"] = true
    let event = IncomingCallEvent(
      eventId: parsedEvent.eventId, serverCallId: parsedEvent.serverCallId,
      caller: parsedEvent.caller, hasVideo: parsedEvent.hasVideo,
      startedAt: parsedEvent.startedAt, metadata: metadata
    )

    Log.voipPush.debug(
      "Parsed incoming call event - serverCallId: \(event.serverCallId)"
    )

    // Report the incoming call to CallKit using callback-based API
    // (async/await may not work reliably when app is launched from terminated state)
    CallManager.shared.reportIncomingCall(event: event) { error in
      if let error = error {
        Log.voipPush.error("Failed to report incoming call: \(error.localizedDescription)")
      } else {
        Log.voipPush.debug("Successfully reported incoming call from VoIP push")
      }
      completion()
    }
  }

  private nonisolated func processNormalizedPush(
    _ push: NormalizedCallPush,
    completion: @escaping () -> Void
  ) {
    if push.event != "incoming" {
      if push.hasCallId {
        IncomingCallRegistry.shared.cancelPush(
          serverCallId: push.callId, handle: push.callerHandle, accountId: push.accountId
        )
      }
      Task {
        let sessions = await CallManager.shared.store.allSessions
        if let session = sessions.first(where: {
          $0.incomingCallEvent?.serverCallId == push.callId
        }) {
          let reason: CXCallEndedReason =
            push.event == "answeredElsewhere" ? .answeredElsewhere : .remoteEnded
          await CallManager.shared.reportCallEnded(for: session.id, reason: reason)
        }
        completion()
      }
      return
    }

    let caller = IncomingCallEvent.Caller(
      id: push.callerHandle,
      displayName: push.callerName,
      avatarUrl: nil,
      phoneNumber: push.callerHandle.contains("@") ? nil : push.callerHandle,
      email: push.callerHandle.contains("@") ? push.callerHandle : nil
    )
    var metadata: [String: Any] = [
      "profileId": push.profileId, "incomingSource": "push", "pushHasCallId": push.hasCallId
    ]
    if let expiresAt = push.expiresAt { metadata["expiresAt"] = expiresAt }
    if let accountId = push.accountId {
      metadata["accountId"] = accountId
    }
    let event = IncomingCallEvent(
      eventId: "\(push.profileId):\(push.callId):\(push.revision ?? 0)",
      serverCallId: push.callId,
      caller: caller,
      hasVideo: false,
      startedAt: Date(),
      metadata: metadata
    )
    CallManager.shared.reportIncomingCall(event: event) { error in
      if let error {
        Log.voipPush.error("Failed to report normalized incoming call: \(error.localizedDescription)")
      }
      completion()
    }
  }

  /// Reports a failed incoming call to CallKit when we can't parse the push payload.
  ///
  /// Per Apple's requirements, we must report a call to CallKit when receiving a VoIP push.
  /// If we can't parse the payload, we report a call and immediately end it.
  private nonisolated func reportFailedIncomingCall(completion: @escaping () -> Void) {
    let fallbackEvent = IncomingCallEvent(
      eventId: UUID().uuidString.lowercased(),
      serverCallId: UUID().uuidString.lowercased(),
      caller: IncomingCallEvent.Caller(
        id: UUID().uuidString,
        displayName: nil,
        avatarUrl: nil,
        phoneNumber: nil,
        email: nil
      ),
      hasVideo: false,
      startedAt: Date(),
      metadata: nil
    )

    // Use callback-based API for reliability when app is launched from terminated state
    CallManager.shared.reportIncomingCall(event: fallbackEvent) { error in
      if let error = error {
        Log.voipPush.error("Failed to report fallback incoming call: \(error.localizedDescription)")
      }
      // Immediately end the call since it's invalid
      Task {
        let sessions = await CallManager.shared.store.allSessions
        if let session = sessions.first(where: {
          $0.incomingCallEvent?.serverCallId == fallbackEvent.serverCallId
        }) {
          await CallManager.shared.reportCallEnded(for: session.id, reason: .failed)
        }
      }
      completion()
    }
  }
}
