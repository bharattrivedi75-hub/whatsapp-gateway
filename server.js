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

        if (session.sock) {
            try {
                session.sock.ev.removeAllListeners();
                session.sock.end();
            } catch (_) {}
        }

        const sock = makeWASocket({
            version,
            auth: state,
            logger: pino({ level: 'silent' }),
            printQRInTerminal: false,
            browser: Browsers ? Browsers.ubuntu('Chrome') : ['Ubuntu', 'Chrome', '22.04.4'],
            keepAliveIntervalMs: 25000,
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 60000,
            emitOwnEvents: false,
            markOnlineOnConnect: true,
            syncFullHistory: false
        });

        session.sock = sock;
        session.isStarting = false;

        sock.ev.on('creds.update', async () => {
            try {
                await saveCreds();
            } catch (err) {
                console.error(`[Session ${session.id}] Save creds error:`, err);
            }
        });

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
                const isRestartRequired = statusCode === 515;
                const isLoggedOut = statusCode === DisconnectReason.loggedOut;
                const shouldReconnect = !isLoggedOut;

                console.log(`[Session ${session.id}] Connection closed (status: ${statusCode}), restartRequired: ${isRestartRequired}, reconnect: ${shouldReconnect}`);

                if (shouldReconnect) {
                    session.reconnectAttempts++;
                    // If stream restart (515) or temporary network blip, keep state CONNECTING
                    if (isRestartRequired || session.connectedUser) {
                        session.connectionState = 'CONNECTING';
                    } else {
                        session.connectionState = 'DISCONNECTED';
                    }
                    const delay = isRestartRequired ? 1500 : Math.min(session.reconnectAttempts * 2000, 10000);
                    setTimeout(() => initSocket(session), delay);
                } else {
                    session.connectionState = 'DISCONNECTED';
                    session.connectedUser = null;
                    session.currentQR = null;
                    session.pairingCode = null;
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
    const localUpdatedApk = path.join(__dirname, 'PulseSend-Updated.apk');
    if (fs.existsSync(localApk)) {
        return res.download(localApk, 'PulseSend.apk');
    }
    if (fs.existsSync(localUpdatedApk)) {
        return res.download(localUpdatedApk, 'PulseSend.apk');
    }
    res.redirect('https://github.com/bharattrivedi75-hub/whatsapp-gateway/raw/main/PulseSend.apk');
});

// ---------------------- 8. PulseSend Web & Cloud Scheduler ----------------------
const DATA_FILE = path.join(__dirname, 'server_data.json');

function loadWebData() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        }
    } catch (_) {}
    return {
        schedules: [],
        templates: [
            { id: 't1', title: '🌅 Good Morning (શુભ સવાર)', body: 'શુભ સવાર! તમારો આજનો દિવસ ખૂબ જ આનંદમય અને સફળ રહે તેવી હાર્દિક શુભકામનાઓ! 🌸' },
            { id: 't2', title: '🙏 Festival Wishes (શુભેચ્છાઓ)', body: 'તમને અને તમારા સમગ્ર પરિવારને આજના પાવન પર્વની હાર્દિક શુભેચ્છાઓ! ઈશ્વર સદાય સુખ-શાંતિ આપે. 🪔✨' },
            { id: 't3', title: '🎂 Birthday Wishes (જન્મદિવસ)', body: 'જન્મદિવસની ખૂબ ખૂબ હાર્દિક શુભકામનાઓ! 🎂🎉 ભગવાન તમને દીર્ઘાયુ અને ઉત્તમ સ્વાસ્થ્ય પ્રદાન કરે!' },
            { id: 't4', title: '💳 Payment Reminder (પેમેન્ટ યાદી)', body: 'નમસ્તે, આપનું બાકી પેમેન્ટ ચૂકવવા માટે વિનંતી છે. આપની અનુકૂળતા મુજબ જલ્દી ચૂકવણી કરવા નમ્ર વિનંતી. આભાર!' }
        ],
        logs: []
    };
}

function saveWebData(data) {
    try {
        fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
        console.error('Failed to save server_data.json:', err);
    }
}

