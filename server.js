const express = require('express');
const cors = require('cors');
const QRCode = require('qrcode');
const pino = require('pino');
const path = require('path');
const fs = require('fs');
let makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion, Browsers;

async function loadBaileys() {
    if (!makeWASocket) {
        const baileys = await import('@whiskeysockets/baileys');
        makeWASocket = baileys.default || baileys.makeWASocket;
        DisconnectReason = baileys.DisconnectReason;
        useMultiFileAuthState = baileys.useMultiFileAuthState;
        fetchLatestBaileysVersion = baileys.fetchLatestBaileysVersion;
        Browsers = baileys.Browsers;
    }
}

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const ROOT_AUTH_FOLDER = path.join(__dirname, 'auth_info');
if (!fs.existsSync(ROOT_AUTH_FOLDER)) {
    fs.mkdirSync(ROOT_AUTH_FOLDER, { recursive: true });
}

// Multi-session map: sessionId -> sessionData
const sessions = new Map();

function sanitizeSessionId(rawId) {
    if (!rawId || typeof rawId !== 'string') return 'default';
    const cleaned = rawId.trim().replace(/[^a-zA-Z0-9_-]/g, '_');
    return cleaned.length > 0 ? cleaned : 'default';
}

function getSessionIdFromReq(req) {
    const fromQuery = req.query?.session;
    const fromHeader = req.headers['x-session-id'];
    const fromBody = req.body?.session;
    return sanitizeSessionId(fromQuery || fromHeader || fromBody || 'default');
}

async function getOrCreateSession(sessionId) {
    const id = sanitizeSessionId(sessionId);
    if (sessions.has(id)) {
        return sessions.get(id);
    }

    const sessionAuthPath = path.join(ROOT_AUTH_FOLDER, id);
    if (!fs.existsSync(sessionAuthPath)) {
        fs.mkdirSync(sessionAuthPath, { recursive: true });
    }

    const session = {
        id,
        authFolder: sessionAuthPath,
        sock: null,
        connectionState: 'CONNECTING', // 'DISCONNECTED' | 'SCAN_QR' | 'CONNECTING' | 'CONNECTED'
        currentQR: null,
        connectedUser: null,
        pairingCode: null,
        reconnectAttempts: 0,
        isStarting: false
    };

    sessions.set(id, session);
    await initSocket(session);
    return session;
}

async function initSocket(session) {
    if (session.isStarting) return;
    session.isStarting = true;

    try {
        await loadBaileys();
        const { state, saveCreds } = await useMultiFileAuthState(session.authFolder);
        const { version } = await fetchLatestBaileysVersion();

        session.connectionState = 'CONNECTING';

        const sock = makeWASocket({
            version,
            auth: state,
            logger: pino({ level: 'silent' }),
            printQRInTerminal: false,
            browser: Browsers ? Browsers.ubuntu('Chrome') : ['Ubuntu', 'Chrome', '22.04.4']
        });

        session.sock = sock;
        session.isStarting = false;

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                session.connectionState = 'SCAN_QR';
                session.currentQR = await QRCode.toDataURL(qr);
                console.log(`[Session ${session.id}] QR Code generated.`);
            }

            if (connection === 'open') {
                session.connectionState = 'CONNECTED';
                session.currentQR = null;
                session.pairingCode = null;
                session.reconnectAttempts = 0;
                const jid = sock.user?.id || '';
                session.connectedUser = jid.split(':')[0] || jid.split('@')[0];
                console.log(`\n========================================`);
                console.log(`[Session ${session.id}] WhatsApp Connected!`);
                console.log(`[Session ${session.id}] Number: +${session.connectedUser}`);
                console.log(`========================================\n`);
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                session.connectionState = 'DISCONNECTED';
                session.connectedUser = null;
                session.currentQR = null;
                session.pairingCode = null;

                console.log(`[Session ${session.id}] Connection closed (${statusCode}), reconnect: ${shouldReconnect}`);

                if (shouldReconnect) {
                    session.reconnectAttempts++;
                    const delay = Math.min(session.reconnectAttempts * 3000, 15000);
                    setTimeout(() => initSocket(session), delay);
                } else {
                    console.log(`[Session ${session.id}] Logged out. Clearing credentials...`);
                    try {
                        fs.rmSync(session.authFolder, { recursive: true, force: true });
                    } catch (_) {}
                    setTimeout(() => initSocket(session), 3000);
                }
            }
        });
    } catch (err) {
        session.isStarting = false;
        console.error(`[Session ${session.id}] Error starting socket:`, err);
        setTimeout(() => initSocket(session), 5000);
    }
}

