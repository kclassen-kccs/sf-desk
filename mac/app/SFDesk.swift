// SF Desk.app: runs the SF Desk server it carries inside (Contents/Resources: Node.js, the app and its
// node_modules) and shows it in its own window. Settings and data live outside the bundle, in
// ~/Library/Application Support/SF Desk (.env, data/, certs/, sf-cli/), so replacing the app with a new
// version keeps them. Built by scripts/build-mac-app.sh; AppKit and WebKit only.
//
// On launch it makes the support folder (copying .env, data and certs from ~/SF-Desk or a Git checkout
// the first time), finds or downloads the Salesforce CLI and signs in to Salesforce if needed, then starts
// the server (or uses one already answering on the port) and loads it. Quitting stops the server it
// started. Closing the window keeps it running for the Outlook add-in; click the Dock icon to get it back.
// macOS asks SF Desk itself, not Terminal, for calendar access.

import AppKit
@preconcurrency import WebKit

let fm = FileManager.default
let home = fm.homeDirectoryForCurrentUser
let supportDir = home.appendingPathComponent("Library/Application Support/SF Desk")
let logDir = home.appendingPathComponent("Library/Logs/SF Desk")
let logFile = logDir.appendingPathComponent("server.log")
let envFile = supportDir.appendingPathComponent(".env")
let resources = Bundle.main.resourceURL!
let appDir = resources.appendingPathComponent("app")
let bundledNode = resources.appendingPathComponent("node/bin/node")
let calendarHelper = Bundle.main.executableURL!.deletingLastPathComponent().appendingPathComponent("sfdesk-calendar")

// The SailPoint org, as the installer (mac/package) sets it up.
let sfInstance = "https://sailpoint.my.salesforce.com"
let sfAlias = "sailpoint"
let sfTarballBase = "https://developer.salesforce.com/media/salesforce-cli/sf/channels/stable"

// Where an install or checkout from before the app may keep its data, in the order to look.
let oldDirs = ["SF-Desk", "Documents/GitHub/SF-Desk", "Documents/GitHub/sf-desk", "Documents/SF-Desk",
               "GitHub/SF-Desk", "Developer/SF-Desk", "Projects/SF-Desk"].map { home.appendingPathComponent($0) }

struct Failure: Error { let message: String }

// MARK: - Helpers

@discardableResult
func run(_ exe: String, _ args: [String], env: [String: String]? = nil, timeout: TimeInterval = 120) -> (status: Int32, output: String) {
  let p = Process()
  p.executableURL = URL(fileURLWithPath: exe)
  p.arguments = args
  if let env { p.environment = env }
  let pipe = Pipe()
  p.standardOutput = pipe
  p.standardError = pipe
  p.standardInput = FileHandle.nullDevice
  do { try p.run() } catch { return (-1, error.localizedDescription) }
  let timer = DispatchWorkItem { if p.isRunning { p.terminate() } }
  DispatchQueue.global().asyncAfter(deadline: .now() + timeout, execute: timer)
  let data = pipe.fileHandleForReading.readDataToEndOfFile()
  p.waitUntilExit()
  timer.cancel()
  return (p.terminationStatus, String(decoding: data, as: UTF8.self))
}

func isExecutable(_ path: String) -> Bool { !path.isEmpty && fm.isExecutableFile(atPath: path) }

// PATH as the user's shell sets it, since apps opened from Finder only get /usr/bin:/bin:/usr/sbin:/sbin.
func shellPath() -> String {
  let fallback = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
  let shell = getpwuid(getuid()).flatMap { String(cString: $0.pointee.pw_shell) }.flatMap { isExecutable($0) ? $0 : nil } ?? "/bin/zsh"
  let r = run(shell, ["-i", "-l", "-c", "printf '\\n__PATH__%s\\n' \"$PATH\""], timeout: 10)
  guard let line = r.output.components(separatedBy: "\n").last(where: { $0.hasPrefix("__PATH__") }) else { return fallback }
  let path = String(line.dropFirst("__PATH__".count))
  return path.isEmpty ? fallback : path + ":" + fallback
}

