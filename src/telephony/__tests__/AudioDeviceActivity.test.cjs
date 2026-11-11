// Executes production iOS discovery against controlled native route snapshots.
// Run: node --test src/telephony/__tests__/AudioDeviceActivity.test.cjs
const assert = require("node:assert/strict");
const { readFileSync, writeFileSync, mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { resolve, join } = require("node:path");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");

const source = readFileSync(resolve(__dirname, "../../../ios/Managers/AudioManager.swift"), "utf8");
const method = (name) => {
	const declaration = new RegExp(`^  (?:private )?func ${name}\\(`, "m").exec(source);
	assert.ok(declaration, `Missing production method ${name}`);
	const start = declaration.index;
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

test("iOS device activity matches observed UIDs and paired routes, preserving unknown as JSON null", {
	skip: process.platform !== "darwin",
}, () => {
	const folder = mkdtempSync(join(tmpdir(), "callkit-device-activity-"));
	const harness = `
import Foundation
struct AVAudioSessionPortDescription {
  let uid: String
  let portName: String
  let portType: AVAudioSession.Port
}
struct AVAudioSessionRouteDescription {
  var inputs: [AVAudioSessionPortDescription] = []
  var outputs: [AVAudioSessionPortDescription] = []
}
final class AVAudioSession {
  enum Port: String {
    case builtInMic, builtInSpeaker, builtInReceiver, bluetoothHFP, bluetoothA2DP,
         bluetoothLE, headsetMic, headphones, usbAudio, HDMI, lineIn, lineOut,
         airPlay, carAudio, futurePort
  }
  static let instance = AVAudioSession()
  static func sharedInstance() -> AVAudioSession { instance }
  var availableInputs: [AVAudioSessionPortDescription]?
  var currentRoute = AVAudioSessionRouteDescription()
}
final class UIDevice {
  enum Idiom { case phone, pad }
  static let current = UIDevice()
  var userInterfaceIdiom = Idiom.phone
}
final class Manager {
${method("deviceType")}
${method("isPairedOutputActive")}
${method("getAudioDevices")}
}
func expect(_ condition: Bool) { precondition(condition) }
let manager = Manager()
let session = AVAudioSession.instance
let mic = AVAudioSessionPortDescription(uid: "mic-uid", portName: "Phone", portType: .builtInMic)
let speaker = AVAudioSessionPortDescription(uid: "speaker-native-uid", portName: "Speaker", portType: .builtInSpeaker)
let receiver = AVAudioSessionPortDescription(uid: "receiver-native-uid", portName: "Receiver", portType: .builtInReceiver)
let headset1 = AVAudioSessionPortDescription(uid: "headset-1-input", portName: "Same name", portType: .bluetoothHFP)
let headset2 = AVAudioSessionPortDescription(uid: "headset-2-input", portName: "Same name", portType: .bluetoothHFP)
let headset2Output = AVAudioSessionPortDescription(uid: "headset-2-output", portName: "Same name", portType: .bluetoothHFP)
let wired = AVAudioSessionPortDescription(uid: "wired-input", portName: "Headset", portType: .headsetMic)
let wiredOutput = AVAudioSessionPortDescription(uid: "wired-output", portName: "Headphones", portType: .headphones)
session.availableInputs = [mic, headset1, headset2, wired]
func activity(_ direction: String, _ id: String) throws -> Any {
  let devices = try manager.getAudioDevices(direction: direction)
  guard let device = devices.first(where: { ($0["id"] as? String) == id }),
    let value = device["isActive"] else { fatalError("Missing device/activity: \\(id)") }
  return value
}
session.currentRoute = AVAudioSessionRouteDescription(inputs: [mic], outputs: [speaker])
expect(try activity("input", "input:mic-uid") as? Bool == true)
expect(try activity("input", "input:headset-1-input") as? Bool == false)
expect(try activity("output", "output:speaker") as? Bool == true)
expect(try activity("output", "output:receiver") as? Bool == false)
expect(try activity("output", "output:paired:headset-2-input") as? Bool == false)
let oldSnapshot = try manager.getAudioDevices(direction: "output")
session.currentRoute = AVAudioSessionRouteDescription(inputs: [headset2], outputs: [headset2Output])
expect(try activity("output", "output:paired:headset-2-input") as? Bool == true)
expect(try activity("output", "output:paired:headset-1-input") as? Bool == false)
expect(try activity("input", "input:headset-2-input") as? Bool == true)
expect(try activity("output", "output:speaker") as? Bool == false)
expect(oldSnapshot.first?["isActive"] as? Bool == true)
// Without an identifying input, identical type/name is not proof of identity.
session.currentRoute.inputs = []
expect(try activity("output", "output:paired:headset-1-input") is NSNull)
expect(try activity("output", "output:paired:headset-2-input") is NSNull)
expect(try activity("input", "input:headset-2-input") is NSNull)
let unknownJson = try JSONSerialization.data(withJSONObject: manager.getAudioDevices(direction: "output"), options: [.sortedKeys])
expect(String(data: unknownJson, encoding: .utf8)!.contains("\\\"isActive\\\":null"))
session.currentRoute = AVAudioSessionRouteDescription(inputs: [wired], outputs: [wiredOutput])
expect(try activity("output", "output:paired:wired-input") as? Bool == true)
session.currentRoute = AVAudioSessionRouteDescription(inputs: [mic], outputs: [receiver])
expect(try activity("output", "output:receiver") as? Bool == true)
expect(try activity("output", "output:speaker") as? Bool == false)
// An unrelated output profile must not activate an HFP entry.
let a2dp = AVAudioSessionPortDescription(uid: "a2dp-output", portName: "Same name", portType: .bluetoothA2DP)
session.currentRoute = AVAudioSessionRouteDescription(inputs: [headset2], outputs: [a2dp])
expect(try activity("output", "output:paired:headset-2-input") as? Bool == false)
// No route means unknown, and unknown must survive native JSON serialization.
session.currentRoute = AVAudioSessionRouteDescription()
expect(try activity("output", "output:speaker") is NSNull)
expect(try activity("output", "output:receiver") is NSNull)
expect(try activity("output", "output:paired:wired-input") is NSNull)
expect(try activity("input", "input:mic-uid") is NSNull)
// Output-only system routes need not correspond to any selectable entry.
let airplay = AVAudioSessionPortDescription(uid: "airplay-output", portName: "AirPlay", portType: .airPlay)
session.currentRoute = AVAudioSessionRouteDescription(outputs: [airplay])
expect(try manager.getAudioDevices(direction: "output").allSatisfy { ($0["isActive"] as? Bool) == false })
// Unknown port types retain UID-based input activity.
let future = AVAudioSessionPortDescription(uid: "future-input", portName: "Future", portType: .futurePort)
session.availableInputs = [future]
session.currentRoute = AVAudioSessionRouteDescription(inputs: [future], outputs: [speaker])
expect(try activity("input", "input:future-input") as? Bool == true)
let activeJson = try JSONSerialization.data(withJSONObject: manager.getAudioDevices(direction: "input"))
expect(String(data: activeJson, encoding: .utf8)!.contains("\\\"isActive\\\":true"))
print("Native device activity checks passed")
`;
	try {
		const filename = join(folder, "DeviceActivity.swift");
		writeFileSync(filename, harness);
		const result = spawnSync("swift", ["-swift-version", "5", "-module-cache-path", join(folder, "cache"), filename], {
			encoding: "utf8", timeout: 60000,
		});
		assert.equal(result.status, 0, result.stderr || String(result.error));
		assert.match(result.stdout, /Native device activity checks passed/);
	} finally {
		rmSync(folder, { recursive: true, force: true });
	}
});
