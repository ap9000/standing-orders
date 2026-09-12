import AppKit
import WebKit
import Security
import CryptoKit

struct Login: Codable { let name: String; let password: String }
struct Settings: Decodable { let databaseFile: String; let repos: [String]; let port: Int; let identity: String; let names: [String]; let importable: Bool }

@MainActor
final class DesktopApp: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate {
    var window: NSWindow!
    var web: WKWebView!
    var status: NSTextField!
    var settings: Settings?
    var login: Login?
    var serviceStarting = false
    var attemptedLogin = false
    var stateDir: URL!
    var node: String = ""
    var helper: String = ""
    var label = "com.standing-orders.desktop"
    let keychainService = "com.standing-orders.desktop.login"

    func applicationDidFinishLaunching(_ notification: Notification) { Task { await launch() } }

    func launch() async {
        let args = CommandLine.arguments
        if let index = args.firstIndex(of: "--state"), args.count > index + 1 { stateDir = URL(fileURLWithPath: args[index + 1]) }
        else { stateDir = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/Standing Orders") }
        // A separate service and Keychain entry for disposable test installations.
        if args.contains("--state") {
            let suffix = SHA256.hash(data: Data(stateDir.standardizedFileURL.path.utf8)).prefix(8).map { String(format: "%02x", $0) }.joined()
            label += ".preview." + suffix
        }
        do {
            let resources = Bundle.main.resourceURL!
            let runtime = try JSONSerialization.jsonObject(with: Data(contentsOf: resources.appendingPathComponent("runtime.json"))) as! [String: String]
            node = runtime["node"]!
            helper = resources.appendingPathComponent("dist/desktop-host.js").path
            try FileManager.default.createDirectory(at: stateDir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            makeWindow()
            makeMenu()
            settings = try await inspect()
            login = try? readLogin()
            if login == nil && settings!.importable {
                let imported = try JSONDecoder().decode(Login.self, from: await command("import-login"))
                try saveLogin(imported)
                login = imported
                // Keep the CLI’s existing owner-only login usable. Keychain is the shell’s copy.
                guard try readLogin().password == imported.password else { throw keychainError(errSecDecode) }
            }
            if login == nil { await signInFlow() }
            if settings!.repos.isEmpty { await chooseRepositoryFlow() }
            else { await startServiceFlow() }
        } catch { showError(error.localizedDescription) }
    }

    func makeWindow() {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 850), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "Standing Orders"
        window.subtitle = "Your local control console"
        window.minSize = NSSize(width: 760, height: 560)
        window.isReleasedWhenClosed = false
        let container = NSView()
        let bar = NSStackView()
        bar.orientation = .horizontal
        bar.spacing = 10
        for (title, selector) in [("Overview", #selector(openOverview)), ("Project setup", #selector(openControl)), ("Refresh", #selector(refresh)), ("Sign in", #selector(signIn))] {
            bar.addArrangedSubview(NSButton(title: title, target: self, action: selector))
        }
        let spacer = NSView(); spacer.setContentHuggingPriority(.defaultLow, for: .horizontal); bar.addArrangedSubview(spacer)
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = self
        web.uiDelegate = self
        web.allowsBackForwardNavigationGestures = true
        status = NSTextField(labelWithString: "Starting the local console…")
        status.font = NSFont.systemFont(ofSize: 11)
        status.textColor = .secondaryLabelColor
        for view in [bar, web!, status!] { view.translatesAutoresizingMaskIntoConstraints = false; container.addSubview(view) }
        NSLayoutConstraint.activate([
            bar.topAnchor.constraint(equalTo: container.topAnchor, constant: 10), bar.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 16), bar.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -16),
            web.topAnchor.constraint(equalTo: bar.bottomAnchor, constant: 10), web.leadingAnchor.constraint(equalTo: container.leadingAnchor), web.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            status.topAnchor.constraint(equalTo: web.bottomAnchor, constant: 7), status.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 16), status.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -16), status.bottomAnchor.constraint(equalTo: container.bottomAnchor, constant: -7)
        ])
        window.contentView = container
        window.center(); window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
    }

    func makeMenu() {
        let menu = NSMenu()
        let appItem = NSMenuItem(); menu.addItem(appItem)
        let appMenu = NSMenu(); appItem.submenu = appMenu
        appMenu.addItem(withTitle: "About Standing Orders", action: #selector(about), keyEquivalent: "").target = self
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit Standing Orders", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        let fileItem = NSMenuItem(); menu.addItem(fileItem)
        let file = NSMenu(title: "File"); fileItem.submenu = file
        for (title, action, key) in [("Overview", #selector(openOverview), "1"), ("Add projects…", #selector(chooseRepository), "o"), ("Project setup", #selector(openControl), ","), ("Refresh", #selector(refresh), "r"), ("Sign in…", #selector(signIn), "l"), ("Open service logs", #selector(openLogs), ""), ("Start background service", #selector(startService), ""), ("Stop background service…", #selector(stopService), "")] {
            file.addItem(withTitle: title, action: action, keyEquivalent: key).target = self
        }
        let editItem = NSMenuItem(); menu.addItem(editItem)
        let edit = NSMenu(title: "Edit"); editItem.submenu = edit
        for (title, selector, key) in [("Undo", Selector(("undo:")), "z"), ("Cut", #selector(NSText.cut(_:)), "x"), ("Copy", #selector(NSText.copy(_:)), "c"), ("Paste", #selector(NSText.paste(_:)), "v"), ("Select All", #selector(NSText.selectAll(_:)), "a")] { edit.addItem(withTitle: title, action: selector, keyEquivalent: key) }
        NSApp.mainMenu = menu
    }

    func process(_ executable: String, _ args: [String], input: Data? = nil) async throws -> Data {
        let runtimeDirectory = URL(fileURLWithPath: node).deletingLastPathComponent().path
        return try await Task.detached {
            let task = Process(); task.executableURL = URL(fileURLWithPath: executable); task.arguments = args
            var environment = ProcessInfo.processInfo.environment
            environment["PATH"] = [runtimeDirectory, FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".local/bin").path, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].joined(separator: ":")
            task.environment = environment
            // Private files prevent pipe deadlock and keep credential output off logs.
            let directory = FileManager.default.temporaryDirectory.appendingPathComponent("standing-orders-" + UUID().uuidString)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
            defer { try? FileManager.default.removeItem(at: directory) }
            let outputURL = directory.appendingPathComponent("stdout"), errorURL = directory.appendingPathComponent("stderr")
            for url in [outputURL, errorURL] { FileManager.default.createFile(atPath: url.path, contents: nil, attributes: [.posixPermissions: 0o600]) }
            let output = try FileHandle(forWritingTo: outputURL), errors = try FileHandle(forWritingTo: errorURL)
            defer { try? output.close(); try? errors.close() }
            task.standardOutput = output; task.standardError = errors
            if let input { let pipe = Pipe(); task.standardInput = pipe; try task.run(); pipe.fileHandleForWriting.write(input); try pipe.fileHandleForWriting.close() }
            else { task.standardInput = FileHandle.nullDevice; try task.run() }
            let deadline = Date().addingTimeInterval(args.contains("service-start") || args.contains("service-stop") ? 75 : 15)
            var refusal: String?
            while task.isRunning {
                let size = [outputURL, errorURL].reduce(Int64(0)) { total, url in total + (((try? FileManager.default.attributesOfItem(atPath: url.path)[.size]) as? NSNumber)?.int64Value ?? 0) }
                if Date() > deadline || size > 2_000_000 {
                    refusal = size > 2_000_000 ? "The local command returned too much output." : "The local command did not finish in time."
                    task.terminate()
                    try? await Task.sleep(nanoseconds: 200_000_000)
                    if task.isRunning { kill(task.processIdentifier, SIGKILL) }
                    break
                }
                try? await Task.sleep(nanoseconds: 20_000_000)
            }
            task.waitUntilExit()
            if let refusal { throw NSError(domain: "StandingOrders", code: 1, userInfo: [NSLocalizedDescriptionKey: refusal]) }
            let reader = try FileHandle(forReadingFrom: task.terminationStatus == 0 ? outputURL : errorURL)
            defer { try? reader.close() }
            let result = try reader.read(upToCount: 2_000_000) ?? Data()
            if task.terminationStatus != 0 { throw NSError(domain: "StandingOrders", code: Int(task.terminationStatus), userInfo: [NSLocalizedDescriptionKey: String(data: result, encoding: .utf8) ?? "The local command failed."]) }
            return result
        }.value
    }
    func command(_ name: String, extra: [String] = [], input: Login? = nil) async throws -> Data {
        try await process(node, [helper, name] + extra + ["--state", stateDir.path], input: input.map { try! JSONEncoder().encode($0) })
    }
    func inspect() async throws -> Settings { try JSONDecoder().decode(Settings.self, from: await command("inspect")) }

    func keychainQuery() -> [String: Any] { [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: keychainService, kSecAttrAccount as String: stateDir.path] }
    func saveLogin(_ value: Login) throws {
        let data = try JSONEncoder().encode(value)
        let query = keychainQuery()
        let updated = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if updated == errSecItemNotFound {
            var add = query; add[kSecValueData as String] = data; add[kSecAttrLabel as String] = "Standing Orders local sign-in"
            let result = SecItemAdd(add as CFDictionary, nil)
            if result != errSecSuccess { throw keychainError(result) }
        } else if updated != errSecSuccess { throw keychainError(updated) }
    }
    func readLogin() throws -> Login {
        var query = keychainQuery(); query[kSecReturnData as String] = true; query[kSecMatchLimit as String] = kSecMatchLimitOne
        var value: CFTypeRef?
        let result = SecItemCopyMatching(query as CFDictionary, &value)
        guard result == errSecSuccess, let data = value as? Data else { throw keychainError(result) }
        return try JSONDecoder().decode(Login.self, from: data)
    }
    func keychainError(_ code: OSStatus) -> Error { NSError(domain: NSOSStatusErrorDomain, code: Int(code), userInfo: [NSLocalizedDescriptionKey: "macOS Keychain could not save or read this sign-in (\(code))."]) }

    @objc func signIn() { Task { await signInFlow() } }
    func signInFlow() async {
        do {
            settings = try await inspect()
            let first = settings!.names.isEmpty
            let alert = NSAlert(); alert.messageText = first ? "Create your local operator account" : "Sign in to Standing Orders"
            alert.informativeText = "Your sign-in is saved in macOS Keychain. The background controller also keeps its existing private login file so it can restart. Approval buttons ask you to review the exact action."
            alert.addButton(withTitle: first ? "Create account" : "Sign in"); alert.addButton(withTitle: "Cancel")
            let fields = NSStackView(); fields.orientation = .vertical; fields.alignment = .leading; fields.spacing = 8
            let name = NSTextField(string: login?.name ?? settings!.names.first ?? NSUserName()); name.placeholderString = "Username"
            let password = NSSecureTextField(string: ""); password.placeholderString = "Password (at least 8 characters for a new account)"
            for field in [name, password] { field.frame.size = NSSize(width: 390, height: 24); fields.addArrangedSubview(field); field.widthAnchor.constraint(equalToConstant: 390).isActive = true }
            fields.frame = NSRect(x: 0, y: 0, width: 390, height: 64); alert.accessoryView = fields
            alert.window.initialFirstResponder = password
            if alert.runModal() != .alertFirstButtonReturn { return }
            let value = Login(name: name.stringValue, password: password.stringValue)
            if first { try saveLogin(value) }
            _ = try await command("pair", input: value)
            if !first { try saveLogin(value) }
            login = value; attemptedLogin = false
            if web.url != nil { connect(attempts: 1) }
        } catch { showError(error.localizedDescription) }
    }

    @objc func chooseRepository() { Task { await chooseRepositoryFlow() } }
    func chooseRepositoryFlow() async {
        let panel = NSOpenPanel(); panel.canChooseDirectories = true; panel.canChooseFiles = false; panel.allowsMultipleSelection = true
        panel.message = "Select one or more Git project folders. Hold Command to select several. Existing projects keep working while you add more."
        panel.prompt = "Add projects"
        guard panel.runModal() == .OK, !panel.urls.isEmpty else { return }
        do {
            _ = try await command("add-repos", extra: panel.urls.map { $0.path }); settings = try await inspect()
            await startServiceFlow()
        } catch { showError(error.localizedDescription) }
    }

    var base: URL? { settings.flatMap { URL(string: "http://127.0.0.1:\($0.port)") } }
    func isConsole(_ url: URL?) -> Bool { guard let url, let base else { return false }; return url.scheme == base.scheme && url.host == base.host && url.port == base.port }
    @objc func startService() { Task { await startServiceFlow() } }
    func startServiceFlow() async {
        guard !serviceStarting else { return }
        serviceStarting = true
        defer { serviceStarting = false }
        do {
            settings = try await inspect()
            guard !settings!.repos.isEmpty else { status.stringValue = "Choose a repository to begin."; return }
            // The service definition and its lifecycle live in the shared helper
            // (daemon.ts): the same launchd contract the CLI daemon uses — always
            // relaunched after a crash or an unexpected clean exit, an idempotent
            // start that never kills a healthy running controller because this
            // window reopened, and a real reload when the runtime or entry changed.
            _ = try await command("service-start", extra: ["--node", node, "--helper", helper, "--label", label])
            status.stringValue = "Connecting to the background service…"
            connect(attempts: 25)
        } catch { showError(error.localizedDescription) }
    }
    func connect(attempts: Int) {
        guard let base, let expected = settings?.identity else { return }
        let challenge = (UUID().uuidString + UUID().uuidString).replacingOccurrences(of: "-", with: "").lowercased()
        let keyBytes = stride(from: 0, to: expected.count, by: 2).compactMap { offset -> UInt8? in
            let start = expected.index(expected.startIndex, offsetBy: offset)
            return UInt8(expected[start..<expected.index(start, offsetBy: 2)], radix: 16)
        }
        guard keyBytes.count == 32 else { showError("The local connection identity is invalid."); return }
        let proof = HMAC<SHA256>.authenticationCode(for: Data(challenge.utf8), using: SymmetricKey(data: Data(keyBytes))).map { String(format: "%02x", $0) }.joined()
        var health = URLComponents(url: base.appendingPathComponent("desktop/health"), resolvingAgainstBaseURL: false)!
        health.queryItems = [URLQueryItem(name: "challenge", value: challenge)]
        let healthRequest = URLRequest(url: health.url!, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 2)
        URLSession.shared.dataTask(with: healthRequest) { data, response, _ in
            let identity = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: String] }?["proof"]
            DispatchQueue.main.async {
                guard (response as? HTTPURLResponse)?.statusCode == 200, identity == proof else {
                    if attempts > 1 { DispatchQueue.main.asyncAfter(deadline: .now() + 1) { self.connect(attempts: attempts - 1) } }
                    else { self.status.stringValue = "Service unavailable. File → Start background service or Open service logs." }
                    return
                }
                self.attemptedLogin = false
                self.loadLogin()
                self.status.stringValue = "Local service connected · Closing this window keeps workers running"
            }
        }.resume()
    }
    func loadLogin() {
        guard let base else { return }
        guard let login else { web.load(URLRequest(url: base.appendingPathComponent("login"))); return }
        var fields = URLComponents(); fields.queryItems = [URLQueryItem(name: "name", value: login.name), URLQueryItem(name: "token", value: login.password)]
        var request = URLRequest(url: base.appendingPathComponent("login")); request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.httpBody = fields.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B").data(using: .utf8)
        attemptedLogin = true
        web.load(request)
    }
    @objc func openOverview() { if let base { web.load(URLRequest(url: base.appendingPathComponent("workbench"))) } }
    @objc func openControl() { if let base { web.load(URLRequest(url: base.appendingPathComponent("control"))) } }
    @objc func refresh() { if web.url == nil { startService() } else { web.reload() } }
    @objc func openLogs() { NSWorkspace.shared.open(stateDir) }
    @objc func about() {
        let alert = NSAlert(); alert.messageText = "Standing Orders"; alert.informativeText = "A local console for approved coding work. The background service runs independently of this window. Project setup shares the same approval and execution controls as the web console."; alert.runModal()
    }
    @objc func stopService() { Task { await stopServiceFlow() } }
    func stopServiceFlow() async {
        let alert = NSAlert(); alert.messageText = "Stop the background service?"
        alert.informativeText = "This stops the local console and its workers. The controller stops accepting new work and finishes shutdown through its normal recovery path. Closing the window alone keeps work running."
        alert.addButton(withTitle: "Stop service"); alert.addButton(withTitle: "Keep running")
        if alert.runModal() != .alertFirstButtonReturn { return }
        // Explicit stop unloads AND disables the service; only Start background
        // service (an install) brings it back — no relaunch at the next login.
        do { _ = try await command("service-stop", extra: ["--node", node, "--helper", helper, "--label", label]); status.stringValue = "Background service stopped and disabled. File → Start background service to return." }
        catch { showError(error.localizedDescription) }
    }
    func showError(_ text: String) { if status != nil { status.stringValue = "Needs attention: \(text.prefix(180))" }; let alert = NSAlert(); alert.messageText = "Standing Orders needs attention"; alert.informativeText = text; alert.runModal() }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if isConsole(action.request.url) || action.request.url?.absoluteString == "about:blank" { decisionHandler(.allow); return }
        if action.navigationType == .linkActivated, let url = action.request.url, ["https", "http"].contains(url.scheme ?? "") { NSWorkspace.shared.open(url) }
        decisionHandler(.cancel)
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard isConsole(webView.url) else { return }
        if webView.url?.path == "/login" {
            if !attemptedLogin { loadLogin() }
            else { status.stringValue = "Sign in to continue. Use Sign in above to update your saved credential." }
            return
        }
        attemptedLogin = false
        // Approval credentials are entered by the operator at the review screen.

    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { status.stringValue = "Console unavailable. Use File → Start background service to reconnect." }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if action.navigationType == .linkActivated, let url = action.request.url, ["https", "http"].contains(url.scheme ?? "") { NSWorkspace.shared.open(url) }; return nil
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool { window.makeKeyAndOrderFront(nil); return true }
}

@main
enum Main {
    @MainActor static func main() {
        let app = NSApplication.shared
        let delegate = DesktopApp()
        app.delegate = delegate
        app.setActivationPolicy(.regular)
        withExtendedLifetime(delegate) { app.run() }
    }
}