func which(_ name: String, in path: String) -> String? {
  path.split(separator: ":").map { "\($0)/\(name)" }.first(where: isExecutable)
}

func readEnv() -> [String: String] {
  guard let text = try? String(contentsOf: envFile, encoding: .utf8) else { return [:] }
  var out: [String: String] = [:]
  for line in text.components(separatedBy: "\n") {
    let s = line.trimmingCharacters(in: .whitespaces)
    guard !s.hasPrefix("#"), let eq = s.firstIndex(of: "=") else { continue }
    var value = s[s.index(after: eq)...].trimmingCharacters(in: .whitespaces)
    if value.count >= 2, let q = value.first, q == "\"" || q == "'", value.last == q { value = String(value.dropFirst().dropLast()) }
    out[s[..<eq].trimmingCharacters(in: .whitespaces)] = value
  }
  return out
}

// Replaces KEY's line in .env, or adds it.
func setEnv(_ key: String, _ value: String) {
  var lines = ((try? String(contentsOf: envFile, encoding: .utf8)) ?? "").components(separatedBy: "\n")
  if let i = lines.firstIndex(where: { $0.hasPrefix(key + "=") }) {
    lines[i] = "\(key)=\(value)"
  } else {
    while lines.last == "" { lines.removeLast() }
    lines += ["\(key)=\(value)", ""]
  }
  try? lines.joined(separator: "\n").write(to: envFile, atomically: true, encoding: .utf8)
}

// Does the server answer? Any HTTP response counts.
func answers(_ url: URL) -> Bool {
  var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 1.5)
  req.httpMethod = "HEAD"
  let done = DispatchSemaphore(value: 0)
  let box = Box(false)
  URLSession.shared.dataTask(with: req) { _, resp, _ in box.value = resp is HTTPURLResponse; done.signal() }.resume()
  _ = done.wait(timeout: .now() + 3)
  return box.value
}

final class Box<T>: @unchecked Sendable {
  var value: T
  init(_ value: T) { self.value = value }
}

func tail(_ url: URL, lines: Int = 25) -> String {
  guard let text = try? String(contentsOf: url, encoding: .utf8) else { return "" }
  return text.components(separatedBy: "\n").suffix(lines).joined(separator: "\n")
}

func html(_ s: String) -> String {
  s.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;").replacingOccurrences(of: ">", with: "&gt;")
}

// MARK: - Server: first-launch setup, then the Node process. Runs off the main thread.

// What the server side needs from the window.
struct UI: Sendable {
  let status: @Sendable (String) -> Void
  let ready: @Sendable (URL) -> Void
  let fail: @Sendable (String) -> Void
  let ask: @Sendable (_ title: String, _ text: String, _ ok: String) -> Bool
}

final class Server: @unchecked Sendable {
  let ui: UI
  let lock = NSLock()
  var process: Process?
  var stdin: Pipe?
  var path = "/usr/bin:/bin:/usr/sbin:/sbin"
  var url = URL(string: "http://localhost:3000")!
  var quitting = false

  init(ui: UI) { self.ui = ui }

  func start() {
    do {
      try fm.createDirectory(at: supportDir, withIntermediateDirectories: true)
      try fm.createDirectory(at: logDir, withIntermediateDirectories: true)
      path = shellPath()
      migrate()
      if !fm.fileExists(atPath: envFile.path) {
        try fm.copyItem(at: appDir.appendingPathComponent(".env.example"), to: envFile)
        setEnv("SF_TARGET_ORG", sfAlias)
      }
      let env = readEnv()
      url = URL(string: "http://localhost:\(Int(env["PORT"] ?? "") ?? 3000)")!
      if answers(url) { return ui.ready(url) } // already running (another copy, or `npm start` in a checkout)
      if (env["SF_CLIENT_ID"] ?? "").isEmpty { try salesforceLogin(target: env["SF_TARGET_ORG"] ?? "") }
      try launch()
    } catch let f as Failure {
      ui.fail(f.message)
    } catch {
      ui.fail(error.localizedDescription)
    }
  }

