import Foundation

/// Native authority for incoming-call admission. CallKit and JS may start in either order.
/// Generated push IDs are local identities, never SIP correlation IDs.
final class IncomingCallRegistry: @unchecked Sendable {
  static let shared = IncomingCallRegistry()
  static let terminalHandleWindow: TimeInterval = 5
  private static let retention: TimeInterval = 86_400
  private static let storageKey = "ExpoCallKitTelecom.IncomingCalls.v1"

  struct Entry: Codable {
    let id: UUID
    let serverCallId: String?
    let handle: String
    let accountId: String?
    let isPush: Bool
    let receivedAt: Date
    let ringingDeadline: Date
    var answerDeadline: Date?
    var sipCallId: String?
    var connected = false
    var terminalAt: Date?
  }

  private let lock = NSLock()
  private let defaults: UserDefaults
  private var entries: [Entry]

  init(defaults: UserDefaults = .standard, now: Date = Date()) {
    self.defaults = defaults
    let data = defaults.data(forKey: Self.storageKey) ?? Data()
    entries = (try? JSONDecoder().decode([Entry].self, from: data)) ?? []
    // CallKit sessions cannot be reconstructed from a previous process's UUIDs.
    for index in entries.indices where entries[index].terminalAt == nil {
      entries[index].terminalAt = min(now, entries[index].answerDeadline ?? entries[index].ringingDeadline)
    }
    persist(now: now)
  }

  static func normalizeHandle(_ handle: String) -> String {
    let trimmed = handle.trimmingCharacters(in: .whitespacesAndNewlines)
    // Do not collapse SIP domains, extension prefixes, or international prefixes.
    let numeric = trimmed.filter { !$0.isWhitespace && $0 != "-" && $0 != "(" && $0 != ")" }
    if !numeric.isEmpty && numeric.allSatisfy({ $0.isNumber || $0 == "+" }) {
      return numeric
    }
    return trimmed
  }

  func register(id: UUID, serverCallId: String?, handle: String, accountId: String?,
                isPush: Bool, receivedAt: Date, ringingDeadline: Date) {
    lock.lock()
    defer { lock.unlock() }
    entries.append(Entry(id: id, serverCallId: serverCallId, handle: Self.normalizeHandle(handle),
                         accountId: accountId, isPush: isPush, receivedAt: receivedAt,
                         ringingDeadline: ringingDeadline))
    persist(now: receivedAt)
  }

  func existingPushId(serverCallId: String, accountId: String?) -> UUID? {
    lock.lock()
    defer { lock.unlock() }
    persist(now: Date())
    return entries.first { $0.isPush && $0.serverCallId == serverCallId && $0.accountId == accountId }?.id
  }

  func cancelPush(serverCallId: String, handle: String, accountId: String?, now: Date = Date()) {
    lock.lock()
    defer { lock.unlock() }
    let matches = entries.indices.filter {
      entries[$0].serverCallId == serverCallId &&
        (entries[$0].accountId == nil || entries[$0].accountId == accountId)
    }
    if matches.isEmpty {
      var entry = Entry(id: UUID(), serverCallId: serverCallId, handle: Self.normalizeHandle(handle),
                        accountId: accountId, isPush: true, receivedAt: now, ringingDeadline: now)
      entry.terminalAt = now
      entries.append(entry)
    }
    for index in matches where entries[index].terminalAt == nil { entries[index].terminalAt = now }
    persist(now: now)
  }

  func ringingTimeRemaining(id: UUID, now: Date = Date()) -> TimeInterval? {
    lock.lock()
    defer { lock.unlock() }
    guard let entry = entries.first(where: { $0.id == id }), entry.terminalAt == nil,
          entry.answerDeadline == nil, !entry.connected else { return nil }
    return max(0, entry.ringingDeadline.timeIntervalSince(now))
  }

