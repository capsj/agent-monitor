import Foundation
import SwiftUI

enum MetricValue: Decodable {
    case number(Double)
    case string(String)
    case null

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else {
            self = .string(try container.decode(String.self))
        }
    }
}

struct UsageWindow: Decodable, Identifiable {
    let id: String
    let label: String
    let usedPercent: Double?
    let remaining: Double?
    let limit: Double?
    let resetsAt: String?
    let resetDescription: String?
    let quality: String
    let category: String?

    var isAdditional: Bool { category == "additional" }

    var displayedPercent: Double? {
        guard let usedPercent else { return nil }
        return isAdditional ? usedPercent : max(0, 100 - min(100, usedPercent))
    }

    var percentLabel: String {
        guard let displayedPercent else { return "—" }
        return "\(displayedPercent.formatted(.number.precision(.fractionLength(0))))% \(isAdditional ? "used" : "left")"
    }

    var resetLabel: String? {
        if let resetsAt,
           let date = ISO8601DateFormatter().date(from: resetsAt) {
            return "Resets \(date.formatted(.relative(presentation: .named)))"
        }
        return resetDescription
    }
}

struct Metric: Decodable, Identifiable {
    let key: String
    let label: String
    let value: MetricValue
    let unit: String
    let quality: String
    let period: String?
    let category: String?

    var id: String { key }

    var formattedValue: String {
        switch value {
        case .null:
            return "—"
        case .string(let value):
            return value
        case .number(let value):
            switch unit {
            case "percent":
                return "\(value.formatted(.number.precision(.fractionLength(0))))%"
            case "currency":
                return value.formatted(.currency(code: "USD"))
            case "tokens", "count":
                return value.formatted(.number.notation(.compactName))
            case "duration":
                return Duration.seconds(value).formatted(.units(allowed: [.hours, .minutes, .seconds], width: .abbreviated))
            case "timestamp":
                return Date(timeIntervalSince1970: value / (value > 10_000_000_000 ? 1_000 : 1))
                    .formatted(date: .abbreviated, time: .shortened)
            default:
                return value.formatted(.number.precision(.fractionLength(0...1)))
            }
        }
    }
}

struct ProviderSourceStatus: Decodable, Identifiable {
    let id: String
    let label: String
    let kind: String
    let role: String
    let state: String
    let message: String?
}

struct ProviderSnapshot: Decodable, Identifiable {
    let providerId: String
    let providerName: String
    let accountId: String?
    let accountLabel: String?
    let collectedAt: String
    let status: String
    let source: String
    let plan: String?
    let summary: String
    let windows: [UsageWindow]
    let metrics: [Metric]
    let message: String?
    let version: String?
    let sources: [ProviderSourceStatus]?

    /// Matches the backend's snapshot key: `provider` or `provider:account`.
    var id: String {
        if let accountId { return "\(providerId):\(accountId)" }
        return providerId
    }

    var displayName: String {
        if let accountLabel { return "\(providerName) · \(accountLabel)" }
        return providerName
    }

    var primaryWindow: UsageWindow? {
        windows.first { !$0.isAdditional && $0.usedPercent != nil }
    }

    var headline: String {
        primaryWindow?.percentLabel ?? summary
    }

    var symbolName: String {
        switch providerId {
        case "codex": "sparkles"
        case "claude": "brain.head.profile"
        case "cursor": "cursorarrow.rays"
        case "opencode": "terminal"
        case "gemini": "diamond"
        default: "cpu"
        }
    }

    var statusColor: Color {
        switch status {
        case "ok": .green
        case "partial", "stale": .orange
        case "unavailable": .secondary
        default: .red
        }
    }
}

struct MonitorStateMessage: Decodable {
    let type: String
    let emittedAt: String
    let paused: Bool
    let refreshing: [String]
    let snapshots: [ProviderSnapshot]
}