  // Copies .env, data/, certs/ and the installer's sf-cli/ from the most recently used old install or
  // checkout, once.
  func migrate() {
    let marker = supportDir.appendingPathComponent(".migrated")
    guard !fm.fileExists(atPath: marker.path) else { return }
    var note = "Nothing to copy\n"
    defer { try? note.write(to: marker, atomically: true, encoding: .utf8) }
    if fm.fileExists(atPath: supportDir.appendingPathComponent("data/sf-desk.db").path) { return }

    let db = { (d: URL) in d.appendingPathComponent("data/sf-desk.db") }
    let used = { (d: URL) in ((try? fm.attributesOfItem(atPath: db(d).path))?[.modificationDate] as? Date) ?? .distantPast }
    let installs = oldDirs.filter { fm.fileExists(atPath: $0.appendingPathComponent("server.js").path) }
    guard let old = installs.filter({ fm.fileExists(atPath: db($0).path) }).max(by: { used($0) < used($1) })
            ?? installs.first(where: { fm.fileExists(atPath: $0.appendingPathComponent(".env").path) }) else { return }

    ui.status("Copying your settings and data from \(old.path.replacingOccurrences(of: home.path, with: "~"))...")
    for name in [".env", "data", "certs", "sf-cli"] {
      let from = old.appendingPathComponent(name), to = supportDir.appendingPathComponent(name)
      guard fm.fileExists(atPath: from.path), !fm.fileExists(atPath: to.path) else { continue }
      run("/usr/bin/ditto", [from.path, to.path], timeout: 600) // keeps permissions and the CLI's symlinks
    }
    try? fm.removeItem(at: supportDir.appendingPathComponent("data/bin")) // the old self-built calendar helper
    let oldCli = old.appendingPathComponent("sf-cli").path
    if let cli = readEnv()["SF_CLI_PATH"], cli.hasPrefix(oldCli + "/") {
      setEnv("SF_CLI_PATH", supportDir.appendingPathComponent("sf-cli").path + cli.dropFirst(oldCli.count))
    }
    note = "Copied from \(old.path)\n"
  }

  func findSf() -> String? {
    let configured = readEnv()["SF_CLI_PATH"] ?? ""
    if isExecutable(configured) { return configured }
    return [which("sf", in: path), "/usr/local/bin/sf", "/opt/homebrew/bin/sf",
            supportDir.appendingPathComponent("sf-cli/bin/sf").path].compactMap { $0 }.first(where: isExecutable)
  }

  // Salesforce's own build of the CLI, into the support folder: no admin rights, no npm.
  func downloadSf() throws -> String {
    ui.status("Downloading the Salesforce CLI from Salesforce...")
    let file = run("/usr/bin/uname", ["-m"]).output.contains("arm64") ? "sf-darwin-arm64.tar.xz" : "sf-darwin-x64.tar.xz"
    let tmp = fm.temporaryDirectory.appendingPathComponent("sfdesk-sf-\(UUID().uuidString)")
    defer { try? fm.removeItem(at: tmp) }
    try fm.createDirectory(at: tmp.appendingPathComponent("sf"), withIntermediateDirectories: true)
    let tarball = tmp.appendingPathComponent("sf.tar.xz").path
    let dl = run("/usr/bin/curl", ["-fsSL", "-o", tarball, "\(sfTarballBase)/\(file)"], timeout: 900)
    guard dl.status == 0 else { throw Failure(message: "Couldn't download the Salesforce CLI.\n\n\(dl.output)") }
    ui.status("Unpacking the Salesforce CLI...")
    let x = run("/usr/bin/tar", ["-xJf", tarball, "-C", tmp.appendingPathComponent("sf").path, "--strip-components", "1"], timeout: 600)
    guard x.status == 0 else { throw Failure(message: "Couldn't unpack the Salesforce CLI.\n\n\(x.output)") }
    let dest = supportDir.appendingPathComponent("sf-cli")
    try? fm.removeItem(at: dest)
    try fm.moveItem(at: tmp.appendingPathComponent("sf"), to: dest)
    return dest.appendingPathComponent("bin/sf").path
  }