// ---------------------- REST APIs ----------------------

// 1. Connection status
app.get('/api/status', async (req, res) => {
    const sessionId = getSessionIdFromReq(req);
    const session = await getOrCreateSession(sessionId);

    res.json({
        sessionId: session.id,
        status: session.connectionState,
        connected: session.connectionState === 'CONNECTED',
        phone: session.connectedUser,
        qr: session.currentQR,
        pairingCode: session.pairingCode
    });
});

// 2. Request 8-Digit Pairing Code (No QR / Desktop required!)
app.post('/api/pairing-code', async (req, res) => {
    try {
        const sessionId = getSessionIdFromReq(req);
        const { phone } = req.body;

        if (!phone) {
            return res.status(400).json({ success: false, error: 'Phone number is required' });
        }

        let cleanDigits = phone.replace(/[^0-9]/g, '');
        if (cleanDigits.length === 10) {
            cleanDigits = '91' + cleanDigits;
        }

        const session = await getOrCreateSession(sessionId);

        if (session.connectionState === 'CONNECTED') {
            return res.json({
                success: true,
                alreadyConnected: true,
                phone: session.connectedUser,
                message: 'WhatsApp is already connected for this session!'
            });
        }

        if (!session.sock) {
            return res.status(503).json({ success: false, error: 'Socket is initializing, please try again in 5 seconds.' });
        }

        if (!session.sock.authState.creds.registered) {
            // Wait 1 second to make sure socket handshake is ready
            await new Promise(r => setTimeout(r, 1200));
            const rawCode = await session.sock.requestPairingCode(cleanDigits);
            // Format code nicely (e.g. ABCD-1234)
            const formattedCode = rawCode?.match(/.{1,4}/g)?.join('-') || rawCode;
            session.pairingCode = formattedCode;

            console.log(`[Session ${session.id}] Generated pairing code for +${cleanDigits}: ${formattedCode}`);

            return res.json({
                success: true,
                code: formattedCode,
                rawCode: rawCode,
                phone: cleanDigits,
                sessionId: session.id
            });
        } else {
            return res.json({
                success: true,
                alreadyConnected: true,
                phone: session.connectedUser
            });
        }
    } catch (err) {
        console.error('[Pairing Code Error]:', err);
        return res.status(500).json({
            success: false,
            error: err.message || 'Failed to request pairing code'
        });
    }
});

// 3. Send WhatsApp message
app.post('/api/send', async (req, res) => {
    try {
        const sessionId = getSessionIdFromReq(req);
        const { phone, message } = req.body;

        if (!phone || !message) {
            return res.status(400).json({ success: false, error: 'Both phone and message are required' });
        }

        const session = await getOrCreateSession(sessionId);

        if (session.connectionState !== 'CONNECTED' || !session.sock) {
            return res.status(503).json({
                success: false,
                error: `WhatsApp session [${sessionId}] is not connected. Please link WhatsApp first.`,
                status: session.connectionState
            });
        }

        let cleanDigits = phone.replace(/[^0-9]/g, '');
        if (cleanDigits.length === 10) {
            cleanDigits = '91' + cleanDigits;
        }

        const jid = `${cleanDigits}@s.whatsapp.net`;
        const sent = await session.sock.sendMessage(jid, { text: message });

        console.log(`[Session ${session.id}] Message sent to +${cleanDigits} at ${new Date().toLocaleTimeString()}`);

        return res.json({
            success: true,
            messageId: sent.key.id,
            timestamp: sent.messageTimestamp
        });
    } catch (err) {
        console.error('[Send Error]:', err);
        return res.status(500).json({
            success: false,
            error: err.message || 'Failed to send WhatsApp message'
        });
    }
});

