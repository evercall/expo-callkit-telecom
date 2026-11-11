// macOS: compile the production native registry and fulfill manager with a controlled clock.
const assert = require("node:assert/strict");
const { mkdtempSync, writeFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");

test("native incoming-call correlation, deadlines, persistence and answer fulfillment", {
  skip: process.platform !== "darwin",
}, () => {
  const folder = mkdtempSync(join(tmpdir(), "callkit-incoming-test-"));
  const harness = `
import Foundation
struct Logger { func debug(_ message: String) {} }
enum Log { static let call = Logger() }
@main struct Tests {
  static func main() async {
    let suite = "IncomingCallTests." + UUID().uuidString
    let defaults = UserDefaults(suiteName: suite)!
    defer { defaults.removePersistentDomain(forName: suite) }
    let base = Date()
    func fresh() -> IncomingCallRegistry {
      defaults.removePersistentDomain(forName: suite)
      return IncomingCallRegistry(defaults: defaults, now: base)
    }
    func add(_ registry: IncomingCallRegistry, server: String? = nil, handle: String = "800",
             account: String? = "804", isPush: Bool = true, deadline: TimeInterval = 45) -> UUID {
      let id = UUID()
      registry.register(id: id, serverCallId: server, handle: handle, accountId: account,
                        isPush: isPush, receivedAt: base, ringingDeadline: base.addingTimeInterval(deadline))
      return id
    }
    func claim(_ registry: IncomingCallRegistry, sip: String = "sip-id", handle: String = "800",
               account: String? = "804", at: TimeInterval = 1) -> [String: String] {
      registry.claim(sipCallId: sip, handle: handle, accountId: account, now: base.addingTimeInterval(at))
    }
    func expect(_ condition: @autoclosure () -> Bool, _ name: String) {
      precondition(condition(), name)
    }
    var registry = fresh()
    let idless = add(registry)
    expect(claim(registry)["nativeCallId"] == idless.uuidString, "ID-less push reuses its native UUID")
    expect(claim(registry)["decision"] == "reject", "A native call is claimed once")
    expect(claim(registry, sip: "different")["decision"] == "new", "Claimed calls do not consume fresh calls")

    registry = fresh()
    let exact = add(registry, server: "real-id", handle: "different")
    _ = add(registry)
    expect(claim(registry, sip: "real-id")["nativeCallId"] == exact.uuidString, "Exact ID wins over handle")
    registry = fresh()
    _ = add(registry, server: "real-id")
    expect(claim(registry, sip: "wrong-id")["decision"] == "new", "A real ID never falls back to handle")
    expect(claim(registry, sip: "real-id", at: 46)["decision"] == "reject", "Expired real IDs are rejected")
    expect(claim(registry, account: "999")["decision"] == "new", "Accounts remain separate")

    registry = fresh()
    _ = add(registry)
    _ = add(registry)
    expect(claim(registry)["reason"] == "ambiguous", "Overlapping identical callers are explicit ambiguity")
    registry = fresh()
    _ = add(registry, handle: "+45 12-34 (56)")
    expect(claim(registry, handle: "+45123456")["decision"] == "matched", "Conservative phone formatting normalization")
    expect(IncomingCallRegistry.normalizeHandle("800@a") != IncomingCallRegistry.normalizeHandle("800@b"), "Domains remain distinct")

    registry = fresh()
    let answered = add(registry)
    expect(registry.beginAnswer(id: answered, timeout: 30, now: base.addingTimeInterval(40)), "Answer before ringing expiry")
    expect(registry.beginAnswer(id: answered, timeout: 30, now: base.addingTimeInterval(50)), "Duplicate answer does not extend deadline")
    expect(registry.ringingTimeRemaining(id: answered) == nil, "Answer disables ringing timeout")
    expect(claim(registry, at: 60)["decision"] == "matched", "Answered call has a separate connection window")
    expect(!registry.validate(id: answered, now: base.addingTimeInterval(70)), "Connection deadline remains fixed")
    expect(!registry.beginAnswer(id: answered, timeout: 30, now: base.addingTimeInterval(71)), "Expired answer cannot restart")

    registry = fresh()
    let declined = add(registry)
    registry.end(id: declined, now: base.addingTimeInterval(2))
    expect(claim(registry, at: 3)["decision"] == "reject", "Decline during registration rejects late INVITE")
    expect(claim(registry, sip: "fresh", at: 8)["decision"] == "new", "Terminal handle window does not blacklist a caller")
    let freshId = add(registry)
    expect(claim(registry, sip: "fresh", at: 3)["nativeCallId"] == freshId.uuidString, "A fresh push takes precedence over old terminal handle")

    registry = fresh()
    let expiring = add(registry)
    expect(!registry.beginAnswer(id: expiring, timeout: 30, now: base.addingTimeInterval(45)), "Late native answer rejected")
    expect(claim(registry, at: 46)["decision"] == "reject", "Expiry works without timer execution")
    expect(claim(registry, at: 51)["decision"] == "new", "Unknown old ID-less INVITE cannot be classified indefinitely")

    registry = fresh()
    let connected = add(registry)
    _ = registry.beginAnswer(id: connected, timeout: 30, now: base)
    registry.connected(id: connected)
    expect(registry.validate(id: connected, now: base.addingTimeInterval(100_000)), "Established calls outlive incoming deadlines")

    registry = fresh()
    let persistent = add(registry, server: "persistent-id")
    registry.end(id: persistent, now: base.addingTimeInterval(2))
    let restored = IncomingCallRegistry(defaults: defaults, now: base.addingTimeInterval(100))
    expect(claim(restored, sip: "persistent-id", at: 101)["decision"] == "reject", "Terminal exact ID survives process restart")
    registry = fresh()
    _ = add(registry, server: "old-process")
    let restarted = IncomingCallRegistry(defaults: defaults, now: base.addingTimeInterval(100))
    expect(claim(restarted, sip: "old-process", at: 101)["decision"] == "reject", "Previous-process native UUID is not resurrected")

    registry = fresh()
    let duplicate = add(registry, server: "duplicate")
    expect(registry.existingPushId(serverCallId: "duplicate", accountId: "804") == duplicate, "Duplicate real-ID push reuses original deadline and UUID")
    _ = add(registry, server: "sip-only", isPush: false)
    expect(registry.existingPushId(serverCallId: "sip-only", accountId: "804") == nil, "SIP calls are not push records")

    registry = fresh()
    registry.cancelPush(serverCallId: "cancel-first", handle: "800", accountId: "804", now: base)
    expect(claim(registry, sip: "cancel-first")["decision"] == "reject", "Cancellation before incoming push retains exact-ID tombstone")

    // Exercise the real payload profile parser with the production legacy envelope.
    let oldProfiles = PushPayloadProfileStore.read()
    defer {
      if let oldProfiles { try! PushPayloadProfileStore.save(json: oldProfiles) }
      else { UserDefaults.standard.removeObject(forKey: "ExpoCallKitTelecom.PushPayloadProfiles") }
    }
    let profile = #"[{"id":"legacy","fields":{"event":{"constant":"incoming","values":{"incoming":"incoming"}},"callId":{"path":"items.callId"},"callerHandle":{"path":"items.handle"},"accountId":{"path":"items.calleeNumber"}}}]"#
    try! PushPayloadProfileStore.save(json: profile)
    let payload: [AnyHashable: Any] = ["type": "PKPushTypeVoIP", "items": ["handle": "800", "callerName": "800", "calleeNumber": "804"]]
    let normalized = PushPayloadProfileStore.normalize(payload: payload)!
    expect(!normalized.hasCallId && !normalized.callId.isEmpty, "Generated ID remains marked as local")
    expect(normalized.accountId == "804", "Legacy callee scopes correlation")
    let futurePayload: [AnyHashable: Any] = ["items": ["handle": "800", "callId": "backend-sip-id"]]
    let future = PushPayloadProfileStore.normalize(payload: futurePayload)!
    expect(future.hasCallId && future.callId == "backend-sip-id", "Future backend ID remains exact")

    let manager = FulfillRequestManager.shared
    let pending = await manager.createRequest(callId: duplicate, timeout: .seconds(30))
    let pendingId = await manager.callId(for: pending.requestId)
    expect(pendingId == duplicate, "Request exists before its ID is exposed")
    await manager.cancel(callId: duplicate)
    if case .cancelled = await pending.result.value {} else { fatalError("Cancellation must resolve pending answer") }
    let fast = await manager.createRequest(callId: duplicate, timeout: .seconds(30))
    let fulfilledId = await manager.fulfill(requestId: fast.requestId)
    expect(fulfilledId == duplicate, "Immediate fulfillment cannot race registration")
    if case .fulfilled = await fast.result.value {} else { fatalError("Answer must fulfill") }
    let timed = await manager.createRequest(callId: duplicate, timeout: .milliseconds(1))
    if case .timedOut = await timed.result.value {} else { fatalError("Answer must time out") }
    let expiredId = await manager.fulfill(requestId: timed.requestId)
    expect(expiredId == nil, "Timed-out answer cannot fulfill later")
    print("Native incoming-call assertions passed")
  }
}
`;
  try {
    const source = join(folder, "Harness.swift");
    const binary = join(folder, "test-incoming");
    writeFileSync(source, harness);
    const compile = spawnSync("swiftc", [
      "-parse-as-library", resolve(__dirname, "../../../ios/Stores/IncomingCallRegistry.swift"),
      resolve(__dirname, "../../../ios/Managers/FulfillRequestManager.swift"),
      resolve(__dirname, "../../../ios/Managers/PushPayloadProfileStore.swift"), source, "-o", binary,
    ], { encoding: "utf8" });
    assert.equal(compile.status, 0, compile.stdout + compile.stderr);
    const run = spawnSync(binary, [], { encoding: "utf8", timeout: 15000 });
    assert.equal(run.status, 0, run.stdout + run.stderr);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