// Background Cloud Scheduler - runs every 10 seconds
setInterval(async () => {
    const data = loadWebData();
    const now = new Date();
    let hasChanges = false;

    for (const schedule of data.schedules) {
        if (schedule.status === 'PENDING' && new Date(schedule.scheduledAt) <= now) {
            console.log(`[Cloud Scheduler] Due schedule ${schedule.id} to ${schedule.phone}`);
            const session = sessions.get(schedule.session || 'default');
            if (session && session.connectionState === 'CONNECTED' && session.sock) {
                try {
                    let cleanDigits = schedule.phone.replace(/[^0-9]/g, '');
                    if (cleanDigits.length === 10) cleanDigits = '91' + cleanDigits;
                    const jid = `${cleanDigits}@s.whatsapp.net`;
                    await session.sock.sendMessage(jid, { text: schedule.message });
                    schedule.status = 'SENT';
                    schedule.sentAt = new Date().toISOString();
                    data.logs.unshift({
                        id: 'log_' + Date.now(),
                        session: schedule.session,
                        phone: schedule.phone,
                        message: schedule.message,
                        status: 'SENT',
                        timestamp: new Date().toISOString()
                    });
                    hasChanges = true;
                    console.log(`[Cloud Scheduler] Sent successfully to ${schedule.phone}`);
                } catch (err) {
                    console.error(`[Cloud Scheduler] Error sending ${schedule.id}:`, err);
                    schedule.status = 'FAILED';
                    schedule.error = err.message;
                    data.logs.unshift({
                        id: 'log_' + Date.now(),
                        session: schedule.session,
                        phone: schedule.phone,
                        message: schedule.message,
                        status: 'FAILED',
                        error: err.message,
                        timestamp: new Date().toISOString()
                    });
                    hasChanges = true;
                }
            } else {
                console.log(`[Cloud Scheduler] Session [${schedule.session || 'default'}] not connected yet. Will retry next tick.`);
            }
        }
    }

    if (hasChanges) {
        data.logs = data.logs.slice(0, 300);
        saveWebData(data);
    }
}, 10000);

// Web Data APIs
app.get('/api/web/data', (req, res) => {
    const sessionId = getSessionIdFromReq(req);
    const data = loadWebData();
    const filteredSchedules = data.schedules.filter(s => (s.session || 'default') === sessionId);
    res.json({
        schedules: filteredSchedules,
        templates: data.templates,
        logs: data.logs.filter(l => (l.session || 'default') === sessionId)
    });
});

app.post('/api/web/schedule', (req, res) => {
    try {
        const { session, phone, message, scheduledAt } = req.body;
        if (!phone || !message || !scheduledAt) {
            return res.status(400).json({ success: false, error: 'Phone, message, and scheduledAt are required' });
        }
        const data = loadWebData();
        const newSched = {
            id: 'sched_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6),
            session: sanitizeSessionId(session || 'default'),
            phone: phone.trim(),
            message: message.trim(),
            scheduledAt,
            status: 'PENDING',
            createdAt: new Date().toISOString()
        };
        data.schedules.push(newSched);
        saveWebData(data);
        res.json({ success: true, schedule: newSched });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.delete('/api/web/schedule/:id', (req, res) => {
    const data = loadWebData();
    const beforeCount = data.schedules.length;
    data.schedules = data.schedules.filter(s => s.id !== req.params.id);
    if (data.schedules.length !== beforeCount) {
        saveWebData(data);
        return res.json({ success: true, message: 'Schedule cancelled' });
    }
    res.status(404).json({ success: false, error: 'Schedule not found' });
});

app.post('/api/web/template', (req, res) => {
    try {
        const { title, body } = req.body;
        if (!title || !body) return res.status(400).json({ success: false, error: 'Title and body required' });
        const data = loadWebData();
        const newTpl = {
            id: 'tpl_' + Date.now(),
            title: title.trim(),
            body: body.trim()
        };
        data.templates.push(newTpl);
        saveWebData(data);
        res.json({ success: true, template: newTpl });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.delete('/api/web/template/:id', (req, res) => {
    const data = loadWebData();
    data.templates = data.templates.filter(t => t.id !== req.params.id);
    saveWebData(data);
    res.json({ success: true });
});

app.delete('/api/web/logs', (req, res) => {
    const sessionId = getSessionIdFromReq(req);
    const data = loadWebData();
    data.logs = data.logs.filter(l => (l.session || 'default') !== sessionId);
    saveWebData(data);
    res.json({ success: true });
});

// Serve PulseSend Web Dashboard
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'web.html'));
});

app.get('/web', (req, res) => {
    res.sendFile(path.join(__dirname, 'web.html'));
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`[WhatsApp Gateway] Server running at http://localhost:${PORT}`);
    // initialize default session
    getOrCreateSession('default');
});
