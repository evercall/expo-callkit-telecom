// macOS only: node --test src/telephony/__tests__/IosAudioLifecycle.test.cjs
// Execute the production Swift callbacks against fake OS/RTC objects. Device
// activation and actual audio rendering still require a physical iPhone.
const assert = require("node:assert/strict");
const { readFileSync, writeFileSync, mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { resolve, join } = require("node:path");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");

const source = readFileSync(resolve(__dirname, "../../../ios/Managers/AudioManager.swift"), "utf8");
const method = (name) => {
	const start = source.indexOf(`  func ${name}(`);
	assert.ok(start >= 0, `Missing production method ${name}`);
	const open = source.indexOf("{", start);
	let depth = 1;
	let end = open + 1;
	while (depth && end < source.length) {
		if (source[end] === "{") depth++;
		if (source[end] === "}") depth--;
		end++;
	}
	assert.equal(depth, 0);
	return source.slice(start, end);
};

test("native hold/resume keeps call configuration and restores it only after the last call ends", {
	skip: process.platform !== "darwin",
}, () => {
	const folder = mkdtempSync(join(tmpdir(), "callkit-audio-test-"));
	const harness = `
import Foundation
struct CallOptions { var hasVideo = false }
struct CallSession {
  enum Status { case connected, ended }
  var status: Status = .connected
  var options = CallOptions()
}
final class AVAudioSession {
  static let instance = AVAudioSession()
  static func sharedInstance() -> AVAudioSession { instance }
}
final class RTCAudioSession {
  static let instance = RTCAudioSession()
  static func sharedInstance() -> RTCAudioSession { instance }
  var isAudioEnabled = false
  var activationCheck: (() -> Void)?
  func audioSessionDidActivate(_ session: AVAudioSession) { activationCheck?() }
  func audioSessionDidDeactivate(_ session: AVAudioSession) {}
}
struct AudioSessionCallInfo { init(from: CallSession) {} }
struct AudioSessionActivatedEvent { let calls: [AudioSessionCallInfo] }
struct AudioSessionDeactivatedEvent { let calls: [AudioSessionCallInfo] }
final class CallEventEmitter {
  static let shared = CallEventEmitter()
  func send<T>(_ event: T) {}
}
struct Logger { func debug(_ message: String) {} }
enum Log { static let audio = Logger() }
final class Manager {
  var isActive = false
  var category = "ambient"
  var savedCategory: String?
  var video = false
  var restoreCount = 0
  func prepareAudioSessionForCall(hasVideo: Bool) {
    if savedCategory == nil { savedCategory = category }
    category = "playAndRecord"
    video = hasVideo
  }
  func restoreAudioSession() {
    if let savedCategory {
      category = savedCategory
      self.savedCategory = nil
      restoreCount += 1
    }
  }
${method("onAVAudioSessionActivated")}
${method("onAVAudioSessionDeactivated")}
}
let manager = Manager()
let call = CallSession()
manager.prepareAudioSessionForCall(hasVideo: false)
RTCAudioSession.instance.activationCheck = {
  precondition(manager.category == "playAndRecord", "RTC activation preceded call configuration")
}
manager.onAVAudioSessionActivated(calls: [call])
for _ in 0..<3 {
  manager.onAVAudioSessionDeactivated(calls: [call])
  precondition(!manager.isActive && !RTCAudioSession.instance.isAudioEnabled)
  precondition(manager.category == "playAndRecord", "Hold restored ambient category")
  precondition(manager.savedCategory == "ambient", "Hold lost original snapshot")
  // Another audio client can disturb the category during an interruption.
  manager.category = "playback"
  manager.onAVAudioSessionActivated(calls: [call])
  precondition(manager.isActive && RTCAudioSession.instance.isAudioEnabled)
  precondition(manager.savedCategory == "ambient", "Resume overwrote original snapshot")
}
var ended = call
ended.status = .ended
manager.onAVAudioSessionDeactivated(calls: [ended, call])
precondition(manager.restoreCount == 0, "Ending one call restored audio while another remains")
manager.onAVAudioSessionDeactivated(calls: [ended])
precondition(manager.category == "ambient" && manager.savedCategory == nil)
precondition(manager.restoreCount == 1)
var videoCall = CallSession()
videoCall.options.hasVideo = true
manager.onAVAudioSessionActivated(calls: [ended, videoCall])
precondition(manager.video, "Resume lost video configuration")
manager.onAVAudioSessionDeactivated(calls: [])
precondition(manager.restoreCount == 2 && manager.category == "ambient")
print("Native audio lifecycle checks passed")
`;
	try {
		const filename = join(folder, "Lifecycle.swift");
		writeFileSync(filename, harness);
		const result = spawnSync("swift", ["-swift-version", "5", "-module-cache-path", join(folder, "cache"), filename], {
			encoding: "utf8", timeout: 60000,
		});
		assert.equal(result.status, 0, result.stderr || String(result.error));
		assert.match(result.stdout, /Native audio lifecycle checks passed/);
	} finally {
		rmSync(folder, { recursive: true, force: true });
	}
});
