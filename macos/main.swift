import Cocoa
import CommonCrypto
import Network
import WebKit

final class CekiSchemeHandler: NSObject, WKURLSchemeHandler {
    private let webRoot: URL

    init(webRoot: URL) {
        self.webRoot = webRoot
        super.init()
    }

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard let url = urlSchemeTask.request.url else {
            urlSchemeTask.didFailWithError(NSError(domain: "CekiScheme", code: 400))
            return
        }

        var path = url.path
        if path.isEmpty || path == "/" {
            path = "/index.html"
        }
        let relativePath = path.hasPrefix("/") ? String(path.dropFirst()) : path
        let fileURL = webRoot.appendingPathComponent(relativePath).standardizedFileURL

        guard fileURL.path.hasPrefix(webRoot.standardizedFileURL.path),
              let data = try? Data(contentsOf: fileURL) else {
            urlSchemeTask.didFailWithError(NSError(domain: "CekiScheme", code: 404))
            return
        }

        let mimeType = Self.mimeType(for: fileURL.pathExtension.lowercased())
        let response = URLResponse(
            url: url,
            mimeType: mimeType,
            expectedContentLength: data.count,
            textEncodingName: mimeType.hasPrefix("text/") || mimeType == "application/javascript" ? "utf-8" : nil
        )
        urlSchemeTask.didReceive(response)
        urlSchemeTask.didReceive(data)
        urlSchemeTask.didFinish()
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {}

    static func mimeType(for ext: String) -> String {
        switch ext {
        case "html": return "text/html"
        case "js", "mjs": return "application/javascript"
        case "css": return "text/css"
        case "jpg", "jpeg": return "image/jpeg"
        case "png": return "image/png"
        case "svg": return "image/svg+xml"
        case "json": return "application/json"
        default: return "application/octet-stream"
        }
    }
}

final class LanRelayServer {
    private let webRoot: URL
    private let queue = DispatchQueue(label: "ceki.lan.relay")
    private var listener: NWListener?
    private var hostConn: RelayClient?
    private var guests: [String: RelayClient] = [:]
    private(set) var port: UInt16 = 4173

    final class RelayClient {
        let id: String
        let conn: NWConnection
        var isHost = false
        var isWebSocket = false
        var buffer = Data()

        init(id: String, conn: NWConnection) {
            self.id = id
            self.conn = conn
        }
    }

    init(webRoot: URL) {
        self.webRoot = webRoot
    }

    func start(preferredPort: UInt16 = 4173, completion: @escaping (Result<(UInt16, [String]), Error>) -> Void) {
        stop()
        do {
            let params = NWParameters.tcp
            params.allowLocalEndpointReuse = true
            let nwPort = NWEndpoint.Port(rawValue: preferredPort) ?? .any
            let l = try NWListener(using: params, on: nwPort)
            self.listener = l

            l.stateUpdateHandler = { [weak self] state in
                guard let self = self else { return }
                switch state {
                case .ready:
                    let actualPort = l.port?.rawValue ?? preferredPort
                    self.port = actualPort
                    let urls = Self.localWifiURLs(port: actualPort)
                    DispatchQueue.main.async { completion(.success((actualPort, urls))) }
                case .failed(let err):
                    DispatchQueue.main.async { completion(.failure(err)) }
                default:
                    break
                }
            }

            l.newConnectionHandler = { [weak self] conn in
                self?.accept(conn: conn)
            }

            l.start(queue: queue)
        } catch {
            completion(.failure(error))
        }
    }

    func stop() {
        listener?.cancel()
        listener = nil
        hostConn?.conn.cancel()
        hostConn = nil
        for (_, g) in guests { g.conn.cancel() }
        guests.removeAll()
    }

