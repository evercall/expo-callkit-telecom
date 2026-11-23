import Foundation
import Network

/// Reports coarse path changes only; no addresses, SSIDs, or candidate data.
@MainActor
final class NetworkPathMonitor {
  private var monitor: NWPathMonitor?
  private var generation = UUID()
  private var previous: String?

  deinit { monitor?.cancel() }

  func start(onChange: @escaping ([String: Any]) -> Void) {
    guard monitor == nil else { return }
    let monitor = NWPathMonitor()
    let generation = UUID()
    self.monitor = monitor
    self.generation = generation
    previous = nil
    monitor.pathUpdateHandler = { [weak self] path in
      let types: [(NWInterface.InterfaceType, String)] = [
        (.wifi, "wifi"), (.cellular, "cellular"),
        (.wiredEthernet, "ethernet"), (.other, "other"),
      ]
      let interfaces = types.compactMap { path.usesInterfaceType($0.0) ? $0.1 : nil }
      let status: String
      switch path.status {
      case .satisfied: status = "satisfied"
      case .unsatisfied: status = "unsatisfied"
      case .requiresConnection: status = "requiresConnection"
      @unknown default: status = "unknown"
      }
      Task { @MainActor [weak self] in
        guard let self, self.generation == generation, self.monitor != nil else { return }
        let fingerprint = status + ":" + interfaces.joined(separator: ",")
        guard fingerprint != self.previous else { return }
        let initial = self.previous == nil
        self.previous = fingerprint
        onChange(["status": status, "interfaces": interfaces, "initial": initial])
      }
    }
    monitor.start(queue: DispatchQueue(label: "expo.callkit.network-path"))
  }

  func stop() {
    generation = UUID()
    monitor?.cancel()
    monitor = nil
    previous = nil
  }
}
