import Foundation
import os

/// Manages pending fulfill requests with automatic timeout handling.
///
/// When a CallKit action requires asynchronous fulfillment (e.g., waiting for JS
/// to connect media), this manager tracks the pending request with a unique ID
/// and handles timeouts gracefully.
///
/// Usage:
/// 1. Create a request with `createRequest(callId:timeout:)`
/// 2. Send the request ID to JS via an event
/// 3. When JS calls back, use `fulfill(requestId:)` to complete or no-op if timed out
/// 4. Await the result task to get the outcome
actor FulfillRequestManager {
  /// Shared instance for global access.
  static let shared = FulfillRequestManager()

  /// Result of a fulfill request.
  enum Result {
    /// The request was successfully fulfilled, includes the associated call ID.
    case fulfilled(callId: UUID)
    /// The request was explicitly cancelled (e.g., JS-side failure before fulfilling).
    case cancelled
    /// The request timed out before being fulfilled.
    case timedOut
  }

  /// A pending request awaiting fulfillment.
  private struct PendingRequest {
    let id: UUID
    let callId: UUID
    let createdAt: Date
    let continuation: AsyncStream<Result>.Continuation
    let timeoutTask: Task<Void, Never>
  }

  /// Active pending requests keyed by request ID.
  private var pendingRequests: [UUID: PendingRequest] = [:]

  private init() {}

  /// Creates a new pending request with the specified call ID and timeout.
  ///
  /// - Parameters:
  ///   - callId: The UUID of the call associated with this request.
  ///   - timeout: Duration before the request automatically times out.
  /// - Returns: A tuple containing the request ID and a task that resolves
  ///   when the request is fulfilled or times out.
  func createRequest(callId: UUID, timeout: Duration) -> (
    requestId: UUID, result: Task<Result, Never>
  ) {
    let requestId = UUID()

    let (stream, continuation) = AsyncStream<Result>.makeStream(bufferingPolicy: .bufferingNewest(1))
    let timeoutTask = Task { [weak self] in
      try? await Task.sleep(for: timeout)
      guard !Task.isCancelled, let self else { return }
      if let request = await self.removeRequest(for: requestId) {
        request.continuation.yield(.timedOut)
        request.continuation.finish()
      }
    }
    // Install before returning the request ID or emitting CallAnsweredEvent.
    pendingRequests[requestId] = PendingRequest(
      id: requestId, callId: callId, createdAt: Date(),
      continuation: continuation, timeoutTask: timeoutTask
    )
    let resultTask = Task<Result, Never> {
      for await result in stream { return result }
      return .cancelled
    }

    return (requestId, resultTask)
  }

  /// Attempts to fulfill a pending request.
  ///
  /// If the request exists, it will be fulfilled and removed. If the request
  /// has already timed out or was never created, this is a no-op.
  ///
  /// - Parameter requestId: The unique ID of the request to fulfill.
  /// - Returns: The associated call ID if fulfilled, nil if not found.
  func fulfill(requestId: UUID) -> UUID? {
    guard let request = pendingRequests.removeValue(forKey: requestId) else {
      Log.call.debug("Fulfill request not found (likely timed out) - requestId: \(requestId)")
      return nil
    }

    // Cancel the timeout task since we're fulfilling
    request.timeoutTask.cancel()

    Log.call.debug("Fulfill request succeeded - requestId: \(requestId), callId: \(request.callId)")
    request.continuation.yield(.fulfilled(callId: request.callId))
    request.continuation.finish()
    return request.callId
  }

  /// Cancels a pending request without fulfilling it.
  ///
  /// Use this when the request should be aborted (e.g., call ended before connection).
  ///
  /// - Parameter requestId: The unique ID of the request to cancel.
  func cancel(requestId: UUID) {
    guard let request = pendingRequests.removeValue(forKey: requestId) else {
      return
    }

    request.timeoutTask.cancel()
    Log.call.debug("Fulfill request cancelled - requestId: \(requestId)")
    request.continuation.yield(.cancelled)
    request.continuation.finish()
  }

  func callId(for requestId: UUID) -> UUID? {
    pendingRequests[requestId]?.callId
  }

  func cancel(callId: UUID) {
    let ids = pendingRequests.values.filter { $0.callId == callId }.map { $0.id }
    for id in ids { cancel(requestId: id) }
  }

  /// Cancels all pending requests.
  ///
  /// Use this when cleaning up (e.g., provider reset).
  func cancelAll() {
    let requests = pendingRequests
    pendingRequests.removeAll()

    for (id, request) in requests {
      request.timeoutTask.cancel()
      Log.call.debug("Fulfill request cancelled (cancelAll) - requestId: \(id)")
      request.continuation.yield(.cancelled)
      request.continuation.finish()
    }
  }

  // MARK: - Private Helpers

  private func removeRequest(for requestId: UUID) -> PendingRequest? {
    pendingRequests.removeValue(forKey: requestId)
  }
}
