import Foundation

struct NormalizedCallPush: Sendable {
  let profileId: String
  let event: String
  let callId: String
  let hasCallId: Bool
  let accountId: String?
  let callerName: String?
  let callerHandle: String
  let expiresAt: String?
  let revision: Int?
}

/// Declarative push mappings persisted for use during terminated-state PushKit delivery.
enum PushPayloadProfileStore {
  private static let key = "ExpoCallKitTelecom.PushPayloadProfiles"

  static func save(json: String) throws {
    let data = Data(json.utf8)
    guard let profiles = try JSONSerialization.jsonObject(with: data) as? [[String: Any]],
      !profiles.isEmpty
    else {
      throw NSError(domain: "ExpoCallKitTelecom", code: 1, userInfo: [
        NSLocalizedDescriptionKey: "At least one push payload profile is required"
      ])
    }
    UserDefaults.standard.set(json, forKey: key)
  }

  static func read() -> String? {
    UserDefaults.standard.string(forKey: key)
  }

  static func normalize(payload: [AnyHashable: Any]) -> NormalizedCallPush? {
    guard let saved = read(), let data = saved.data(using: .utf8),
      let profiles = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]]
    else { return nil }
    let root = Dictionary(uniqueKeysWithValues: payload.map { (String(describing: $0.key), $0.value) })
    for profile in profiles where matches(profile["match"] as? [[String: Any]], payload: root) {
      if let normalized = normalize(profile: profile, payload: root) { return normalized }
    }
    return nil
  }

  private static func normalize(profile: [String: Any], payload: [String: Any]) -> NormalizedCallPush? {
    guard let id = profile["id"] as? String,
      let fields = profile["fields"] as? [String: Any],
      let eventField = fields["event"] as? [String: Any],
      let values = eventField["values"] as? [String: Any],
      let rawEvent = resolve(eventField, payload: payload).map({ String(describing: $0) }),
      let event = values[rawEvent] as? String,
      let callIdField = fields["callId"] as? [String: Any],
      let callerField = fields["callerHandle"] as? [String: Any]
    else { return nil }
    let resolvedCallId = resolve(callIdField, payload: payload).map({ String(describing: $0) })
    let callId = resolvedCallId?.isEmpty == false ? resolvedCallId! : (event == "incoming" ? UUID().uuidString.lowercased() : "")
    guard !callId.isEmpty else { return nil }
    let resolvedCaller = resolve(callerField, payload: payload).map({ String(describing: $0) })
    if resolvedCaller == nil, callerField["required"] as? Bool == true { return nil }
    let callerHandle = resolvedCaller ?? callId
    return NormalizedCallPush(
      profileId: id,
      event: event,
      callId: callId,
      hasCallId: resolvedCallId?.isEmpty == false,
      accountId: optionalString(fields["accountId"], payload: payload),
      callerName: optionalString(fields["callerName"], payload: payload),
      callerHandle: callerHandle,
      expiresAt: optionalString(fields["expiresAt"], payload: payload),
      revision: optionalString(fields["revision"], payload: payload).flatMap(Int.init)
    )
  }

  private static func matches(_ rules: [[String: Any]]?, payload: [String: Any]) -> Bool {
    guard let rules else { return true }
    return rules.allSatisfy { rule in
      guard let path = rule["path"] as? String else { return false }
      return scalarEquals(resolvePath(payload, path: path), rule["equals"])
    }
  }

  private static func resolve(_ mapping: [String: Any], payload: [String: Any]) -> Any? {
    let value: Any?
    if mapping.keys.contains("constant") { value = mapping["constant"] }
    else if let path = mapping["path"] as? String { value = resolvePath(payload, path: path) }
    else { value = nil }
    return value ?? mapping["defaultValue"]
  }

  private static func resolvePath(_ payload: [String: Any], path: String) -> Any? {
    var current: Any = payload
    for segment in path.split(separator: ".").map(String.init) {
      current = decodeJSONObjectIfNeeded(current)
      if let dictionary = current as? [String: Any], let next = dictionary[segment] { current = next }
      else if let dictionary = current as? [AnyHashable: Any], let next = dictionary[segment] { current = next }
      else { return nil }
    }
    return current
  }

  private static func decodeJSONObjectIfNeeded(_ value: Any) -> Any {
    guard let string = value as? String else { return value }
    if let data = string.data(using: .utf8),
      let decoded = try? JSONSerialization.jsonObject(with: data),
      decoded is [String: Any] || decoded is [Any]
    {
      return decoded
    }
    if let data = Data(base64Encoded: string),
      let decoded = try? JSONSerialization.jsonObject(with: data),
      decoded is [String: Any] || decoded is [Any]
    {
      return decoded
    }
    return value
  }

  private static func optionalString(_ value: Any?, payload: [String: Any]) -> String? {
    guard let mapping = value as? [String: Any], let resolved = resolve(mapping, payload: payload) else { return nil }
    return String(describing: resolved)
  }

  private static func scalarEquals(_ lhs: Any?, _ rhs: Any?) -> Bool {
    guard let lhs, let rhs else { return lhs == nil && rhs == nil }
    return String(describing: lhs) == String(describing: rhs)
  }
}
