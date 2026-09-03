import AppKit
import Foundation

@MainActor
final class MonitorStore: ObservableObject {
    @Published private(set) var snapshots: [ProviderSnapshot] = []
    @Published private(set) var refreshing: Set<String> = []
    @Published private(set) var paused = false
    @Published private(set) var connected = false
    @Published private(set) var errorMessage: String?
    @Published private(set) var authentication: AuthenticationMessage?

    private var process: Process?
    private var input: Pipe?
    private var outputBuffer = Data()
    private var backendStderr = ""
    private var restartWorkItem: DispatchWorkItem?
    private var stopping = false

    init() {
        start()
    }

    var menuBarSymbol: String {
        if errorMessage != nil { return "exclamationmark.triangle.fill" }
        if paused { return "pause.circle.fill" }
        if !connected || !refreshing.isEmpty { return "gauge.with.dots.needle.33percent" }
        return "gauge.with.dots.needle.67percent"
    }

    var latestUpdate: Date? {
        snapshots.compactMap { ISO8601DateFormatter().date(from: $0.collectedAt) }.max()
    }

    func ensureRunning() {
        if process == nil && !stopping { start() }
    }

    func refresh() {
        send(action: "refresh")
    }

    func refresh(providerId: String) {
        send(["action": "refresh", "providerId": providerId])
    }

    func connect(providerId: String) {
        authentication = nil
        send([
            "action": "authenticateDashboard",
            "providerId": providerId,
            "mode": "isolated",
        ])
    }

    func cancelAuthentication() {
        send(action: "cancelAuthentication")
    }

    func dismissAuthentication() {
        guard authentication?.isWorking != true else { return }
        authentication = nil
    }

    func togglePause() {
        send(action: "togglePause")
    }

    func quit() {
        stopping = true
        restartWorkItem?.cancel()
        send(action: "quit")
        process?.terminate()
        NSApplication.shared.terminate(nil)
    }

    private func start() {
        guard process == nil, let executable = backendExecutable() else {
            if process == nil {
                errorMessage = "agent-monitor was not found. Build the app from the repository or install the CLI globally."
            }
            return
        }

        stopping = false
        errorMessage = nil
        backendStderr = ""
        let task = Process()
        let stdinPipe = Pipe()
        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()
        task.executableURL = executable
        task.arguments = ["stream"]
        task.standardInput = stdinPipe
        task.standardOutput = stdoutPipe
        task.standardError = stderrPipe
        task.environment = processEnvironment()

        stdoutPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty else { return }
            DispatchQueue.main.async {
                self?.consume(data)
            }
        }
        stderrPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty, let text = String(data: data, encoding: .utf8) else { return }
            DispatchQueue.main.async {
                self?.backendStderr = "\(self?.backendStderr ?? "")\(text)".suffix(8_000).description
                if self?.connected != true {
                    self?.errorMessage = text.trimmingCharacters(in: .whitespacesAndNewlines)
                }
            }
        }
        task.terminationHandler = { [weak self] finished in
            DispatchQueue.main.async {
                self?.handleTermination(status: finished.terminationStatus)
            }
        }

        do {
            try task.run()
            process = task
            input = stdinPipe
        } catch {
            errorMessage = "Could not start agent-monitor: \(error.localizedDescription)"
            scheduleRestart()
        }
    }

    private func consume(_ data: Data) {
        outputBuffer.append(data)
        while let newline = outputBuffer.firstIndex(of: 0x0A) {
            let line = outputBuffer[..<newline]
            outputBuffer.removeSubrange(...newline)
            guard !line.isEmpty,
                  let type = try? JSONSerialization.jsonObject(with: Data(line)) as? [String: Any],
                  let messageType = type["type"] as? String else {
                continue
            }
            if messageType == "state",
               let message = try? JSONDecoder().decode(MonitorStateMessage.self, from: Data(line)) {
                apply(message)
            } else if messageType == "authentication",
                      let message = try? JSONDecoder().decode(AuthenticationMessage.self, from: Data(line)) {
                authentication = message
            }
        }
    }

    private func apply(_ message: MonitorStateMessage) {
        guard message.type == "state" else { return }
        let order = ["codex", "claude", "cursor", "opencode", "gemini"]
        snapshots = message.snapshots.sorted {
            (order.firstIndex(of: $0.providerId) ?? order.count) <
                (order.firstIndex(of: $1.providerId) ?? order.count)
        }
        refreshing = Set(message.refreshing)
        paused = message.paused
        connected = true
        errorMessage = nil
    }

    private func send(action: String) {
        send(["action": action])
    }

    private func send(_ payload: [String: String]) {
        guard var data = try? JSONSerialization.data(withJSONObject: payload) else { return }
        data.append(0x0A)
        do {
            try input?.fileHandleForWriting.write(contentsOf: data)
        } catch {
            errorMessage = "The monitor connection closed."
        }
    }

    private func handleTermination(status: Int32) {
        process = nil
        input = nil
        connected = false
        authentication = nil
        if !stopping {
            let backendMessage = backendStderr.trimmingCharacters(in: .whitespacesAndNewlines)
            if !backendMessage.isEmpty {
                errorMessage = "\(backendMessage)\n\nReconnecting…"
            } else {
                errorMessage = status == 0
                    ? "The monitor stopped. Reconnecting…"
                    : "The monitor exited with status \(status). Reconnecting…"
            }
            scheduleRestart()
        }
    }

    private func scheduleRestart() {
        guard !stopping else { return }
        restartWorkItem?.cancel()
        let item = DispatchWorkItem { [weak self] in self?.start() }
        restartWorkItem = item
        DispatchQueue.main.asyncAfter(deadline: .now() + 3, execute: item)
    }

    private func backendExecutable() -> URL? {
        if let configured = ProcessInfo.processInfo.environment["AGENT_MONITOR_CLI"],
           FileManager.default.isExecutableFile(atPath: configured) {
            return URL(fileURLWithPath: configured)
        }
        if let bundled = Bundle.main.url(forResource: "agent-monitor-backend", withExtension: nil),
           FileManager.default.isExecutableFile(atPath: bundled.path) {
            return bundled
        }
        for path in ["/opt/homebrew/bin/agent-monitor", "/usr/local/bin/agent-monitor"]
            where FileManager.default.isExecutableFile(atPath: path) {
            return URL(fileURLWithPath: path)
        }
        return commandPath("agent-monitor")
    }

    private func commandPath(_ command: String) -> URL? {
        let lookup = Process()
        let output = Pipe()
        lookup.executableURL = URL(fileURLWithPath: "/bin/zsh")
        lookup.arguments = ["-lc", "command -v \(command)"]
        lookup.standardOutput = output
        lookup.standardError = FileHandle.nullDevice
        try? lookup.run()
        lookup.waitUntilExit()
        guard lookup.terminationStatus == 0,
              let value = String(data: output.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines),
              !value.isEmpty else { return nil }
        return URL(fileURLWithPath: value)
    }

    private func processEnvironment() -> [String: String] {
        var environment = ProcessInfo.processInfo.environment
        let additions = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]
        let existing = environment["PATH", default: ""]
        environment["PATH"] = ([existing] + additions).joined(separator: ":")
        return environment
    }
}
