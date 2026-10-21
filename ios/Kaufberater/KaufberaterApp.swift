// Kaufberater – iPhone-App
// Schlanker Rahmen um die Web-App (gleiche Oberfläche, Updates ohne neue App-Version) plus echte iPhone-Mitteilungen.

import SwiftUI
import UserNotifications

@main
struct KaufberaterApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        WindowGroup {
            WebContainer()
                .ignoresSafeArea()
                .onOpenURL { url in Router.shared.handle(url) }
        }
    }
}

/// Leitet Links (kaufberater://…, Antippen einer Mitteilung) an die richtige Stelle der Web-App weiter
final class Router: ObservableObject {
    static let shared = Router()
    static let baseURL = URL(string: "https://lelawi.github.io/Kaufberater-app/")!

    /// Ziel in der Web-App, z. B. "#/p/<id>" oder "#/check?auto=1&u=…"
    @Published var pendingHash: String?

    func handle(_ url: URL) {
        if url.scheme == "kaufberater" {
            // kaufberater://check?u=<Link>  → Schnellcheck
            // kaufberater://p/<id>          → Produktseite
            // kaufberater://add?u=<Link>    → Eintragen
            let host = url.host ?? ""
            let path = url.path
            let query = url.query.map { "?" + $0 } ?? ""
            switch host {
            case "check":
                let q = query.isEmpty ? "" : query + (query.contains("auto=") ? "" : "&auto=1")
                pendingHash = "#/check" + q
            case "add": pendingHash = "#/add" + query
            case "p": pendingHash = "#/p" + path
            default: pendingHash = "#/"
            }
        } else if let fragment = url.fragment, url.host == Router.baseURL.host {
            pendingHash = "#" + fragment
        }
    }
}

final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        // Wenn Mitteilungen schon erlaubt sind: Token bei jedem Start erneuern (Apple kann ihn ändern)
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            if settings.authorizationStatus == .authorized {
                DispatchQueue.main.async { application.registerForRemoteNotifications() }
            }
        }
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let token = deviceToken.map { String(format: "%02x", $0) }.joined()
        PushManager.shared.didRegister(token: token)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        PushManager.shared.didFail(error)
    }

    // Mitteilung auch anzeigen, wenn die App gerade offen ist
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .list, .sound])
    }

    // Antippen einer Mitteilung → passende Seite öffnen
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        let info = response.notification.request.content.userInfo
        if let path = info["path"] as? String, path.hasPrefix("#/") {
            DispatchQueue.main.async { Router.shared.pendingHash = path }
        }
        completionHandler()
    }
}