  func beginAnswer(id: UUID, timeout: TimeInterval, now: Date = Date()) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    guard let index = entries.firstIndex(where: { $0.id == id }),
          isLive(entries[index], now: now), !entries[index].connected else { return false }
    if entries[index].answerDeadline == nil {
      entries[index].answerDeadline = now.addingTimeInterval(timeout)
    }
    persist(now: now)
    return true
  }

  func validate(id: UUID, sipCallId: String? = nil, answering: Bool = false,
                now: Date = Date()) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    guard let entry = entries.first(where: { $0.id == id }), isLive(entry, now: now) else {
      return false
    }
    if answering && entry.answerDeadline == nil { return false }
    if let sipCallId, entry.sipCallId != sipCallId { return false }
    return true
  }

  func connected(id: UUID) {
    lock.lock()
    defer { lock.unlock() }
    guard let index = entries.firstIndex(where: { $0.id == id }) else { return }
    guard entries[index].terminalAt == nil else { return }
    entries[index].connected = true
    persist(now: Date())
  }

  func end(id: UUID, now: Date = Date()) {
    lock.lock()
    defer { lock.unlock() }
    guard let index = entries.firstIndex(where: { $0.id == id }) else { return }
    if entries[index].terminalAt == nil { entries[index].terminalAt = now }
    persist(now: now)
  }

  /// Serialized claim: exact IDs take priority; only ID-less pushes use handle/time.
  func claim(sipCallId: String, handle: String, accountId: String?, now: Date = Date()) -> [String: String] {
    lock.lock()
    defer { lock.unlock() }
    persist(now: now)
    let accountMatches: (Entry) -> Bool = { entry in
      entry.accountId == nil || entry.accountId == accountId
    }
    let exact = entries.indices.filter {
      accountMatches(entries[$0]) &&
        (entries[$0].serverCallId == sipCallId || entries[$0].sipCallId == sipCallId)
    }
    let normalized = Self.normalizeHandle(handle)
    let fallback = entries.indices.filter {
      let entry = entries[$0]
      guard entry.isPush, entry.serverCallId == nil, entry.sipCallId == nil,
            entry.handle == normalized, accountMatches(entry) else { return false }
      let end = entry.terminalAt ?? entry.answerDeadline ?? entry.ringingDeadline
      return isLive(entry, now: now) ||
        (now >= end && now.timeIntervalSince(end) <= Self.terminalHandleWindow)
    }
    let liveFallback = fallback.filter { isLive(entries[$0], now: now) }
    let handleMatches = liveFallback.isEmpty ? fallback : liveFallback
    let matches = exact.isEmpty ? handleMatches : exact
    guard !matches.isEmpty else { return ["decision": "new"] }
    guard matches.count == 1, let index = matches.first else {
      return ["decision": "reject", "reason": "ambiguous"]
    }
    let entry = entries[index]
    guard isLive(entry, now: now) else {
      return ["decision": "reject", "reason": "expired", "nativeCallId": entry.id.uuidString]
    }
    guard !entry.connected, entry.sipCallId == nil else {
      return ["decision": "reject", "reason": "claimed", "nativeCallId": entry.id.uuidString]
    }
    entries[index].sipCallId = sipCallId
    persist(now: now)
    return ["decision": "matched", "nativeCallId": entry.id.uuidString]
  }

  private func isLive(_ entry: Entry, now: Date) -> Bool {
    entry.terminalAt == nil && (entry.connected || now < (entry.answerDeadline ?? entry.ringingDeadline))
  }

  private func persist(now: Date) {
    entries.removeAll { ($0.terminalAt != nil || !$0.connected) && now.timeIntervalSince($0.terminalAt ?? $0.receivedAt) > Self.retention }
    // Never evict a live call to make room for historical records.
    let terminal = entries.filter { $0.terminalAt != nil }.suffix(256)
    entries = entries.filter { $0.terminalAt == nil } + terminal
    if let data = try? JSONEncoder().encode(entries) { defaults.set(data, forKey: Self.storageKey) }
  }
}
