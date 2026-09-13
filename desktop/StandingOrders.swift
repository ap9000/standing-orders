import AppKit
import WebKit
import Security
import CryptoKit
import UniformTypeIdentifiers

struct Login: Codable { let name: String; let password: String }
struct Settings: Decodable { let databaseFile: String; let repos: [String]; let port: Int; let identity: String; let names: [String]; let importable: Bool }
struct DesktopRuntime: Decodable { let node: String; let providerBin: String?; let bundleId: String?; let development: Bool?; let buildId: String? }
struct ProjectAccess: Decodable { let repo: String; let state: String; let message: String }
struct AccessStatus: Decodable { let ready: Bool; let verified: Bool; let projects: [ProjectAccess] }
struct DatabaseStatus: Decodable { let ready: Bool; let message: String }
struct ServiceLiveness: Decodable { let alive: Bool; let problem: String? }
struct ServiceStatus: Decodable { let state: String; let database: DatabaseStatus; let liveness: ServiceLiveness? }
struct UpdateStatus: Decodable { let active: Bool; let phase: String; let detail: String; let running: Bool; let canResume: Bool; let canCancel: Bool; let buildId: String?; let workDir: String?; let wasRunning: Bool? }
struct UpdateBuild: Decodable { let version: String; let buildId: String }
struct UpdatePreview: Decodable { let digest: String; let message: String; let old: UpdateBuild; let next: UpdateBuild }

@MainActor
final class DesktopApp: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate {
    var window: NSWindow!
    var web: WKWebView!
    var status: NSTextField!
    var accessPanel: NSStackView!
    var accessDetail: NSTextField!
    var accessHeight: NSLayoutConstraint!
    var settings: Settings?
    var login: Login?
    var serviceStarting = false
    var attemptedLogin = false
    var connectionGeneration = 0
    var consoleConnected = false
    var stateDir: URL!
    var node: String = ""
    var providerBin: String = ""
    var helper: String = ""
    var label = "com.standing-orders.desktop"
    var bundleId = "com.standing-orders.desktop"
    var development = false
    var buildId = ""
    var updatePolling = false
    var updateRequiresReopen = false
    var serviceArguments: [String] { ["--node", node, "--helper", helper, "--label", label, "--provider-bin", providerBin, "--bundle-id", bundleId] + (buildId.isEmpty ? [] : ["--build-id", buildId]) }
    var keychainService: String { bundleId + ".login" }

    func applicationDidFinishLaunching(_ notification: Notification) { Task { await launch() } }

