$ErrorActionPreference = 'Stop'

$WebRoot = Join-Path $PSScriptRoot 'web'
if (-not (Test-Path (Join-Path $WebRoot 'index.html'))) {
    [System.Windows.MessageBox]::Show("File game offline tidak ditemukan di $WebRoot", "Ceki Bali") | Out-Null
    exit 1
}

Add-Type -TypeDefinition @"
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

public class CekiLanServer {
    private readonly string _webRoot;
    private readonly int _port;
    private readonly bool _enableRelayControl;
    private TcpListener _listener;
    private volatile bool _running;
    private readonly ConcurrentDictionary<string, WsClient> _guests = new ConcurrentDictionary<string, WsClient>();
    private WsClient _hostClient = null;
    private readonly object _hostLock = new object();

    public static CekiLanServer ActiveLanRelay = null;

    private class WsClient {
        public string Id;
        public TcpClient Tcp;
        public NetworkStream Stream;
        public bool IsHost;
        public readonly object WriteLock = new object();
    }

    public CekiLanServer(string webRoot, int port, bool enableRelayControl) {
        _webRoot = Path.GetFullPath(webRoot);
        _port = port;
        _enableRelayControl = enableRelayControl;
    }

    public int Port { get { return _port; } }

    public void Start() {
        _listener = new TcpListener(IPAddress.Any, _port);
        _listener.Start();
        _running = true;
        Task.Run(async () => {
            while (_running) {
                try {
                    var tcp = await _listener.AcceptTcpClientAsync();
                    var _ = Task.Run(() => HandleClient(tcp));
                } catch {
                    if (!_running) break;
                }
            }
        });
    }

    public void Stop() {
        _running = false;
        try { _listener.Stop(); } catch {}
        lock (_hostLock) {
            if (_hostClient != null) {
                try { _hostClient.Tcp.Close(); } catch {}
                _hostClient = null;
            }
        }
        foreach (var kv in _guests) {
            try { kv.Value.Tcp.Close(); } catch {}
        }
        _guests.Clear();
    }

    public static List<string> GetLocalWifiUrls(int port) {
        var urls = new List<string>();
        try {
            foreach (var ni in NetworkInterface.GetAllNetworkInterfaces()) {
                if (ni.OperationalStatus != OperationalStatus.Up) continue;
                if (ni.NetworkInterfaceType == NetworkInterfaceType.Loopback) continue;
                foreach (var ua in ni.GetIPProperties().UnicastAddresses) {
                    if (ua.Address.AddressFamily == AddressFamily.InterNetwork && !IPAddress.IsLoopback(ua.Address)) {
                        urls.Add("http://" + ua.Address.ToString() + ":" + port + "/");
                    }
                }
            }
        } catch {}
        if (urls.Count == 0) urls.Add("http://127.0.0.1:" + port + "/");
        return urls;
    }

    private static string JsonString(string s) {
        return "\"" + s.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";
    }

