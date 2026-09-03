import AppKit
import SwiftUI

@main
struct AgentMonitorMenuBarApp: App {
    @StateObject private var store = MonitorStore()

    var body: some Scene {
        MenuBarExtra {
            MonitorPopover(store: store)
        } label: {
            Label("Agent Monitor", systemImage: store.menuBarSymbol)
        }
        .menuBarExtraStyle(.window)
    }
}

struct MonitorPopover: View {
    @ObservedObject var store: MonitorStore

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()

            if let authentication = store.authentication {
                authenticationBanner(authentication)
                Divider()
            }

            if let error = store.errorMessage, store.snapshots.isEmpty {
                VStack(spacing: 10) {
                    Image(systemName: "exclamationmark.triangle")
                        .font(.title)
                        .foregroundStyle(.orange)
                    Text("Monitor unavailable").font(.headline)
                    Text(error)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }
                .frame(maxWidth: .infinity)
                .frame(minHeight: 190)
                .padding(.horizontal, 18)
            } else if store.snapshots.isEmpty {
                VStack(spacing: 10) {
                    ProgressView()
                    Text("Collecting provider usage…").foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, minHeight: 190)
            } else {
                ScrollView {
                    LazyVStack(spacing: 8) {
                        ForEach(store.snapshots) { snapshot in
                            ProviderRow(
                                snapshot: snapshot,
                                refreshing: store.refreshing.contains(snapshot.providerId),
                                authenticating: store.authentication?.isWorking == true,
                                onRefresh: { store.refresh(providerId: snapshot.providerId) },
                                onConnect: { store.connect(providerId: snapshot.providerId) }
                            )
                        }
                    }
                    .padding(12)
                }
                .frame(maxHeight: .infinity)
            }

            Divider()
            footer
        }
        .frame(width: 380, height: popoverHeight)
        .animation(.easeInOut(duration: 0.16), value: store.snapshots.count)
        .onAppear { store.ensureRunning() }
    }

    private func authenticationBanner(_ authentication: AuthenticationMessage) -> some View {
        HStack(spacing: 10) {
            if authentication.isWorking {
                ProgressView().controlSize(.small)
            } else {
                Image(systemName: authentication.status == "success" ? "checkmark.circle.fill" : "exclamationmark.circle.fill")
                    .foregroundStyle(authentication.status == "success" ? .green : .orange)
            }
            Text(authentication.message)
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 6)
            if authentication.isWorking {
                Button("Cancel") { store.cancelAuthentication() }
                    .controlSize(.small)
            } else {
                Button { store.dismissAuthentication() } label: {
                    Image(systemName: "xmark")
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
    }

    private var header: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text("Agent Monitor").font(.headline)
                Text(statusText).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            Toggle("Polling", isOn: Binding(
                get: { !store.paused },
                set: { _ in store.togglePause() }
            ))
            .labelsHidden()
            .toggleStyle(.switch)
            .controlSize(.small)
            .help(store.paused ? "Resume polling" : "Pause polling")
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 13)
    }

    private var footer: some View {
        HStack(spacing: 12) {
            Button {
                store.refresh()
            } label: {
                Label("Refresh", systemImage: "arrow.clockwise")
            }
            .buttonStyle(.plain)
            .disabled(!store.connected || !store.refreshing.isEmpty)

            Spacer()

            Button("Quit") { store.quit() }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
        }
        .font(.caption)
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
    }

    private var statusText: String {
        if store.paused { return "Polling paused" }
        if !store.connected { return "Connecting…" }
        if !store.refreshing.isEmpty { return "Refreshing \(store.refreshing.count) provider\(store.refreshing.count == 1 ? "" : "s")…" }
        if let update = store.latestUpdate {
            return "Updated \(update.formatted(.relative(presentation: .named)))"
        }
        return "Live"
    }

    private var popoverHeight: CGFloat {
        let pointer = NSEvent.mouseLocation
        let screen = NSScreen.screens.first { NSMouseInRect(pointer, $0.frame, false) } ?? NSScreen.main
        let availableHeight = (screen?.visibleFrame.height ?? 680) - 24
        let providerCount = CGFloat(store.snapshots.count)
        let rowHeight: CGFloat = 54
        let rowSpacing = max(0, providerCount - 1) * 8
        let listPadding: CGFloat = 24
        let headerAndFooter: CGFloat = 102 + (store.authentication == nil ? 0 : 62)
        let contentHeight = store.snapshots.isEmpty
            ? 190
            : providerCount * rowHeight + rowSpacing + listPadding
        return min(availableHeight, headerAndFooter + contentHeight)
    }
}