    func launch() async {
        let args = CommandLine.arguments
        bundleId = Bundle.main.bundleIdentifier ?? bundleId
        label = bundleId
        development = bundleId.hasSuffix(".development")
        if let index = args.firstIndex(of: "--state"), args.count > index + 1 { stateDir = URL(fileURLWithPath: args[index + 1]) }
        else { stateDir = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/" + (development ? "Standing Orders Development" : "Standing Orders")) }
        // A separate service and Keychain entry for disposable test installations.
        if args.contains("--state") {
            let suffix = SHA256.hash(data: Data(stateDir.standardizedFileURL.path.utf8)).prefix(8).map { String(format: "%02x", $0) }.joined()
            label += ".preview." + suffix
        }
        do {
            let resources = Bundle.main.resourceURL!
            let runtime = try JSONDecoder().decode(DesktopRuntime.self, from: Data(contentsOf: resources.appendingPathComponent("runtime.json")))
            buildId = runtime.buildId ?? ""
            let configuredNode = runtime.node
            node = configuredNode.hasPrefix("/") ? configuredNode : resources.appendingPathComponent(configuredNode).standardizedFileURL.path
            providerBin = runtime.providerBin ?? URL(fileURLWithPath: node).deletingLastPathComponent().path
            helper = resources.appendingPathComponent("dist/desktop-host.js").path
            try FileManager.default.createDirectory(at: stateDir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            makeWindow()
            makeMenu()
            let update = try JSONDecoder().decode(UpdateStatus.self, from: await command("update-status"))
            if update.active {
                status.stringValue = update.detail
                if update.canResume && update.phase != "needs-attention" { _ = try await command("update-resume") }
                pollUpdate(); return
            }
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
            if args.contains("--keep-service-stopped") { status.stringValue = "Update verified · Background service remains stopped. Use File → Start background service when ready."; return }
            if settings!.repos.isEmpty { await chooseRepositoryFlow() }
            else { await startServiceFlow() }
        } catch { await showInstallationStatus(fallback: error.localizedDescription) }
    }

    func makeWindow() {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 850), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = development ? "Standing Orders Development" : "Standing Orders"
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
        accessPanel = NSStackView(); accessPanel.orientation = .vertical; accessPanel.alignment = .leading; accessPanel.spacing = 8
        let title = NSTextField(labelWithString: "Finish project access"); title.font = .systemFont(ofSize: 16, weight: .semibold)
        accessDetail = NSTextField(wrappingLabelWithString: "Your background worker is checking the projects you selected.")
        accessDetail.font = .systemFont(ofSize: 13); accessDetail.textColor = .secondaryLabelColor
        let actions = NSStackView(views: [NSButton(title: "Open Privacy Settings", target: self, action: #selector(openPrivacySettings)), NSButton(title: "Check again", target: self, action: #selector(recheckAccess)), NSButton(title: "Choose project folders…", target: self, action: #selector(chooseRepository))])
        actions.spacing = 8
        for view in [title, accessDetail!, actions] { accessPanel.addArrangedSubview(view) }
        accessPanel.isHidden = true
        for view in [bar, accessPanel!, web!, status!] { view.translatesAutoresizingMaskIntoConstraints = false; container.addSubview(view) }
        accessHeight = accessPanel.heightAnchor.constraint(equalToConstant: 0)
        NSLayoutConstraint.activate([
            bar.topAnchor.constraint(equalTo: container.topAnchor, constant: 10), bar.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 16), bar.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -16),
            accessPanel.topAnchor.constraint(equalTo: bar.bottomAnchor, constant: 10), accessPanel.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 20), accessPanel.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -20), accessHeight,
            accessDetail.widthAnchor.constraint(equalTo: accessPanel.widthAnchor),
            web.topAnchor.constraint(equalTo: accessPanel.bottomAnchor, constant: 10), web.leadingAnchor.constraint(equalTo: container.leadingAnchor), web.trailingAnchor.constraint(equalTo: container.trailingAnchor),
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
        for (title, action, key) in [("Overview", #selector(openOverview), "1"), ("Add projects…", #selector(chooseRepository), "o"), ("Project setup", #selector(openControl), ","), ("Check project access", #selector(recheckAccess), ""), ("Check installation", #selector(checkInstallation), ""), ("Refresh", #selector(refresh), "r"), ("Sign in…", #selector(signIn), "l"), ("Open service logs", #selector(openLogs), ""), ("Start background service", #selector(startService), ""), ("Stop background service…", #selector(stopService), "")] {
            file.addItem(withTitle: title, action: action, keyEquivalent: key).target = self
        }
        file.addItem(.separator())
        file.addItem(withTitle: "Install app update…", action: #selector(installUpdate), keyEquivalent: "").target = self
        file.addItem(withTitle: "Update status…", action: #selector(updateStatus), keyEquivalent: "").target = self
        let editItem = NSMenuItem(); menu.addItem(editItem)
        let edit = NSMenu(title: "Edit"); editItem.submenu = edit
        for (title, selector, key) in [("Undo", Selector(("undo:")), "z"), ("Cut", #selector(NSText.cut(_:)), "x"), ("Copy", #selector(NSText.copy(_:)), "c"), ("Paste", #selector(NSText.paste(_:)), "v"), ("Select All", #selector(NSText.selectAll(_:)), "a")] { edit.addItem(withTitle: title, action: selector, keyEquivalent: key) }
        NSApp.mainMenu = menu
    }

    func process(_ executable: String, _ args: [String], input: Data? = nil) async throws -> Data {
        let runtimeDirectory = URL(fileURLWithPath: node).deletingLastPathComponent().path
        let providerDirectory = providerBin
        return try await Task.detached {
            let task = Process(); task.executableURL = URL(fileURLWithPath: executable); task.arguments = args
            var environment = ProcessInfo.processInfo.environment
            environment["PATH"] = [runtimeDirectory, providerDirectory, FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".local/bin").path, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].joined(separator: ":")
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
            let deadline = Date().addingTimeInterval(args.contains("service-start") || args.contains("service-stop") || args.contains("update-preview") || args.contains("update-start") ? 150 : 15)
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
        if updateRequiresReopen { await showUpdateStatus(); return }
        guard !serviceStarting else { return }
        serviceStarting = true
        connectionGeneration += 1; consoleConnected = false
        defer { serviceStarting = false }
        do {
            settings = try await inspect()
            guard !settings!.repos.isEmpty else { status.stringValue = "Choose a repository to begin."; return }
            // The service definition and its lifecycle live in the shared helper
            // (daemon.ts): the same launchd contract the CLI daemon uses — always
            // supervised across controller exits, with an idempotent
            // start that never kills a healthy running controller because this
            // window reopened, and a real reload when the runtime or entry changed.
            _ = try await command("service-start", extra: serviceArguments)
            status.stringValue = "Connecting to the background service…"
            connect(attempts: 25)
        } catch { showError(error.localizedDescription) }
    }
    func connect(attempts: Int) {
        let generation = connectionGeneration
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
                guard generation == self.connectionGeneration else { return }
                guard (response as? HTTPURLResponse)?.statusCode == 200, identity == proof else {
                    if attempts % 5 == 0 { Task { await self.showAccessStatus(connected: false) } }
                    if attempts > 1 { DispatchQueue.main.asyncAfter(deadline: .now() + 1) { self.connect(attempts: attempts - 1) } }
                    else { Task { await self.showAccessStatus(connected: false) } }
                    return
                }
                self.attemptedLogin = false
                self.consoleConnected = true
                self.loadLogin()
                Task { await self.showAccessStatus(connected: true) }
            }
        }.resume()
    }
    func showAccessStatus(connected: Bool, attempts: Int = 10) async {
        let generation = connectionGeneration
        do {
            let access = try JSONDecoder().decode(AccessStatus.self, from: await command("access-status"))
            guard generation == connectionGeneration, connected || !consoleConnected else { return }
            if access.ready && connected {
                accessPanel.isHidden = true; accessHeight.constant = 0
                status.stringValue = "Project access verified · Closing this window keeps workers running" + (development ? " · Development preview" : "")
                return
            }
            let blocked = access.projects.filter { $0.state != "ready" }
            let summary = blocked.prefix(3).map { URL(fileURLWithPath: $0.repo).lastPathComponent + ": " + $0.message }.joined(separator: "\n")
            accessDetail.stringValue = summary.isEmpty ? "Folder access passed. Waiting for the background worker to reconnect. Check again shortly; if it still cannot connect, open service logs from the File menu." : summary + (blocked.count > 3 ? "\nAnd \(blocked.count - 3) more projects." : "")
            accessHeight.constant = min(220, CGFloat(105 + blocked.prefix(3).count * 30)); accessPanel.isHidden = false
            status.stringValue = connected ? "Console connected · Project setup is incomplete" : "Setup needs attention · Your tasks are preserved"
            if connected && attempts > 1 && (blocked.isEmpty || blocked.contains(where: { $0.state == "checking" })) {
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                if generation == connectionGeneration { await showAccessStatus(connected: connected, attempts: attempts - 1) }
            }
        } catch {
            guard generation == connectionGeneration, connected || !consoleConnected else { return }
            accessDetail.stringValue = "The background worker has not confirmed access. Check again after handling any macOS prompt. If this continues, open service logs from the File menu."
            accessHeight.constant = 130; accessPanel.isHidden = false
            status.stringValue = "Project access has not been verified"
        }
    }
    @objc func openPrivacySettings() {
        NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders")!)
    }
    @objc func recheckAccess() { Task {
        do { _ = try await command("access-recheck"); await startServiceFlow() }
        catch { showError(error.localizedDescription) }
    } }
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
    @objc func installUpdate() { Task {
        let panel = NSOpenPanel(); panel.canChooseFiles = true; panel.canChooseDirectories = false; panel.allowsMultipleSelection = false; panel.allowedContentTypes = [.applicationBundle]
        panel.message = "Choose the new Standing Orders app. You will review it before anything changes."
        panel.prompt = "Review update"
        guard panel.runModal() == .OK, let candidate = panel.url else { return }
        let arguments = ["--installed", Bundle.main.bundleURL.path, "--candidate", candidate.path, "--label", label]
        do {
            status.stringValue = "Checking the update’s signature and compatibility…"
            let preview = try JSONDecoder().decode(UpdatePreview.self, from: await command("update-preview", extra: arguments))
            let alert = NSAlert(); alert.messageText = "Install Standing Orders \(preview.next.version)?"
            alert.informativeText = "Current build: \(preview.old.buildId.prefix(8))\nNew build: \(preview.next.buildId.prefix(8))\n\n" + preview.message + "\n\nThe update can continue if you close this window. Your previous service state will be preserved."
            alert.addButton(withTitle: "Install update"); alert.addButton(withTitle: "Not now")
            guard alert.runModal() == .alertFirstButtonReturn else { status.stringValue = "Update not started."; return }
            _ = try await command("update-start", extra: arguments + ["--digest", preview.digest])
            pollUpdate()
        } catch { showError(error.localizedDescription) }
    } }
    @objc func updateStatus() { Task { await showUpdateStatus() } }
    func pollUpdate() {
        guard !updatePolling else { return }; updatePolling = true
        Task {
            defer { updatePolling = false }
            do {
                while true {
                    let update = try JSONDecoder().decode(UpdateStatus.self, from: await command("update-status"))
                    status.stringValue = update.detail
                    if !update.active {
                        updateRequiresReopen = update.phase == "complete" && update.buildId != buildId
                        if updateRequiresReopen { status.stringValue = "Update complete and verified · Use File → Update status to reopen the updated app." }
                        return
                    }
                    if update.canResume { status.stringValue = "Update needs attention · File → Update status has recovery options."; return }
                    try await Task.sleep(nanoseconds: 2_000_000_000)
                }
            } catch { status.stringValue = "Update status unavailable · Open service logs. The update may still be running." }
        }
    }
    func showUpdateStatus() async {
        do {
            let update = try JSONDecoder().decode(UpdateStatus.self, from: await command("update-status"))
            let reopen = update.phase == "complete" && update.buildId != buildId
            let alert = NSAlert(); alert.messageText = reopen ? "Your update is ready" : update.active ? "App update" : "Update status"
            alert.informativeText = update.detail
            alert.addButton(withTitle: reopen ? "Reopen updated app" : update.canResume ? "Retry safely" : "Done")
            if update.canCancel { alert.addButton(withTitle: "Cancel update / keep previous app") }
            else if reopen { alert.addButton(withTitle: "Later") }
            if update.workDir != nil { alert.addButton(withTitle: "Open update files") }
            let answer = alert.runModal()
            if answer == .alertFirstButtonReturn {
                if reopen {
                    let configuration = NSWorkspace.OpenConfiguration(); configuration.createsNewApplicationInstance = true; configuration.arguments = ["--state", stateDir.path]
                    // Preserve the standard service label for the default state.
                    if !CommandLine.arguments.contains("--state") { configuration.arguments = [] }
                    if update.wasRunning == false { configuration.arguments += ["--keep-service-stopped"] }
                    NSWorkspace.shared.openApplication(at: Bundle.main.bundleURL, configuration: configuration) { _, error in
                        DispatchQueue.main.async { if let error { self.showError(error.localizedDescription) } else { NSApp.terminate(nil) } }
                    }
                } else if update.canResume { _ = try await command("update-resume"); pollUpdate() }
            } else if answer == .alertSecondButtonReturn && update.canCancel {
                _ = try await command("update-cancel"); pollUpdate()
            } else if let path = update.workDir, answer == .alertThirdButtonReturn || (answer == .alertSecondButtonReturn && !reopen && !update.canCancel) { NSWorkspace.shared.open(URL(fileURLWithPath: path)) }
        } catch { showError(error.localizedDescription) }
    }
    @objc func checkInstallation() { Task { await showInstallationStatus() } }
    func showInstallationStatus(fallback: String? = nil) async {
        do {
            let result = try JSONDecoder().decode(ServiceStatus.self, from: await command("service-status", extra: serviceArguments))
            let connected = result.liveness?.alive == true
            let serviceMessage = result.state == "disabled" ? "The background service is stopped. Use File → Start background service when you are ready." : connected ? "The local console is responding. Use Check project access to verify the worker can reach your projects." : result.state == "running" ? "The background service started, but the console is not responding. Check project access or open service logs; a running process alone does not mean work is ready." : "The background service is not running. Use File → Start background service after resolving any setup issue."
            let alert = NSAlert(); alert.messageText = !result.database.ready ? "Your saved tasks need attention" : connected ? "Console connected" : "Background service needs attention"
            alert.informativeText = result.database.message + "\n\n" + serviceMessage + (fallback.map { "\n\nStartup details: " + $0 } ?? "")
            alert.addButton(withTitle: "Done"); alert.addButton(withTitle: "Open service logs")
            if status != nil { status.stringValue = alert.messageText }
            if alert.runModal() == .alertSecondButtonReturn { openLogs() }
        } catch { showError(fallback ?? error.localizedDescription) }
    }
    @objc func about() {
        let alert = NSAlert(); alert.messageText = "Standing Orders"; alert.informativeText = "A local console for approved coding work. The background service runs independently of this window. Project setup shares the same approval and execution controls as the web console."; alert.runModal()
    }
    @objc func stopService() { Task { await stopServiceFlow() } }
    func stopServiceFlow() async {
        if let update = try? JSONDecoder().decode(UpdateStatus.self, from: await command("update-status")), update.active { await showUpdateStatus(); return }
        let alert = NSAlert(); alert.messageText = "Stop the background service?"
        alert.informativeText = "This stops the local console and its workers. The controller stops accepting new work and finishes shutdown through its normal recovery path. Closing the window alone keeps work running."
        alert.addButton(withTitle: "Stop service"); alert.addButton(withTitle: "Keep running")
        if alert.runModal() != .alertFirstButtonReturn { return }
        // Explicit stop unloads AND disables the service; only Start background
        // service (an install) brings it back — no relaunch at the next login.
        do { _ = try await command("service-stop", extra: serviceArguments); connectionGeneration += 1; consoleConnected = false; status.stringValue = "Background service stopped and disabled. File → Start background service to return." }
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