    private func accept(conn: NWConnection) {
        let client = RelayClient(id: UUID().uuidString, conn: conn)
        conn.stateUpdateHandler = { [weak self] st in
            if case .cancelled = st { self?.remove(client: client) }
            if case .failed = st { self?.remove(client: client) }
        }
        conn.start(queue: queue)
        receiveNext(client: client)
    }

    private func remove(client: RelayClient) {
        if client.isHost {
            if hostConn?.id == client.id { hostConn = nil }
        } else if guests.removeValue(forKey: client.id) != nil {
            if let host = hostConn {
                sendJSON(to: host, obj: ["type": "guest_left", "clientId": client.id])
            }
        }
    }

    private func receiveNext(client: RelayClient) {
        client.conn.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, isComplete, error in
            guard let self = self else { return }
            if let data = data, !data.isEmpty {
                client.buffer.append(data)
                if client.isWebSocket {
                    self.parseWSFrames(client: client)
                } else {
                    self.parseHTTP(client: client)
                }
            }
            if isComplete || error != nil {
                client.conn.cancel()
                self.remove(client: client)
                return
            }
            self.receiveNext(client: client)
        }
    }

    private func parseHTTP(client: RelayClient) {
        guard let range = client.buffer.range(of: Data("\r\n\r\n".utf8)) else { return }
        let headerData = client.buffer.subdata(in: 0..<range.upperBound)
        client.buffer.removeSubrange(0..<range.upperBound)
        let headerStr = String(data: headerData, encoding: .utf8) ?? ""
        let lines = headerStr.components(separatedBy: "\r\n")
        guard let firstLine = lines.first else { client.conn.cancel(); return }
        let parts = firstLine.split(separator: " ")
        guard parts.count >= 2 else { client.conn.cancel(); return }
        let rawTarget = String(parts[1])
        let pathOnly = rawTarget.split(separator: "?").first.map(String.init) ?? "/"

        var headers: [String: String] = [:]
        for line in lines.dropFirst() {
            if let idx = line.firstIndex(of: ":") {
                let k = line[..<idx].trimmingCharacters(in: .whitespaces).lowercased()
                let v = line[line.index(after: idx)...].trimmingCharacters(in: .whitespaces)
                headers[k] = v
            }
        }

        if pathOnly == "/ws", let wsKey = headers["sec-websocket-key"] {
            let acceptKey = Self.wsAcceptKey(wsKey)
            let resp = [
                "HTTP/1.1 101 Switching Protocols",
                "Upgrade: websocket",
                "Connection: Upgrade",
                "Sec-WebSocket-Accept: \(acceptKey)",
                "\r\n"
            ].joined(separator: "\r\n")
            client.isWebSocket = true
            client.isHost = rawTarget.contains("role=host")
            if client.isHost {
                hostConn = client
            } else {
                guests[client.id] = client
                if let host = hostConn {
                    sendJSON(to: host, obj: ["type": "guest_joined", "clientId": client.id])
                }
            }
            client.conn.send(content: Data(resp.utf8), completion: .contentProcessed({ _ in }))
            if !client.buffer.isEmpty { parseWSFrames(client: client) }
            return
        }

        if pathOnly == "/api/lan-info" {
            let urls = Self.localWifiURLs(port: port)
            let body = (try? JSONSerialization.data(withJSONObject: ["urls": urls, "port": port])) ?? Data("{}".utf8)
            sendHTTP(conn: client.conn, status: "200 OK", mime: "application/json; charset=utf-8", body: body)
            return
        }

        let rel = pathOnly == "/" ? "index.html" : (pathOnly.hasPrefix("/") ? String(pathOnly.dropFirst()) : pathOnly)
        let fileURL = webRoot.appendingPathComponent(rel).standardizedFileURL
        guard fileURL.path.hasPrefix(webRoot.standardizedFileURL.path),
              let data = try? Data(contentsOf: fileURL) else {
            sendHTTP(conn: client.conn, status: "404 Not Found", mime: "text/plain", body: Data("Not Found".utf8))
            return
        }
        let mime = CekiSchemeHandler.mimeType(for: fileURL.pathExtension.lowercased())
        sendHTTP(conn: client.conn, status: "200 OK", mime: mime, body: data)
    }

    private func sendHTTP(conn: NWConnection, status: String, mime: String, body: Data) {
        let head = "HTTP/1.1 \(status)\r\nContent-Type: \(mime)\r\nContent-Length: \(body.count)\r\nConnection: close\r\n\r\n"
        var packet = Data(head.utf8)
        packet.append(body)
        conn.send(content: packet, completion: .contentProcessed({ _ in conn.cancel() }))
    }

    private func parseWSFrames(client: RelayClient) {
        while client.buffer.count >= 2 {
            let b0 = client.buffer[0]
            let b1 = client.buffer[1]
            let opcode = b0 & 0x0F
            let masked = (b1 & 0x80) != 0
            var len = Int(b1 & 0x7F)
            var offset = 2
            if len == 126 {
                guard client.buffer.count >= 4 else { return }
                len = Int(client.buffer[2]) << 8 | Int(client.buffer[3])
                offset = 4
            } else if len == 127 {
                guard client.buffer.count >= 10 else { return }
                var v: UInt64 = 0
                for i in 0..<8 { v = (v << 8) | UInt64(client.buffer[2 + i]) }
                len = Int(v)
                offset = 10
            }
            let maskLen = masked ? 4 : 0
            guard client.buffer.count >= offset + maskLen + len else { return }
            let mask = masked ? Array(client.buffer[offset..<(offset + 4)]) : []
            var payload = Array(client.buffer[(offset + maskLen)..<(offset + maskLen + len)])
            client.buffer.removeSubrange(0..<(offset + maskLen + len))

            if masked {
                for i in 0..<payload.count { payload[i] ^= mask[i % 4] }
            }

            if opcode == 0x8 {
                client.conn.cancel()
                remove(client: client)
                return
            }
            if opcode == 0x9 {
                var pong = Data([0x8A, UInt8(payload.count)])
                pong.append(contentsOf: payload)
                client.conn.send(content: pong, completion: .contentProcessed({ _ in }))
                continue
            }
            if opcode == 0x1, let text = String(bytes: payload, encoding: .utf8) {
                handleWSMessage(client: client, text: text)
            }
        }
    }

    private func handleWSMessage(client: RelayClient, text: String) {
        guard let data = text.data(using: .utf8),
              let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return }

        if client.isHost {
            if let type = obj["type"] as? String, type == "relay_to",
               let targetId = obj["targetClientId"] as? String,
               let payload = obj["payload"],
               let guest = guests[targetId] {
                sendJSON(to: guest, obj: payload)
            }
        } else if let host = hostConn {
            sendJSON(to: host, obj: ["type": "from_guest", "clientId": client.id, "payload": obj])
        }
    }

    private func sendJSON(to client: RelayClient, obj: Any) {
        guard let data = try? JSONSerialization.data(withJSONObject: obj) else { return }
        var frame = Data([0x81])
        let len = data.count
        if len < 126 {
            frame.append(UInt8(len))
        } else if len < 65536 {
            frame.append(126)
            frame.append(UInt8((len >> 8) & 0xFF))
            frame.append(UInt8(len & 0xFF))
        } else {
            frame.append(127)
            let v = UInt64(len)
            for shift in stride(from: 56, through: 0, by: -8) {
                frame.append(UInt8((v >> shift) & 0xFF))
            }
        }
        frame.append(data)
        client.conn.send(content: frame, completion: .contentProcessed({ _ in }))
    }

    private static func wsAcceptKey(_ key: String) -> String {
        let combined = (key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").data(using: .utf8)!
        var digest = [UInt8](repeating: 0, count: Int(CC_SHA1_DIGEST_LENGTH))
        combined.withUnsafeBytes { _ = CC_SHA1($0.baseAddress, CC_LONG(combined.count), &digest) }
        return Data(digest).base64EncodedString()
    }

    private static func localWifiURLs(port: UInt16) -> [String] {
        var urls: [String] = []
        var ifaddr: UnsafeMutablePointer<ifaddrs>?
        if getifaddrs(&ifaddr) == 0 {
            var ptr = ifaddr
            while let cur = ptr {
                let flags = Int32(cur.pointee.ifa_flags)
                let addr = cur.pointee.ifa_addr.pointee
                if (flags & IFF_UP) != 0 && (flags & IFF_LOOPBACK) == 0 && addr.sa_family == UInt8(AF_INET) {
                    var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
                    if getnameinfo(cur.pointee.ifa_addr, socklen_t(addr.sa_len), &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST) == 0 {
                        let ip = String(cString: host)
                        urls.append("http://\(ip):\(port)/")
                    }
                }
                ptr = cur.pointee.ifa_next
            }
            freeifaddrs(ifaddr)
        }
        return urls.isEmpty ? ["http://127.0.0.1:\(port)/"] : urls
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKScriptMessageHandler {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var relay: LanRelayServer?

    func applicationDidFinishLaunching(_ notification: Notification) {
        setupMenu()

        guard let webRoot = Bundle.main.resourceURL?.appendingPathComponent("web") else {
            fatalError("Missing bundled web resources")
        }

        relay = LanRelayServer(webRoot: webRoot)

        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(CekiSchemeHandler(webRoot: webRoot), forURLScheme: "ceki")
        config.userContentController.add(self, name: "cekiHost")

        webView = WKWebView(frame: .zero, configuration: config)
        webView.autoresizingMask = [.width, .height]

        let rect = NSRect(x: 0, y: 0, width: 1280, height: 800)
        window = NSWindow(
            contentRect: rect,
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Ceki Bali"
        window.minSize = NSSize(width: 980, height: 640)
        window.center()
        window.contentView = webView
        window.makeKeyAndOrderFront(nil)

        if let startURL = URL(string: "ceki://app/index.html") {
            webView.load(URLRequest(url: startURL))
        }

        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    func applicationWillTerminate(_ notification: Notification) {
        relay?.stop()
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let dict = message.body as? [String: Any],
              let action = dict["action"] as? String else { return }

        if action == "start_host" {
            relay?.start(preferredPort: 4173) { [weak self] result in
                switch result {
                case .success(let (port, urls)):
                    let payload: [String: Any] = ["ok": true, "port": port, "urls": urls]
                    if let data = try? JSONSerialization.data(withJSONObject: payload),
                       let json = String(data: data, encoding: .utf8) {
                        self?.webView.evaluateJavaScript("window.dispatchEvent(new CustomEvent('ceki-host-ready', { detail: \(json) }))", completionHandler: nil)
                    }
                case .failure(let err):
                    let payload: [String: Any] = ["ok": false, "error": err.localizedDescription]
                    if let data = try? JSONSerialization.data(withJSONObject: payload),
                       let json = String(data: data, encoding: .utf8) {
                        self?.webView.evaluateJavaScript("window.dispatchEvent(new CustomEvent('ceki-host-ready', { detail: \(json) }))", completionHandler: nil)
                    }
                }
            }
        } else if action == "stop_host" {
            relay?.stop()
        }
    }

    private func setupMenu() {
        let mainMenu = NSMenu()

        let appMenuItem = NSMenuItem()
        mainMenu.addItem(appMenuItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About Ceki Bali", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit Ceki Bali", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appMenuItem.submenu = appMenu

        let windowMenuItem = NSMenuItem()
        mainMenu.addItem(windowMenuItem)
        let windowMenu = NSMenu(title: "Window")
        windowMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        windowMenuItem.submenu = windowMenu

        NSApp.mainMenu = mainMenu
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let delegate = AppDelegate()
app.delegate = delegate
app.run()
