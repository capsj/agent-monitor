import SwiftUI

struct ProviderRow: View {
    let snapshot: ProviderSnapshot
    let refreshing: Bool
    let authenticating: Bool
    let onRefresh: () -> Void
    let onConnect: () -> Void
    @State private var expanded = false

    var body: some View {
        VStack(spacing: 0) {
            Button {
                withAnimation(.easeInOut(duration: 0.16)) { expanded.toggle() }
            } label: {
                HStack(spacing: 12) {
                    ZStack {
                        Circle().fill(Color.accentColor.opacity(0.16))
                        Image(systemName: snapshot.symbolName)
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(Color.accentColor)
                    }
                    .frame(width: 34, height: 34)

                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: 6) {
                            Text(snapshot.providerName).fontWeight(.semibold)
                            Circle().fill(snapshot.statusColor).frame(width: 6, height: 6)
                        }
                        Text(snapshot.plan ?? snapshot.status.capitalized)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }

                    Spacer(minLength: 8)

                    if refreshing {
                        ProgressView().controlSize(.small)
                    } else {
                        Text(snapshot.headline)
                            .font(.system(.body, design: .rounded, weight: .semibold))
                            .foregroundStyle(headlineColor)
                            .lineLimit(1)
                    }
                    Image(systemName: "chevron.right")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(.tertiary)
                        .rotationEffect(.degrees(expanded ? 90 : 0))
                }
                .contentShape(Rectangle())
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
            }
            .buttonStyle(.plain)

            if expanded {
                VStack(alignment: .leading, spacing: 10) {
                    if snapshot.windows.isEmpty && snapshot.metrics.isEmpty {
                        Text(snapshot.summary)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    ForEach(snapshot.windows) { window in
                        usageWindow(window)
                    }
                    ForEach(snapshot.metrics) { metric in
                        HStack {
                            Text(metric.label).foregroundStyle(.secondary)
                            Spacer()
                            Text(metric.formattedValue).fontWeight(.medium)
                        }
                        .font(.caption)
                    }
                    if let message = snapshot.message, !message.isEmpty {
                        Label(message, systemImage: "info.circle")
                            .font(.caption)
                            .foregroundStyle(snapshot.status == "error" ? .red : .orange)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    if let source = snapshot.sources?.first(where: { $0.actionLabel != nil }) {
                        HStack(spacing: 8) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(source.label).fontWeight(.medium)
                                if let message = source.message, !message.isEmpty {
                                    Text(message)
                                        .foregroundStyle(.secondary)
                                        .lineLimit(2)
                                }
                            }
                            .font(.caption)
                            Spacer()
                            Button(source.actionLabel ?? "Connect") { onConnect() }
                                .controlSize(.small)
                                .disabled(authenticating)
                        }
                    }
                    HStack {
                        Text(sourceDescription)
                        Spacer()
                        Button { onRefresh() } label: {
                            Image(systemName: "arrow.clockwise")
                        }
                        .buttonStyle(.plain)
                        .disabled(refreshing)
                        .help("Refresh \(snapshot.providerName)")
                        if let date = ISO8601DateFormatter().date(from: snapshot.collectedAt) {
                            Text(date.formatted(date: .omitted, time: .shortened))
                        }
                    }
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                }
                .padding(.horizontal, 12)
                .padding(.bottom, 12)
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .background(.quaternary.opacity(0.55), in: RoundedRectangle(cornerRadius: 12))
    }

    private var sourceDescription: String {
        let active = snapshot.sources?
            .filter { $0.state == "active" }
            .map(\.kind)
        guard let active, !active.isEmpty else { return "via \(snapshot.source)" }
        return "via \(Array(Set(active)).sorted().joined(separator: " + "))"
    }

    @ViewBuilder
    private func usageWindow(_ window: UsageWindow) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack {
                Text(window.label).foregroundStyle(.secondary)
                Spacer()
                Text(window.percentLabel).fontWeight(.medium)
            }
            .font(.caption)
            if let value = window.displayedPercent {
                ProgressView(value: min(value, 100), total: 100)
                    .progressViewStyle(.linear)
                    .tint(progressColor(for: window))
            }
            if let reset = window.resetLabel {
                Text(reset).font(.caption2).foregroundStyle(.tertiary)
            }
        }
    }

    private var headlineColor: Color {
        guard let remaining = snapshot.primaryWindow?.displayedPercent else { return .primary }
        if remaining <= 10 { return .red }
        if remaining <= 30 { return .orange }
        return .secondary
    }

    private func progressColor(for window: UsageWindow) -> Color {
        guard !window.isAdditional, let remaining = window.displayedPercent else { return .accentColor }
        if remaining <= 10 { return .red }
        if remaining <= 30 { return .orange }
        return .green
    }
}