    private async Task HandleClient(TcpClient tcp) {
        var stream = tcp.GetStream();
        try {
            var headerBuf = new List<byte>();
            var b = new byte[1];
            int match = 0;
            while (headerBuf.Count < 16384) {
                int n = await stream.ReadAsync(b, 0, 1);
                if (n <= 0) { tcp.Close(); return; }
                headerBuf.Add(b[0]);
                if ((match == 0 || match == 2) && b[0] == 13) match++;
                else if ((match == 1 || match == 3) && b[0] == 10) match++;
                else match = (b[0] == 13) ? 1 : 0;
                if (match == 4) break;
            }

            var headerText = Encoding.UTF8.GetString(headerBuf.ToArray());
            var lines = headerText.Split(new[] { "\r\n" }, StringSplitOptions.None);
            if (lines.Length == 0) { tcp.Close(); return; }
            var firstParts = lines[0].Split(' ');
            if (firstParts.Length < 2) { tcp.Close(); return; }
            var method = firstParts[0].ToUpperInvariant();
            var rawTarget = firstParts[1];
            var qIdx = rawTarget.IndexOf('?');
            var pathOnly = qIdx >= 0 ? rawTarget.Substring(0, qIdx) : rawTarget;

            var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            for (int i = 1; i < lines.Length; i++) {
                var idx = lines[i].IndexOf(':');
                if (idx > 0) {
                    headers[lines[i].Substring(0, idx).Trim()] = lines[i].Substring(idx + 1).Trim();
                }
            }

            if (pathOnly == "/ws" && headers.ContainsKey("Sec-WebSocket-Key")) {
                await HandleWebSocket(tcp, stream, rawTarget, headers["Sec-WebSocket-Key"]);
                return;
            }

            if (_enableRelayControl && pathOnly == "/api/host-start") {
                try {
                    if (ActiveLanRelay == null) {
                        var relay = new CekiLanServer(_webRoot, 4173, false);
                        relay.Start();
                        ActiveLanRelay = relay;
                    }
                    var urls = GetLocalWifiUrls(4173);
                    var jsonUrls = "[" + string.Join(",", urls.ConvertAll(JsonString)) + "]";
                    SendHttp(stream, "200 OK", "application/json; charset=utf-8",
                        Encoding.UTF8.GetBytes("{\"ok\":true,\"port\":4173,\"urls\":" + jsonUrls + "}"));
                } catch (Exception ex) {
                    SendHttp(stream, "200 OK", "application/json; charset=utf-8",
                        Encoding.UTF8.GetBytes("{\"ok\":false,\"error\":" + JsonString(ex.Message) + "}"));
                }
                tcp.Close();
                return;
            }

            if (_enableRelayControl && pathOnly == "/api/host-stop") {
                if (ActiveLanRelay != null) {
                    ActiveLanRelay.Stop();
                    ActiveLanRelay = null;
                }
                SendHttp(stream, "200 OK", "application/json; charset=utf-8", Encoding.UTF8.GetBytes("{\"ok\":true}"));
                tcp.Close();
                return;
            }

            if (pathOnly == "/api/lan-info") {
                var urls = GetLocalWifiUrls(_port);
                var jsonUrls = "[" + string.Join(",", urls.ConvertAll(JsonString)) + "]";
                SendHttp(stream, "200 OK", "application/json; charset=utf-8",
                    Encoding.UTF8.GetBytes("{\"urls\":" + jsonUrls + ",\"port\":" + _port + "}"));
                tcp.Close();
                return;
            }

            if (method != "GET" && method != "HEAD") {
                SendHttp(stream, "405 Method Not Allowed", "text/plain", Encoding.UTF8.GetBytes("Method Not Allowed"));
                tcp.Close();
                return;
            }

            var rel = pathOnly == "/" ? "index.html" : pathOnly.TrimStart('/');
            rel = rel.Replace("..", "").Replace('/', Path.DirectorySeparatorChar);
            var fullPath = Path.GetFullPath(Path.Combine(_webRoot, rel));
            if (!fullPath.StartsWith(_webRoot) || !File.Exists(fullPath)) {
                SendHttp(stream, "404 Not Found", "text/plain", Encoding.UTF8.GetBytes("Not Found"));
                tcp.Close();
                return;
            }

            var bytes = File.ReadAllBytes(fullPath);
            SendHttp(stream, "200 OK", GetMimeType(Path.GetExtension(fullPath).ToLowerInvariant()), bytes);
            tcp.Close();
        } catch {
            try { tcp.Close(); } catch {}
        }
    }