// 4. Disconnect / Logout session
app.post('/api/disconnect', async (req, res) => {
    try {
        const sessionId = getSessionIdFromReq(req);
        const session = sessions.get(sessionId);

        if (session && session.sock) {
            try {
                await session.sock.logout();
            } catch (_) {}
            try {
                fs.rmSync(session.authFolder, { recursive: true, force: true });
            } catch (_) {}
            sessions.delete(sessionId);
            // Re-init clean session
            setTimeout(() => getOrCreateSession(sessionId), 1000);
        }

        res.json({ success: true, message: `Session [${sessionId}] disconnected and cleared` });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// 5. In-App Auto-Update endpoint
app.get('/api/app-version', (req, res) => {
    res.json({
        latestVersionCode: 2,
        latestVersionName: '1.1',
        apkUrl: `${req.protocol}://${req.get('host')}/download/apk`,
        changelog: '1. Language Selector (ગુજરાતી, हिंदी, English)\n2. First-Launch Auto WhatsApp Link\n3. In-App 1-Click Update System',
        forceUpdate: false
    });
});

// 6. Play Store Style Download Landing Page
app.get('/download', (req, res) => {
    res.sendFile(path.join(__dirname, 'playstore.html'));
});

// 7. Direct APK Download Endpoint
app.get('/download/apk', (req, res) => {
    const localApk = path.join(__dirname, 'PulseSend.apk');
    if (fs.existsSync(localApk)) {
        return res.download(localApk, 'PulseSend.apk');
    }
    res.redirect('https://github.com/bharattrivedi75-hub/whatsapp-gateway/raw/main/PulseSend.apk');
});

// 8. Web Dashboard UI
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="gu">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>PulseSend - WhatsApp Multi-Device Gateway</title>
    <style>
        * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
        body { background: #0f172a; color: #f8fafc; margin: 0; padding: 20px; display: flex; justify-content: center; align-items: center; min-height: 100vh; }
        .card { background: #1e293b; max-width: 520px; width: 100%; border-radius: 20px; padding: 28px; box-shadow: 0 20px 40px rgba(0,0,0,0.4); border: 1px solid #334155; }
        .badge { display: inline-block; padding: 6px 16px; border-radius: 20px; font-weight: 600; font-size: 14px; margin-bottom: 16px; }
        .badge.connected { background: #14532d; color: #4ade80; border: 1px solid #22c55e; }
        .badge.scan_qr { background: #713f12; color: #facc15; border: 1px solid #eab308; }
        .badge.disconnected { background: #7f1d1d; color: #f87171; border: 1px solid #ef4444; }
        .session-box { background: #0f172a; border: 1px solid #334155; border-radius: 12px; padding: 12px 16px; margin-bottom: 20px; text-align: left; }
        .session-box label { font-size: 12px; color: #94a3b8; font-weight: 600; text-transform: uppercase; }
        .session-box input { background: transparent; border: none; color: #38bdf8; font-size: 15px; font-weight: bold; width: 100%; outline: none; margin-top: 4px; }
        .tab-bar { display: flex; background: #0f172a; border-radius: 10px; padding: 4px; margin-bottom: 20px; }
        .tab-btn { flex: 1; padding: 8px 12px; border: none; background: transparent; color: #94a3b8; font-weight: 600; font-size: 14px; cursor: pointer; border-radius: 8px; }
        .tab-btn.active { background: #2563eb; color: #fff; }
        .pairing-card { background: #0f172a; border: 1px solid #334155; border-radius: 14px; padding: 20px; margin-bottom: 20px; text-align: center; }
        .code-display { font-size: 32px; font-family: monospace; font-weight: 800; letter-spacing: 4px; color: #4ade80; background: #052e16; padding: 12px; border-radius: 10px; border: 2px dashed #22c55e; margin: 16px 0; user-select: all; cursor: pointer; }
        .input-group { display: flex; gap: 8px; margin: 12px 0; }
        .input-group input { flex: 1; padding: 12px; border-radius: 8px; border: 1px solid #475569; background: #1e293b; color: #fff; font-size: 16px; outline: none; }
        .input-group button { padding: 12px 18px; border-radius: 8px; border: none; background: #22c55e; color: #000; font-weight: bold; cursor: pointer; font-size: 15px; }
        .qr-box { margin: 16px 0; min-height: 240px; display: flex; align-items: center; justify-content: center; }
        .qr-box img { max-width: 220px; border-radius: 12px; border: 4px solid #334155; }
        .guide-box { background: #0f172a; border-radius: 10px; padding: 14px; margin-top: 16px; text-align: left; font-size: 13px; color: #cbd5e1; line-height: 1.6; border: 1px solid #334155; }
        .guide-box strong { color: #38bdf8; }
        .btn-danger { background: #dc2626; color: white; border: none; padding: 10px 20px; border-radius: 8px; font-weight: 600; cursor: pointer; width: 100%; margin-top: 12px; }
    </style>
</head>
<body>
    <div class="card">
        <h2 style="margin: 0 0 6px 0; color: #38bdf8;">⚡ PulseSend Gateway</h2>
        <p style="margin: 0 0 16px 0; color: #94a3b8; font-size: 13px;">Multi-Device WhatsApp Automation (Zero Accessibility)</p>
        
        <div class="session-box">
            <label>ડિવાઇસ / Session ID:</label>
            <input type="text" id="sessionIdInput" value="default" placeholder="દા.ત. mobile_1 અથવા ફોન નંબર" onchange="switchSession()" />
        </div>

        <div id="statusBadge" class="badge disconnected">તપાસી રહ્યું છે...</div>

        <div class="tab-bar">
            <button class="tab-btn active" id="tabPairing" onclick="showTab('pairing')">🔢 Pairing Code (કમ્પ્યુટર વગર)</button>
            <button class="tab-btn" id="tabQR" onclick="showTab('qr')">📷 QR Code</button>
        </div>

        <!-- Section 1: Pairing Code without Desktop -->
        <div id="pairingSection" class="pairing-card">
            <p style="margin: 0 0 8px 0; font-size: 14px; color: #e2e8f0;"><strong>કોઈ કમ્પ્યુટર કે સ્કેનિંગની જરૂર નથી!</strong><br>સીધા તમારા જ મોબાઈલમાંથી લિંક કરો:</p>

            <div class="input-group">
                <input type="tel" id="mobileNumber" placeholder="દા.ત. 9876543210" maxlength="12" />
                <button onclick="requestPairingCode()">કોડ મેળવો</button>
            </div>

            <div id="codeContainer" style="display: none;">
                <div class="code-display" id="pairingCodeVal" onclick="copyCode()">----</div>
                <p style="font-size: 12px; color: #94a3b8; margin: 4px 0 12px 0;">(કોડ કોપી કરવા ક્લિક કરો)</p>
                <button onclick="copyCode()" style="background: #3b82f6; color: white; border: none; padding: 8px 16px; border-radius: 6px; font-weight: 600; cursor: pointer;">📋 Copy Code</button>
            </div>

            <div class="guide-box">
                <strong>મોબાઈલમાં કેવી રીતે લિંક કરવું:</strong>
                <ol style="margin: 6px 0 0 0; padding-left: 20px;">
                    <li>મોબાઈલમાં <strong>WhatsApp</strong> ખોલો.</li>
                    <li>ત્રણ ટપકાં (Settings) ➔ <strong>Linked Devices</strong> પર જાઓ.</li>
                    <li><strong>Link a device</strong> પર ક્લિક કરો.</li>
                    <li>નીચે <strong>"Link with phone number instead"</strong> (ફોન નંબર વડે લિંક કરો) પસંદ કરો.</li>
                    <li>ઉપરનો <strong>૮-અક્ષરનો કોડ</strong> ત્યાં દાખલ કરો!</li>
                </ol>
            </div>
        </div>

        <!-- Section 2: QR Code -->
        <div id="qrSection" style="display: none; text-align: center;">
            <div class="qr-box" id="qrContainer">
                <p style="color: #64748b;">કનેક્ટ થઈ રહ્યું છે...</p>
            </div>
        </div>

        <button id="logoutBtn" class="btn-danger" style="display:none;" onclick="disconnectWA()">Disconnect WhatsApp</button>
    </div>

    <script>
        let currentTab = 'pairing';
        const urlParams = new URLSearchParams(window.location.search);
        if (urlParams.get('session')) {
            document.getElementById('sessionIdInput').value = urlParams.get('session');
        }

        function getCurSession() {
            return document.getElementById('sessionIdInput').value.trim() || 'default';
        }

        function switchSession() {
            const sess = getCurSession();
            const newUrl = window.location.pathname + '?session=' + encodeURIComponent(sess);
            window.history.replaceState(null, '', newUrl);
            checkStatus();
        }

        function showTab(tab) {
            currentTab = tab;
            document.getElementById('tabPairing').className = 'tab-btn ' + (tab === 'pairing' ? 'active' : '');
            document.getElementById('tabQR').className = 'tab-btn ' + (tab === 'qr' ? 'active' : '');
            document.getElementById('pairingSection').style.display = tab === 'pairing' ? 'block' : 'none';
            document.getElementById('qrSection').style.display = tab === 'qr' ? 'block' : 'none';
        }

        async function requestPairingCode() {
            const phone = document.getElementById('mobileNumber').value.trim();
            if (!phone || phone.length < 10) {
                alert('કૃપા કરીને સાચો ૧૦ અંકનો મોબાઈલ નંબર નાખો!');
                return;
            }

            const codeContainer = document.getElementById('codeContainer');
            const codeVal = document.getElementById('pairingCodeVal');
            codeVal.innerText = 'લાવી રહ્યું છે...';
            codeContainer.style.display = 'block';

            try {
                const res = await fetch('/api/pairing-code', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ session: getCurSession(), phone: phone })
                });
                const data = await res.json();

                if (data.success && data.code) {
                    codeVal.innerText = data.code;
                } else if (data.alreadyConnected) {
                    alert('આ સેશન પર WhatsApp પહેલેથી કનેક્ટ થયેલું છે (+ ' + data.phone + ')');
                    checkStatus();
                } else {
                    alert('ભૂલ: ' + (data.error || 'કોડ મળી શક્યો નહીં'));
                    codeContainer.style.display = 'none';
                }
            } catch (err) {
                alert('સર્વર સાથે કનેક્ટ ન થઈ શક્યું: ' + err.message);
                codeContainer.style.display = 'none';
            }
        }

        function copyCode() {
            const code = document.getElementById('pairingCodeVal').innerText;
            if (code && code !== '----') {
                navigator.clipboard.writeText(code.replace('-', ''));
                alert('કોડ કોપી થઈ ગયો: ' + code);
            }
        }

        async function checkStatus() {
            try {
                const res = await fetch('/api/status?session=' + encodeURIComponent(getCurSession()));
                const data = await res.json();
                const badge = document.getElementById('statusBadge');
                const qrContainer = document.getElementById('qrContainer');
                const logoutBtn = document.getElementById('logoutBtn');

                if (data.status === 'CONNECTED') {
                    badge.className = 'badge connected';
                    badge.innerText = '✅ કનેક્ટ થયેલ છે: +' + data.phone;
                    logoutBtn.style.display = 'block';
                    if (qrContainer) qrContainer.innerHTML = '<div style="color: #4ade80; font-weight: 600;">✨ WhatsApp સક્રિય છે!</div>';
                } else if (data.status === 'SCAN_QR' && data.qr) {
                    badge.className = 'badge scan_qr';
                    badge.innerText = '⏳ લિંક કરવા તૈયાર';
                    logoutBtn.style.display = 'none';
                    if (qrContainer) qrContainer.innerHTML = '<img src="' + data.qr + '" alt="QR Code" />';
                } else {
                    badge.className = 'badge disconnected';
                    badge.innerText = '⏳ ડિસ્કનેક્ટ (' + data.status + ')';
                    logoutBtn.style.display = 'none';
                }
            } catch (err) {
                console.error(err);
            }
        }

        async function disconnectWA() {
            if (confirm('શું તમે આ સેશનનું WhatsApp ડિસ્કનેક્ટ કરવા માંગો છો?')) {
                await fetch('/api/disconnect', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ session: getCurSession() })
                });
                checkStatus();
            }
        }

        setInterval(checkStatus, 4000);
        checkStatus();
    </script>
</body>
</html>
    `);
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`[WhatsApp Gateway] Server running at http://localhost:${PORT}`);
    // initialize default session
    getOrCreateSession('default');
});
