import UIKit
import UserNotifications

/// Fragt die Erlaubnis für Mitteilungen ab und holt den Geräte-Schlüssel (Token) von Apple
final class PushManager {
    static let shared = PushManager()
    private var waiting: [(Result<String, Error>) -> Void] = []
    private(set) var lastToken: String?

    enum Status: String { case on, off, denied }

    func status(_ done: @escaping (Status) -> Void) {
        UNUserNotificationCenter.current().getNotificationSettings { s in
            let st: Status
            switch s.authorizationStatus {
            case .authorized, .provisional, .ephemeral: st = self.lastToken != nil ? .on : .off
            case .denied: st = .denied
            default: st = .off
            }
            DispatchQueue.main.async { done(st) }
        }
    }

    /// Erlaubnis anfragen und Token holen
    func enable(_ done: @escaping (Result<String, Error>) -> Void) {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { granted, error in
            DispatchQueue.main.async {
                if let error { return done(.failure(error)) }
                guard granted else { return done(.failure(PushError.denied)) }
                if let t = self.lastToken { return done(.success(t)) }
                self.waiting.append(done)
                UIApplication.shared.registerForRemoteNotifications()
            }
        }
    }

    func didRegister(token: String) {
        lastToken = token
        let w = waiting; waiting.removeAll()
        w.forEach { $0(.success(token)) }
        // Web-App informieren, damit sie den (evtl. neuen) Token speichert
        NotificationCenter.default.post(name: .kbPushToken, object: token)
    }

    func didFail(_ error: Error) {
        let w = waiting; waiting.removeAll()
        w.forEach { $0(.failure(error)) }
    }

    enum PushError: LocalizedError {
        case denied
        var errorDescription: String? { "Mitteilungen wurden nicht erlaubt. Du kannst sie in den iPhone-Einstellungen unter Mitteilungen → Kaufberater einschalten." }
    }
}

extension Notification.Name {
    static let kbPushToken = Notification.Name("kbPushToken")
}