    private async Task HandleWebSocket(TcpClient tcp, NetworkStream stream, string rawTarget, string wsKey) {
        string accept;
        using (var sha1 = SHA1.Create()) {
            var hash = sha1.ComputeHash(Encoding.UTF8.GetBytes(wsKey + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"));
            accept = Convert.ToBase64String(hash);
        }
        var resp = "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n";
        var respBytes = Encoding.UTF8.GetBytes(resp);
        await stream.WriteAsync(respBytes, 0, respBytes.Length);

        var client = new WsClient {
            Id = Guid.NewGuid().ToString("N"),
            Tcp = tcp,
            Stream = stream,
            IsHost = rawTarget.Contains("role=host")
        };

        if (client.IsHost) {
            lock (_hostLock) { _hostClient = client; }
        } else {
            _guests[client.Id] = client;
            WsClient h;
            lock (_hostLock) { h = _hostClient; }
            if (h != null) SendWsText(h, "{\"type\":\"guest_joined\",\"clientId\":" + JsonString(client.Id) + "}");
        }

        try {
            while (_running && tcp.Connected) {
                var frame = await ReadWsFrame(stream);
                if (frame == null) break;
                if (frame.Item1 == 0x8) break;
                if (frame.Item1 == 0x9) { SendWsControl(client, 0x8A, frame.Item2); continue; }
                if (frame.Item1 == 0x1) {
                    var text = Encoding.UTF8.GetString(frame.Item2);
                    if (client.IsHost) {
                        var targetMarker = "\"targetClientId\":\"";
                        var pMarker = "\"payload\":";
                        var tIdx = text.IndexOf(targetMarker);
                        var pIdx = text.IndexOf(pMarker);
                        if (tIdx >= 0 && pIdx >= 0) {
                            var tStart = tIdx + targetMarker.Length;
                            var tEnd = text.IndexOf('"', tStart);
                            var targetId = text.Substring(tStart, tEnd - tStart);
                            var payloadJson = text.Substring(pIdx + pMarker.Length);
                            if (payloadJson.EndsWith("}")) payloadJson = payloadJson.Substring(0, payloadJson.Length - 1);
                            WsClient guest;
                            if (_guests.TryGetValue(targetId, out guest)) {
                                SendWsText(guest, payloadJson);
                            }
                        }
                    } else {
                        WsClient h;
                        lock (_hostLock) { h = _hostClient; }
                        if (h != null) {
                            SendWsText(h, "{\"type\":\"from_guest\",\"clientId\":" + JsonString(client.Id) + ",\"payload\":" + text + "}");
                        }
                    }
                }
            }
        } catch {}

        if (client.IsHost) {
            lock (_hostLock) { if (_hostClient == client) _hostClient = null; }
        } else {
            WsClient removed;
            if (_guests.TryRemove(client.Id, out removed)) {
                WsClient h;
                lock (_hostLock) { h = _hostClient; }
                if (h != null) SendWsText(h, "{\"type\":\"guest_left\",\"clientId\":" + JsonString(client.Id) + "}");
            }
        }
        try { tcp.Close(); } catch {}
    }

    private async Task<Tuple<int, byte[]>> ReadWsFrame(NetworkStream stream) {
        var hdr = await ReadExact(stream, 2);
        if (hdr == null) return null;
        int opcode = hdr[0] & 0x0F;
        bool masked = (hdr[1] & 0x80) != 0;
        long len = hdr[1] & 0x7F;
        if (len == 126) {
            var ext = await ReadExact(stream, 2);
            if (ext == null) return null;
            len = (ext[0] << 8) | ext[1];
        } else if (len == 127) {
            var ext = await ReadExact(stream, 8);
            if (ext == null) return null;
            len = 0;
            for (int i = 0; i < 8; i++) len = (len << 8) | ext[i];
        }
        byte[] mask = masked ? await ReadExact(stream, 4) : null;
        if (masked && mask == null) return null;
        var payload = len > 0 ? await ReadExact(stream, (int)len) : new byte[0];
        if (payload == null) return null;
        if (masked) {
            for (int i = 0; i < payload.Length; i++) payload[i] ^= mask[i % 4];
        }
        return Tuple.Create(opcode, payload);
    }

    private async Task<byte[]> ReadExact(NetworkStream stream, int count) {
        var buf = new byte[count];
        int read = 0;
        while (read < count) {
            int n = await stream.ReadAsync(buf, read, count - read);
            if (n <= 0) return null;
            read += n;
        }
        return buf;
    }

    private void SendWsText(WsClient client, string text) {
        var payload = Encoding.UTF8.GetBytes(text);
        SendWsControl(client, 0x81, payload);
    }

    private void SendWsControl(WsClient client, byte firstByte, byte[] payload) {
        var len = payload.Length;
        byte[] header;
        if (len < 126) {
            header = new byte[] { firstByte, (byte)len };
        } else if (len < 65536) {
            header = new byte[] { firstByte, 126, (byte)((len >> 8) & 0xFF), (byte)(len & 0xFF) };
        } else {
            header = new byte[10];
            header[0] = firstByte;
            header[1] = 127;
            long v = len;
            for (int i = 9; i >= 2; i--) { header[i] = (byte)(v & 0xFF); v >>= 8; }
        }
        lock (client.WriteLock) {
            try {
                client.Stream.Write(header, 0, header.Length);
                if (payload.Length > 0) client.Stream.Write(payload, 0, payload.Length);
            } catch {}
        }
    }

    private void SendHttp(NetworkStream stream, string status, string mime, byte[] body) {
        var head = "HTTP/1.1 " + status + "\r\nContent-Type: " + mime + "\r\nContent-Length: " + body.Length + "\r\nConnection: close\r\n\r\n";
        var hb = Encoding.UTF8.GetBytes(head);
        stream.Write(hb, 0, hb.Length);
        stream.Write(body, 0, body.Length);
    }

    private static string GetMimeType(string ext) {
        switch (ext) {
            case ".html": return "text/html; charset=utf-8";
            case ".js": case ".mjs": return "application/javascript; charset=utf-8";
            case ".css": return "text/css; charset=utf-8";
            case ".json": return "application/json; charset=utf-8";
            case ".jpg": case ".jpeg": return "image/jpeg";
            case ".png": return "image/png";
            case ".svg": return "image/svg+xml";
            case ".ico": return "image/x-icon";
            default: return "application/octet-stream";
        }
    }
}
"@

# Find an available localhost port for the app UI
$Tcp = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, 0)
$Tcp.Start()
$UiPort = $Tcp.LocalEndpoint.Port
$Tcp.Stop()

$AppServer = New-Object CekiLanServer($WebRoot, $UiPort, $true)
$AppServer.Start()

$EdgePaths = @(
    "$env:ProgramFiles(x86)\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
    "$env:LocalAppData\Microsoft\Edge\Application\msedge.exe"
)
$ChromePaths = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "$env:ProgramFiles(x86)\Google\Chrome\Application\chrome.exe",
    "$env:LocalAppData\Google\Chrome\Application\chrome.exe"
)

$BrowserExe = $null
foreach ($p in ($EdgePaths + $ChromePaths)) {
    if ($p -and (Test-Path $p)) {
        $BrowserExe = $p
        break
    }
}

$AppUrl = "http://127.0.0.1:${UiPort}/index.html"
$UserDataDir = Join-Path $env:LocalAppData 'CekiBali\WebProfile'
New-Item -ItemType Directory -Force -Path $UserDataDir | Out-Null

$BrowserProc = $null
if ($BrowserExe) {
    $Args = "--app=`"$AppUrl`" --window-size=1280,800 --user-data-dir=`"$UserDataDir`" --no-first-run --disable-features=msEdgeSidebarV2"
    $BrowserProc = Start-Process -FilePath $BrowserExe -ArgumentList $Args -PassThru
} else {
    Start-Process $AppUrl | Out-Null
}

try {
    if ($BrowserProc) {
        $BrowserProc.WaitForExit()
    } else {
        while ($true) { Start-Sleep -Seconds 2 }
    }
} finally {
    if ([CekiLanServer]::ActiveLanRelay -ne $null) {
        [CekiLanServer]::ActiveLanRelay.Stop()
        [CekiLanServer]::ActiveLanRelay = null
    }
    $AppServer.Stop()
}