  func salesforceLogin(target: String) throws {
    var sf = findSf()
    if sf == nil {
      guard ui.ask("SF Desk needs the Salesforce CLI",
                   "SF Desk signs in to Salesforce with it. Download Salesforce's own copy now? No admin rights are needed.",
                   "Download") else {
        throw Failure(message: "SF Desk needs the Salesforce CLI. Install it from https://developer.salesforce.com/tools/salesforcecli, then open SF Desk again.")
      }
      sf = try downloadSf()
    }
    guard let sf else { return }
    if readEnv()["SF_CLI_PATH"] != sf { setEnv("SF_CLI_PATH", sf) }

    ui.status("Checking your Salesforce login...")
    let env = ProcessInfo.processInfo.environment.merging(["PATH": path, "SF_AUTOUPDATE_DISABLE": "true"]) { $1 }
    let shown = run(sf, ["org", "display", "--json"] + (target.isEmpty ? [] : ["--target-org", target]), env: env)
    if shown.output.range(of: #""status":\s*0"#, options: .regularExpression) != nil { return }

    guard ui.ask("Sign in to Salesforce",
                 "Your browser will open the Salesforce login. Sign in with SSO as usual, then come back to SF Desk.",
                 "Sign In") else { return } // Connect then says what's missing.
    ui.status("Waiting for you to sign in to Salesforce in your browser...")
    let alias = target.isEmpty ? sfAlias : target
    let login = run(sf, ["org", "login", "web", "--instance-url", sfInstance, "--alias", alias], env: env, timeout: 900)
    guard login.status == 0 else {
      throw Failure(message: "Salesforce sign-in didn't finish. Quit SF Desk and open it again to retry.\n\n\(login.output)")
    }
    if target.isEmpty { setEnv("SF_TARGET_ORG", alias) }
  }

  func launch() throws {
    // The bundled Node is for Apple Silicon; an Intel Mac needs its own Node 22 or newer.
    guard let node = run(bundledNode.path, ["-v"], timeout: 30).status == 0 ? bundledNode.path : which("node", in: path) else {
      throw Failure(message: "This Mac can't run the Node.js inside SF Desk. Install Node.js 22 or newer from https://nodejs.org, then open SF Desk again.")
    }
    ui.status("Starting SF Desk...")
    try Data().write(to: logFile)
    let log = try FileHandle(forWritingTo: logFile)

    let p = Process()
    p.executableURL = URL(fileURLWithPath: node)
    p.arguments = [appDir.appendingPathComponent("server.js").path]
    p.currentDirectoryURL = supportDir // the server reads .env from its working folder
    p.environment = ProcessInfo.processInfo.environment.merging([
      "PATH": path,
      "SF_DESK_APP": "1",
      "SF_DESK_DB": supportDir.appendingPathComponent("data/sf-desk.db").path,
      "SF_DESK_CERTS": supportDir.appendingPathComponent("certs").path,
      "SF_DESK_CALENDAR_HELPER": calendarHelper.path,
      "SF_AUTOUPDATE_DISABLE": "true",
    ]) { $1 }
    let pipe = Pipe()
    p.standardInput = pipe // closes if the app dies, and the server then exits
    p.standardOutput = log
    p.standardError = log
    try p.run()
    lock.lock(); process = p; stdin = pipe; lock.unlock()

    for _ in 0..<120 {
      guard p.isRunning else { throw Failure(message: "The SF Desk server stopped while starting.\n\n\(tail(logFile))") }
      if answers(url) {
        p.terminationHandler = { [weak self] proc in
          guard let self, !self.quitting else { return }
          self.ui.fail("The SF Desk server stopped (exit code \(proc.terminationStatus)). Choose File > Restart Server to start it again.\n\n\(tail(logFile))")
        }
        return ui.ready(url)
      }
      Thread.sleep(forTimeInterval: 0.5)
    }
    throw Failure(message: "The SF Desk server didn't answer at \(url.absoluteString).\n\n\(tail(logFile))")
  }

  func stop() {
    lock.lock()
    let p = process, pipe = stdin
    process = nil
    stdin = nil
    lock.unlock()
    guard let p else { return }
    p.terminationHandler = nil
    if p.isRunning {
      p.terminate()
      for _ in 0..<30 where p.isRunning { Thread.sleep(forTimeInterval: 0.1) }
      if p.isRunning { kill(p.processIdentifier, SIGKILL) }
    }
    try? pipe?.fileHandleForWriting.close()
  }
}

// MARK: - The window

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
  var window: NSWindow!
  var web: WKWebView!
  var server: Server!
  var baseURL = URL(string: "http://localhost:3000")!
  var downloads: [ObjectIdentifier: URL] = [:]

