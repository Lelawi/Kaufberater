import SwiftUI
import WebKit
import Combine
import UserNotifications

/// Zeigt die Web-App und verbindet sie mit den iPhone-Funktionen (Mitteilungen, Links, Badge)
struct WebContainer: UIViewRepresentable {
    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()          // Anmeldung bleibt gespeichert
        config.allowsInlineMediaPlayback = true
        let ucc = WKUserContentController()
        // Brücke für die Web-App: window.kbNative.call('push-enable') usw.
        // Ist die Teilen-Menü-Erweiterung eingebaut? (dann zeigt die Web-App die einfache Anleitung)
        let hasShare = Bundle.main.builtInPlugInsURL.map { FileManager.default.fileExists(atPath: $0.appendingPathComponent("KaufberaterShare.appex").path) } ?? false
        let bridge = """
        (function () {
          const pending = {}; let seq = 0;
          window.kbNative = {
            platform: 'ios', version: '\(Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "1")', share: \(hasShare),
            call(type, data) {
              return new Promise((resolve, reject) => {
                const id = ++seq; pending[id] = { resolve, reject };
                window.webkit.messageHandlers.kb.postMessage({ id, type, data: data || null });
              });
            },
            _resolve(id, ok, value) { const p = pending[id]; if (!p) return; delete pending[id]; ok ? p.resolve(value) : p.reject(new Error(value)); },
            onPushToken: null
          };
        })();
        """
        ucc.addUserScript(WKUserScript(source: bridge, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        ucc.add(WeakHandler(context.coordinator), name: "kb")
        config.userContentController = ucc

        let web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = context.coordinator
        web.uiDelegate = context.coordinator
        web.allowsBackForwardNavigationGestures = true
        web.isOpaque = false
        web.backgroundColor = UIColor(named: "LaunchBackground")
        web.scrollView.contentInsetAdjustmentBehavior = .never
        let refresh = UIRefreshControl()
        refresh.addTarget(context.coordinator, action: #selector(Coordinator.reload(_:)), for: .valueChanged)
        web.scrollView.refreshControl = refresh
        context.coordinator.web = web
        context.coordinator.loadStart(hash: Router.shared.pendingHash)
        Router.shared.pendingHash = nil
        return web
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
        weak var web: WKWebView?
        private var bag = Set<AnyCancellable>()
        private var loadedOnce = false

        override init() {
            super.init()
            // Deep Links / angetippte Mitteilungen
            Router.shared.$pendingHash.compactMap { $0 }.receive(on: RunLoop.main).sink { [weak self] hash in
                guard let self, let web = self.web else { return }
                Router.shared.pendingHash = nil
                if self.loadedOnce {
                    let js = "location.hash = \(Self.jsString(hash));"
                    web.evaluateJavaScript(js)
                } else {
                    self.loadStart(hash: hash)
                }
            }.store(in: &bag)
            // Neuer Mitteilungs-Token → an die Web-App weitergeben
            NotificationCenter.default.publisher(for: .kbPushToken).receive(on: RunLoop.main).sink { [weak self] note in
                guard let token = note.object as? String else { return }
                self?.web?.evaluateJavaScript("window.kbNative && window.kbNative.onPushToken && window.kbNative.onPushToken(\(Self.jsString(token)))")
            }.store(in: &bag)
        }

        func loadStart(hash: String?) {
            var comps = URLComponents(url: Router.baseURL, resolvingAgainstBaseURL: false)!
            comps.queryItems = [URLQueryItem(name: "app", value: "ios")]
            var url = comps.url!.absoluteString
            if let hash { url += hash }
            web?.load(URLRequest(url: URL(string: url)!, cachePolicy: .reloadRevalidatingCacheData))
        }

        @objc func reload(_ sender: UIRefreshControl) {
            web?.reload()
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { sender.endRefreshing() }
        }

        // MARK: Navigation – eigene Seiten in der App, alles andere (Shops, mydealz …) im Browser bzw. in der Shop-App
        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let url = action.request.url else { return decisionHandler(.cancel) }
            let isOwn = url.host == Router.baseURL.host && url.path.hasPrefix(Router.baseURL.path)
            let isAuth = url.host?.hasSuffix("supabase.co") == true
            if url.scheme == "kaufberater" { Router.shared.handle(url); return decisionHandler(.cancel) }
            if isOwn && !url.path.hasSuffix("go.html") || isAuth || url.scheme == "about" || url.scheme == "blob" || url.scheme == "data" {
                return decisionHandler(.allow)
            }
            if action.navigationType == .linkActivated || action.targetFrame == nil || !(action.targetFrame?.isMainFrame ?? true) || url.path.hasSuffix("go.html") {
                UIApplication.shared.open(url)
                return decisionHandler(.cancel)
            }
            UIApplication.shared.open(url)
            decisionHandler(.cancel)
        }

        // Links mit target="_blank"
        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                     for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            if let url = action.request.url {
                if url.host == Router.baseURL.host && !url.path.hasSuffix("go.html") { webView.load(action.request) }
                else { UIApplication.shared.open(url) }
            }
            return nil
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { loadedOnce = true }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            showOffline(webView, error)
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            if (error as NSError).code != NSURLErrorCancelled { showOffline(webView, error) }
        }

        private func showOffline(_ webView: WKWebView, _ error: Error) {
            let html = """
            <meta name=viewport content="width=device-width,initial-scale=1">
            <body style="font:17px -apple-system;padding:40px 24px;color:#1A2230;background:#EEF1F5">
            <h2>Keine Verbindung</h2><p>Der Kaufberater braucht Internet. \((error as NSError).localizedDescription)</p>
            <p><a href="\(Router.baseURL.absoluteString)?app=ios" style="color:#1A2230">Erneut versuchen</a></p></body>
            """
            webView.loadHTMLString(html, baseURL: Router.baseURL)
        }

        // MARK: Brücke Web-App → iPhone
        func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
            guard let body = message.body as? [String: Any], let id = body["id"] as? Int, let type = body["type"] as? String else { return }
            switch type {
            case "push-status":
                PushManager.shared.status { st in self.reply(id, true, st.rawValue) }
            case "push-token":
                // Aktueller Geräte-Schlüssel (leer, solange Mitteilungen aus sind) – die Web-App speichert ihn nach der Anmeldung
                reply(id, true, PushManager.shared.lastToken ?? "")
            case "push-enable":
                PushManager.shared.enable { result in
                    switch result {
                    case .success(let token): self.reply(id, true, token)
                    case .failure(let err): self.reply(id, false, err.localizedDescription)
                    }
                }
            case "badge":
                let n = (body["data"] as? [String: Any])?["count"] as? Int ?? 0
                UNUserNotificationCenter.current().setBadgeCount(n)
                reply(id, true, "ok")
            case "open":
                if let s = (body["data"] as? [String: Any])?["url"] as? String, let url = URL(string: s) { UIApplication.shared.open(url) }
                reply(id, true, "ok")
            default:
                reply(id, false, "unbekannt: \(type)")
            }
        }

        private func reply(_ id: Int, _ ok: Bool, _ value: String) {
            web?.evaluateJavaScript("window.kbNative && window.kbNative._resolve(\(id), \(ok), \(Self.jsString(value)))")
        }

        static func jsString(_ s: String) -> String {
            let data = try? JSONSerialization.data(withJSONObject: [s])
            let arr = data.flatMap { String(data: $0, encoding: .utf8) } ?? "[\"\"]"
            return String(arr.dropFirst().dropLast())
        }
    }
}

/// Verhindert eine Speicherschleife zwischen WebView und Brücke
private final class WeakHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    init(_ target: WKScriptMessageHandler) { self.target = target }
    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(ucc, didReceive: message)
    }
}
