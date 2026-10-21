// Teilen-Menü: „Kaufberater“ erscheint, wenn man in Safari, Amazon & Co. auf Teilen tippt.
// Erweiterungen dürfen keine Apps öffnen. Darum legt sie eine Mitteilung an („Tippen zum Prüfen“);
// das Antippen öffnet die Kaufberater-App direkt beim Schnellcheck bzw. beim Eintragen (wie bei jeder Mitteilung).
import UIKit
import UniformTypeIdentifiers
import UserNotifications

final class ShareViewController: UIViewController {
    private var shared: String?        // Link (oder Text, falls kein Link)
    private var sharedText: String?    // kompletter geteilter Text, z. B. „Produktname https://amzn.eu/…“
    private let card = UIView()
    private let label = UILabel()
    private var buttons: [UIButton] = []

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor.black.withAlphaComponent(0.25)
        buildCard()
        Task { await loadInput() }
    }

    // MARK: Oberfläche
    private func buildCard() {
        card.backgroundColor = .systemBackground
        card.layer.cornerRadius = 20
        card.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(card)

        let title = UILabel()
        title.text = "Kaufberater"
        title.font = .systemFont(ofSize: 20, weight: .bold)
        label.text = "Link wird gelesen …"
        label.font = .systemFont(ofSize: 14)
        label.textColor = .secondaryLabel
        label.numberOfLines = 3

        let check = button("Ist das ein Deal?", filled: true) { [weak self] in self?.hand(over: "check") }
        let add = button("Auf die Wunschliste", filled: false) { [weak self] in self?.hand(over: "add") }
        buttons = [check, add]
        let cancel = UIButton(type: .system)
        cancel.setTitle("Abbrechen", for: .normal)
        cancel.addAction(UIAction { [weak self] _ in self?.finish() }, for: .touchUpInside)

        let stack = UIStackView(arrangedSubviews: [title, label, check, add, cancel])
        stack.axis = .vertical
        stack.spacing = 12
        stack.setCustomSpacing(18, after: label)
        stack.translatesAutoresizingMaskIntoConstraints = false
        card.addSubview(stack)
        NSLayoutConstraint.activate([
            card.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 12),
            card.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -12),
            card.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -12),
            stack.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: 20),
            stack.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -20),
            stack.topAnchor.constraint(equalTo: card.topAnchor, constant: 20),
            stack.bottomAnchor.constraint(equalTo: card.bottomAnchor, constant: -12),
            check.heightAnchor.constraint(equalToConstant: 50),
            add.heightAnchor.constraint(equalToConstant: 50),
        ])
    }

    private func button(_ title: String, filled: Bool, action: @escaping () -> Void) -> UIButton {
        var cfg = filled ? UIButton.Configuration.filled() : UIButton.Configuration.gray()
        cfg.title = title
        cfg.cornerStyle = .capsule
        if filled {
            cfg.baseBackgroundColor = UIColor(red: 0x1A / 255, green: 0x22 / 255, blue: 0x30 / 255, alpha: 1)
            cfg.baseForegroundColor = .white
        }
        let b = UIButton(configuration: cfg)
        b.addAction(UIAction { _ in action() }, for: .touchUpInside)
        return b
    }

    // MARK: Geteilten Inhalt lesen (Link bevorzugt, sonst Text)
    private func loadInput() async {
        let items = extensionContext?.inputItems as? [NSExtensionItem] ?? []
        let providers = items.flatMap { $0.attachments ?? [] }
        // Begleittext (z. B. Produktname aus der Amazon-App) steckt oft nicht im Anhang, sondern am Eintrag selbst
        var text: String? = items.compactMap { $0.attributedContentText?.string }.first { !$0.isEmpty }
        for p in providers {
            if shared == nil, p.hasItemConformingToTypeIdentifier(UTType.url.identifier),
               let item = try? await p.loadItem(forTypeIdentifier: UTType.url.identifier), let url = item as? URL, url.scheme?.hasPrefix("http") == true {
                shared = url.absoluteString; continue
            }
            if text == nil, p.hasItemConformingToTypeIdentifier(UTType.plainText.identifier),
               let item = try? await p.loadItem(forTypeIdentifier: UTType.plainText.identifier) {
                text = item as? String
            }
        }
        if let text {
            // Manche Apps (z. B. Amazon) teilen „Produktname https://amzn.eu/…“ – der Name steckt nur im Text
            sharedText = String(text.prefix(500))
            if shared == nil { shared = text.range(of: #"https?://\S+"#, options: .regularExpression).map { String(text[$0]) } ?? text }
        }
        await MainActor.run {
            label.text = shared.map { s in s.count > 90 ? String(s.prefix(90)) + "…" : s } ?? "Kein Link gefunden."
            buttons.forEach { $0.isEnabled = shared != nil }
        }
    }

    // MARK: An die App übergeben – per Mitteilung, die beim Antippen die richtige Seite öffnet
    private func hand(over action: String) {
        guard let s = shared else { return finish() }
        // Schnellcheck bekommt Link + Text (Name hilft bei Kurzlinks), Eintragen nur den Link
        let forCheck = sharedText.map { $0.contains(s) ? $0 : "\($0) \(s)" } ?? s
        let enc = { (x: String) in x.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? x }
        let path = action == "check" ? "#/check?auto=1&u=\(enc(forCheck))" : "#/add?u=\(enc(s))"
        let center = UNUserNotificationCenter.current()
        center.getNotificationSettings { settings in
            let allowed = [.authorized, .provisional, .ephemeral].contains(settings.authorizationStatus)
            guard allowed else {
                DispatchQueue.main.async {
                    UIPasteboard.general.string = s
                    self.label.text = "Mitteilungen sind aus – der Link ist kopiert. Öffne den Kaufberater und füge ihn ein."
                    DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) { self.finish() }
                }
                return
            }
            let content = UNMutableNotificationContent()
            content.title = action == "check" ? "Ist das ein Deal?" : "Auf die Wunschliste"
            content.body = "Tippen, um es im Kaufberater zu öffnen."
            content.userInfo = ["path": path]
            content.threadIdentifier = "kaufberater-share"
            let req = UNNotificationRequest(identifier: "share-\(UUID().uuidString)", content: content,
                                            trigger: UNTimeIntervalNotificationTrigger(timeInterval: 1, repeats: false))
            center.add(req) { _ in DispatchQueue.main.async { self.finish() } }
        }
    }

    private func finish() {
        extensionContext?.completeRequest(returningItems: nil)
    }
}