  func applicationWillFinishLaunching(_ note: Notification) {
    // One SF Desk at a time: bring the running one forward instead.
    if let other = NSRunningApplication.runningApplications(withBundleIdentifier: Bundle.main.bundleIdentifier ?? "")
      .first(where: { $0 != NSRunningApplication.current }) {
      other.activate(options: [])
      exit(0)
    }
  }

  func applicationDidFinishLaunching(_ note: Notification) {
    buildMenu()
    web = WKWebView(frame: .zero, configuration: WKWebViewConfiguration())
    web.navigationDelegate = self
    web.uiDelegate = self
    web.allowsBackForwardNavigationGestures = true
    if #available(macOS 13.3, *) { web.isInspectable = true }

    window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1360, height: 900),
                      styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
    window.title = "SF Desk"
    window.contentView = web
    window.delegate = self
    window.minSize = NSSize(width: 480, height: 400)
    window.center()
    window.setFrameAutosaveName("SF Desk")
    window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)

    // The delegate lives as long as the app, so these hold it strongly.
    server = Server(ui: UI(
      status: { text in Task { @MainActor in self.showStatus(text) } },
      ready: { url in Task { @MainActor in self.baseURL = url; self.web.load(URLRequest(url: url)) } },
      fail: { text in Task { @MainActor in self.showError(text) } },
      ask: { title, text, ok in
        let answer = Box(false), done = DispatchSemaphore(value: 0)
        Task { @MainActor in answer.value = self.ask(title, text, ok: ok); done.signal() }
        done.wait()
        return answer.value
      }))
    startServer()
  }

  func startServer() {
    showStatus("Starting SF Desk...")
    let server = server!
    Thread.detachNewThread { server.start() }
  }

  @objc func restartServer(_ sender: Any?) {
    showStatus("Restarting SF Desk...")
    let server = server!
    Thread.detachNewThread { server.stop(); server.start() }
  }

  func applicationWillTerminate(_ note: Notification) {
    server?.quitting = true
    server?.stop()
  }

  // Closing the window keeps SF Desk running, for the Outlook add-in.
  func windowShouldClose(_ sender: NSWindow) -> Bool {
    sender.orderOut(nil)
    return false
  }

  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
    showWindow(nil)
    return true
  }

  @objc func showWindow(_ sender: Any?) {
    window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
  }

  // MARK: Status pages and questions

  func page(_ body: String) -> String {
    """
    <!doctype html><meta charset="utf-8"><style>
    :root { color-scheme: light dark; }
    body { font: 14px -apple-system, system-ui; margin: 0; height: 100vh; display: grid; place-items: center; }
    main { max-width: 640px; padding: 24px; text-align: center; }
    h1 { font-size: 22px; font-weight: 600; margin: 0 0 12px; }
    pre { text-align: left; white-space: pre-wrap; font: 12px ui-monospace, Menlo; background: rgba(127,127,127,.12);
          padding: 12px; border-radius: 8px; max-height: 50vh; overflow: auto; }
    .spin { width: 28px; height: 28px; margin: 0 auto 16px; border: 3px solid rgba(127,127,127,.25);
            border-top-color: #0176d3; border-radius: 50%; animation: s .9s linear infinite; }
    @keyframes s { to { transform: rotate(360deg); } }
    </style><main>\(body)</main>
    """
  }

  func showStatus(_ text: String) {
    web.loadHTMLString(page("<div class=spin></div><h1>SF Desk</h1><p>\(html(text))</p>"), baseURL: nil)
  }

  func showError(_ text: String) {
    let parts = text.components(separatedBy: "\n\n")
    let detail = parts.dropFirst().joined(separator: "\n\n").trimmingCharacters(in: .whitespacesAndNewlines)
    web.loadHTMLString(page("<h1>SF Desk couldn't start</h1><p>\(html(parts[0]))</p>" +
      (detail.isEmpty ? "" : "<pre>\(html(detail))</pre>") +
      "<p>Help &gt; Show Server Log has the details.</p>"), baseURL: nil)
  }

  func ask(_ title: String, _ text: String, ok: String) -> Bool {
    let a = NSAlert()
    a.messageText = title
    a.informativeText = text
    a.addButton(withTitle: ok)
    a.addButton(withTitle: "Not Now")
    NSApp.activate(ignoringOtherApps: true)
    return a.runModal() == .alertFirstButtonReturn
  }

  // MARK: Web view

  func isLocal(_ url: URL?) -> Bool {
    guard let url else { return false }
    return ["about", "blob", "data"].contains(url.scheme ?? "") || ["localhost", "127.0.0.1"].contains(url.host ?? "")
  }

  func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
               decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    if action.shouldPerformDownload { return decisionHandler(.download) }
    // Links out of SF Desk (Salesforce records, Teams...) open in the browser; redirects such as an OAuth
    // sign-in stay here.
    if action.navigationType == .linkActivated, let url = action.request.url, !isLocal(url) {
      NSWorkspace.shared.open(url)
      return decisionHandler(.cancel)
    }
    decisionHandler(.allow)
  }

  func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse,
               decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
    decisionHandler(response.canShowMIMEType ? .allow : .download)
  }

  // target=_blank and window.open: SF Desk pages load here, anything else opens in the browser.
  func webView(_ webView: WKWebView, createWebViewWith config: WKWebViewConfiguration,
               for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
    if let url = action.request.url {
      if isLocal(url) && url.scheme != "about" { webView.load(action.request) } else { NSWorkspace.shared.open(url) }
    }
    return nil
  }

  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { webView.reload() }

  func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
               initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
    let a = NSAlert()
    a.messageText = message
    a.addButton(withTitle: "OK")
    a.beginSheetModal(for: window) { _ in completionHandler() }
  }

  func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
               initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
    let a = NSAlert()
    a.messageText = message
    a.addButton(withTitle: "OK")
    a.addButton(withTitle: "Cancel")
    a.beginSheetModal(for: window) { completionHandler($0 == .alertFirstButtonReturn) }
  }

  func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?,
               initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
    let a = NSAlert()
    a.messageText = prompt
    let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 300, height: 24))
    field.stringValue = defaultText ?? ""
    a.accessoryView = field
    a.addButton(withTitle: "OK")
    a.addButton(withTitle: "Cancel")
    a.beginSheetModal(for: window) { completionHandler($0 == .alertFirstButtonReturn ? field.stringValue : nil) }
  }

  func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
               initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
    let panel = NSOpenPanel()
    panel.allowsMultipleSelection = parameters.allowsMultipleSelection
    panel.canChooseDirectories = parameters.allowsDirectories
    panel.beginSheetModal(for: window) { completionHandler($0 == .OK ? panel.urls : nil) }
  }

  // Downloads (the Excel exports, the Outlook manifest) go to ~/Downloads and are shown in Finder.
  func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
    download.delegate = self
  }

  func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
    download.delegate = self
  }

  func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String,
                completionHandler: @escaping (URL?) -> Void) {
    let dir = fm.urls(for: .downloadsDirectory, in: .userDomainMask).first ?? home
    let name = suggestedFilename.isEmpty ? "download" : suggestedFilename
    let base = (name as NSString).deletingPathExtension, ext = (name as NSString).pathExtension
    var url = dir.appendingPathComponent(name)
    var n = 2
    while fm.fileExists(atPath: url.path) {
      url = dir.appendingPathComponent(ext.isEmpty ? "\(base) \(n)" : "\(base) \(n).\(ext)")
      n += 1
    }
    downloads[ObjectIdentifier(download)] = url
    completionHandler(url)
  }

  func downloadDidFinish(_ download: WKDownload) {
    if let url = downloads.removeValue(forKey: ObjectIdentifier(download)) {
      NSWorkspace.shared.activateFileViewerSelecting([url])
    }
  }

  func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
    downloads.removeValue(forKey: ObjectIdentifier(download))
    NSAlert(error: error).beginSheetModal(for: window, completionHandler: nil)
  }

  // MARK: Menu commands

  @objc func reload(_ sender: Any?) {
    if web.url?.scheme == "http" { web.reload() } else { web.load(URLRequest(url: baseURL)) }
  }
  @objc func goBack(_ sender: Any?) { web.goBack() }
  @objc func goForward(_ sender: Any?) { web.goForward() }
  @objc func openInBrowser(_ sender: Any?) {
    NSWorkspace.shared.open(web.url.flatMap { isLocal($0) && $0.scheme == "http" ? $0 : nil } ?? baseURL)
  }
  @objc func zoomIn(_ sender: Any?) { web.pageZoom = min(web.pageZoom + 0.1, 3) }
  @objc func zoomOut(_ sender: Any?) { web.pageZoom = max(web.pageZoom - 0.1, 0.5) }
  @objc func actualSize(_ sender: Any?) { web.pageZoom = 1 }
  @objc func showLog(_ sender: Any?) { NSWorkspace.shared.activateFileViewerSelecting([logFile]) }
  @objc func showData(_ sender: Any?) { NSWorkspace.shared.open(supportDir) }
  @objc func editSettings(_ sender: Any?) {
    NSWorkspace.shared.open([envFile], withApplicationAt: URL(fileURLWithPath: "/System/Applications/TextEdit.app"),
                            configuration: NSWorkspace.OpenConfiguration())
  }

  // The Outlook add-in's HTTPS certificate (OUTLOOK.md step 1), made in the support folder and trusted.
  @objc func setUpOutlook(_ sender: Any?) {
    let certs = supportDir.appendingPathComponent("certs")
    let a = NSAlert()
    a.messageText = "Set up the Outlook add-in"
    a.informativeText = fm.fileExists(atPath: certs.appendingPathComponent("localhost.pem").path)
      ? "SF Desk already has its HTTPS certificate. Trust it again in your login keychain? macOS asks for your password."
      : "SF Desk will make an HTTPS certificate for https://localhost and trust it in your login keychain (macOS asks for your password), then restart."
    a.addButton(withTitle: "Continue")
    a.addButton(withTitle: "Cancel")
    guard a.runModal() == .alertFirstButtonReturn else { return }
    let env = ProcessInfo.processInfo.environment.merging(["SF_DESK_CERTS": certs.path, "PATH": server.path]) { $1 }
    Thread.detachNewThread {
      let r = run("/bin/sh", [appDir.appendingPathComponent("scripts/outlook-cert.sh").path, "--trust"], env: env, timeout: 300)
      Task { @MainActor in self.outlookDone(r.status == 0, r.output) }
    }
  }

  func outlookDone(_ ok: Bool, _ output: String) {
    let a = NSAlert()
    guard ok else {
      a.messageText = "Couldn't set up the certificate"
      a.informativeText = output
      a.runModal()
      return
    }
    restartServer(nil)
    let port = readEnv()["HTTPS_PORT"].flatMap { $0.isEmpty ? nil : $0 } ?? "3443"
    a.messageText = "Certificate ready"
    a.informativeText = "SF Desk now also listens on https://localhost:\(port). Next, add the add-in to Outlook: " +
      "download its manifest, then follow step 2 of OUTLOOK.md (Help > Outlook Add-in Instructions)."
    a.addButton(withTitle: "Download Manifest")
    a.addButton(withTitle: "Close")
    if a.runModal() == .alertFirstButtonReturn {
      NSWorkspace.shared.open(URL(string: "https://localhost:\(port)/outlook/manifest.xml")!)
    }
  }

  @objc func outlookHelp(_ sender: Any?) {
    NSWorkspace.shared.open(URL(string: "https://github.com/kclassen-kccs/sf-desk/blob/main/OUTLOOK.md")!)
  }

  func buildMenu() {
    let main = NSMenu()
    func add(_ title: String, _ items: [NSMenuItem]) -> NSMenu {
      let menu = NSMenu(title: title)
      items.forEach(menu.addItem)
      let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
      item.submenu = menu
      main.addItem(item)
      return menu
    }
    // Items for our own commands target this delegate; standard ones go up the responder chain.
    func item(_ title: String, _ action: Selector?, _ key: String = "", _ mods: NSEvent.ModifierFlags = .command) -> NSMenuItem {
      let i = NSMenuItem(title: title, action: action, keyEquivalent: key)
      i.keyEquivalentModifierMask = mods
      if let action, responds(to: action) { i.target = self }
      return i
    }

    _ = add("SF Desk", [
      item("About SF Desk", #selector(NSApplication.orderFrontStandardAboutPanel(_:))),
      .separator(),
      item("Set Up Outlook Add-in...", #selector(setUpOutlook(_:))),
      item("Edit Settings...", #selector(editSettings(_:))),
      .separator(),
      item("Hide SF Desk", #selector(NSApplication.hide(_:)), "h"),
      item("Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]),
      item("Show All", #selector(NSApplication.unhideAllApplications(_:))),
      .separator(),
      item("Quit SF Desk", #selector(NSApplication.terminate(_:)), "q"),
    ])
    _ = add("File", [
      item("Restart Server", #selector(restartServer(_:)), "r", [.command, .option]),
      item("Open in Browser", #selector(openInBrowser(_:)), "o", [.command, .shift]),
      .separator(),
      item("Close Window", #selector(NSWindow.performClose(_:)), "w"),
    ])
    let find = item("Find...", #selector(NSResponder.performTextFinderAction(_:)), "f")
    find.tag = NSTextFinder.Action.showFindInterface.rawValue
    _ = add("Edit", [
      item("Undo", Selector(("undo:")), "z"),
      item("Redo", Selector(("redo:")), "z", [.command, .shift]),
      .separator(),
      item("Cut", #selector(NSText.cut(_:)), "x"),
      item("Copy", #selector(NSText.copy(_:)), "c"),
      item("Paste", #selector(NSText.paste(_:)), "v"),
      item("Select All", #selector(NSText.selectAll(_:)), "a"),
      .separator(),
      find,
    ])
    _ = add("View", [
      item("Reload", #selector(reload(_:)), "r"),
      item("Back", #selector(goBack(_:)), "["),
      item("Forward", #selector(goForward(_:)), "]"),
      .separator(),
      item("Actual Size", #selector(actualSize(_:)), "0"),
      item("Zoom In", #selector(zoomIn(_:)), "+"),
      item("Zoom Out", #selector(zoomOut(_:)), "-"),
      .separator(),
      item("Enter Full Screen", #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control]),
    ])
    let windowMenu = add("Window", [
      item("Minimize", #selector(NSWindow.performMiniaturize(_:)), "m"),
      item("Zoom", #selector(NSWindow.performZoom(_:))),
      .separator(),
      item("SF Desk", #selector(showWindow(_:)), "1"),
    ])
    _ = add("Help", [
      item("Outlook Add-in Instructions", #selector(outlookHelp(_:))),
      item("Show Server Log", #selector(showLog(_:))),
      item("Show Data Folder", #selector(showData(_:))),
    ])
    NSApp.mainMenu = main
    NSApp.windowsMenu = windowMenu
  }
}

@main
enum SFDeskApp {
  @MainActor static func main() {
    let app = NSApplication.shared
    let delegate = AppDelegate()
    app.delegate = delegate
    app.setActivationPolicy(.regular)
    withExtendedLifetime(delegate) { app.run() }
  }
}
