// Nasir IAS Tracker — Push Server
// -----------------------------------------------------------------------------
const express = require('express');
const cors = require('cors');
const webpush = require('web-push');

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const DB_KEY = 'ias-tracker-db';

if (!UPSTASH_URL || !UPSTASH_TOKEN) {
    console.warn('WARNING: UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN are not set.');
}

// ---- VAPID keys ------------------------------------------------------------
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || 'BP4KipF_ViUedTrJU_zCNRIv9-VQD7OQo-n1cSxDdtb1gWsGPMvOOUNRbtl-Wgfj1IDYn-D8QvYu4gWAeCUZ7FM';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || 'PCtxJqmwDBUQnWp1aDv1OTuirw69A9n4h7am-xX4gfQ';
const VAPID_CONTACT = process.env.VAPID_CONTACT || 'mailto:admin@example.com';

webpush.setVapidDetails(VAPID_CONTACT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

// ---- Persistence via Upstash Redis REST API ---------------------------------
var db = { subscriptions: {}, schedule: [] };
var dbLoaded = false;

async function upstash(command) {
    if (!UPSTASH_URL || !UPSTASH_TOKEN) return null;
    var res = await fetch(UPSTASH_URL, {
        method: 'POST',
        headers: {
            Authorization: 'Bearer ' + UPSTASH_TOKEN,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(command)
    });
    if (!res.ok) {
        console.error('Upstash error', res.status, await res.text().catch(function () { return ''; }));
        return null;
    }
    var json = await res.json();
    return json.result;
}

async function loadData() {
    try {
        var raw = await upstash(['GET', DB_KEY]);
        if (raw) {
            db = JSON.parse(raw);
            console.log('Successfully synced data from Upstash storage.');
        }
    } catch (e) {
        console.error('Failed to load data from Upstash, starting empty:', e.message);
    }
    dbLoaded = true;
}

async function saveData() {
    if (!dbLoaded) return; 
    try {
        await upstash(['SET', DB_KEY, JSON.stringify(db)]);
    } catch (e) {
        console.error('Failed to save data to Upstash:', e.message);
    }
}

const app = express();
app.use(cors());
app.use(express.json());

// Middleware: Block data changes until the DB has fully finished loading
app.use(async function (req, res, next) {
    if (req.path.startsWith('/api/') && !dbLoaded) {
        await loadData();
    }
    next();
});

app.get('/', function (req, res) {
    res.send('Nasir IAS Tracker push server is running. Pending pushes: ' + db.schedule.length);
});

app.get('/health', function (req, res) {
    res.json({
        ok: true,
        storage: (UPSTASH_URL && UPSTASH_TOKEN) ? 'upstash' : 'in-memory-only (NOT PERSISTENT — set Upstash env vars)',
        pending: db.schedule.length,
        subscriptions: Object.keys(db.subscriptions).length
    });
});

app.get('/api/vapid-public-key', function (req, res) {
    res.json({ key: VAPID_PUBLIC_KEY });
});

app.post('/api/subscribe', async function (req, res) {
    var deviceId = req.body.deviceId;
    var subscription = req.body.subscription;
    if (!deviceId || !subscription) return res.status(400).json({ error: 'deviceId and subscription required' });
    db.subscriptions[deviceId] = subscription;
    await saveData();
    res.json({ ok: true });
});

app.post('/api/schedule', async function (req, res) {
    var deviceId = req.body.deviceId;
    var items = req.body.items;
    if (!deviceId || !Array.isArray(items)) return res.status(400).json({ error: 'deviceId and items[] required' });
    items.forEach(function (item) {
        db.schedule = db.schedule.filter(function (s) { return s.id !== item.id; });
        db.schedule.push({
            id: item.id,
            deviceId: deviceId,
            group: item.group || null,
            time: item.time,
            title: item.title || 'UPSC Tracker',
            body: item.body || ''
        });
    });
    await saveData();
    res.json({ ok: true, scheduledCount: db.schedule.length });
});

app.post('/api/cancel', async function (req, res) {
    var deviceId = req.body.deviceId;
    var group = req.body.group;
    if (!deviceId || !group) return res.status(400).json({ error: 'deviceId and group required' });
    var before = db.schedule.length;
    db.schedule = db.schedule.filter(function (s) { return !(s.deviceId === deviceId && s.group === group); });
    await saveData();
    res.json({ ok: true, removed: before - db.schedule.length });
});

// ---- The actual scheduler loop ----------------------------------------------
setInterval(async function () {
    if (!dbLoaded) return;
    var now = Date.now();
    var due = db.schedule.filter(function (s) { return s.time <= now; });
    if (!due.length) return;
    db.schedule = db.schedule.filter(function (s) { return s.time > now; });
    await saveData();
    for (var i = 0; i < due.length; i++) {
        var item = due[i];
        var sub = db.subscriptions[item.deviceId];
        if (!sub) {
            console.log('Skipped push "' + item.title + '" — no subscription on file for this device.');
            continue;
        }
        var payload = JSON.stringify({ title: item.title, body: item.body });
        try {
            await webpush.sendNotification(sub, payload);
            console.log('Sent push: ' + item.title);
        } catch (err) {
            console.error('Push send failed for "' + item.title + '":', err && err.statusCode, err && err.body);
            if (err && (err.statusCode === 410 || err.statusCode === 404)) {
                delete db.subscriptions[item.deviceId];
                await saveData();
            }
        }
    }
}, 10 * 1000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, function () {
    console.log('Push server listening on port ' + PORT);
    loadData();
});
