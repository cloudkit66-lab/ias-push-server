// Nasir IAS Tracker — Push Server
// -----------------------------------------------------------------------------
// This tiny server is the missing piece that makes notifications arrive even
// when your phone's browser tab is fully closed or frozen. The app (running on
// your phone) tells this server "notify me at this exact time with this
// message" whenever you start a timer or open the app for the day. This
// server then wakes up at that exact second — completely independent of your
// phone's browser — and pushes the notification through Google/Apple's own
// push infrastructure straight to your phone. That's the same mechanism apps
// like WhatsApp and Gmail use for background notifications.
//
// You do not need to understand this file to use it — just deploy it once
// following DEPLOY.md, then forget about it. It runs quietly in the
// background forever.
// -----------------------------------------------------------------------------

const express = require('express');
const cors = require('cors');
const webpush = require('web-push');
const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'data.json');

// ---- VAPID keys (your app's push "identity") --------------------------------
// Pre-filled with a real, working key pair generated for you. You can
// override these with your own via environment variables if you ever want to,
// but it is NOT required — the defaults below work out of the box.
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || 'BP4KipF_ViUedTrJU_zCNRIv9-VQD7OQo-n1cSxDdtb1gWsGPMvOOUNRbtl-Wgfj1IDYn-D8QvYu4gWAeCUZ7FM';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || 'PCtxJqmwDBUQnWp1aDv1OTuirw69A9n4h7am-xX4gfQ';
const VAPID_CONTACT = process.env.VAPID_CONTACT || 'mailto:admin@example.com';

webpush.setVapidDetails(VAPID_CONTACT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

// ---- Tiny JSON-file persistence ---------------------------------------------
// Good enough for a single user. Structure:
// { subscriptions: { [deviceId]: pushSubscriptionObject }, schedule: [ {id, deviceId, group, time, title, body} ] }
function loadData() {
    try {
        return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    } catch (e) {
        return { subscriptions: {}, schedule: [] };
    }
}
function saveData(data) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}
var db = loadData();

const app = express();
app.use(cors());
app.use(express.json());

app.get('/', function (req, res) {
    res.send('Nasir IAS Tracker push server is running. Pending pushes: ' + db.schedule.length);
});

app.get('/health', function (req, res) {
    res.json({ ok: true, pending: db.schedule.length, subscriptions: Object.keys(db.subscriptions).length });
});

app.get('/api/vapid-public-key', function (req, res) {
    res.json({ key: VAPID_PUBLIC_KEY });
});

// Save/replace a device's push subscription
app.post('/api/subscribe', function (req, res) {
    var deviceId = req.body.deviceId;
    var subscription = req.body.subscription;
    if (!deviceId || !subscription) return res.status(400).json({ error: 'deviceId and subscription required' });
    db.subscriptions[deviceId] = subscription;
    saveData(db);
    res.json({ ok: true });
});

// Schedule one or more future notifications for a device.
// Each item: { id (unique string), group (string, used to cancel/replace a batch), time (epoch ms), title, body }
// Re-sending an item with the same id replaces the old one (so restarting a
// timer just overwrites its old schedule instead of duplicating it).
app.post('/api/schedule', function (req, res) {
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
    saveData(db);
    res.json({ ok: true, scheduledCount: db.schedule.length });
});

// Cancel all pending notifications in a group for a device (e.g. when a timer
// is paused or reset, so stale phase-completion alerts don't fire later).
app.post('/api/cancel', function (req, res) {
    var deviceId = req.body.deviceId;
    var group = req.body.group;
    if (!deviceId || !group) return res.status(400).json({ error: 'deviceId and group required' });
    var before = db.schedule.length;
    db.schedule = db.schedule.filter(function (s) { return !(s.deviceId === deviceId && s.group === group); });
    saveData(db);
    res.json({ ok: true, removed: before - db.schedule.length });
});

// ---- The actual scheduler loop ----------------------------------------------
// Every 10 seconds, check for anything due and push it. This is what keeps
// running in the background on the server, totally independent of whether
// your phone's browser is open.
setInterval(function () {
    var now = Date.now();
    var due = db.schedule.filter(function (s) { return s.time <= now; });
    if (!due.length) return;
    db.schedule = db.schedule.filter(function (s) { return s.time > now; });
    saveData(db);
    due.forEach(function (item) {
        var sub = db.subscriptions[item.deviceId];
        if (!sub) return;
        var payload = JSON.stringify({ title: item.title, body: item.body });
        webpush.sendNotification(sub, payload).catch(function (err) {
            // 410/404 means the subscription is no longer valid (e.g. user cleared
            // site data) — remove it so we stop trying.
            if (err && (err.statusCode === 410 || err.statusCode === 404)) {
                delete db.subscriptions[item.deviceId];
                saveData(db);
            }
        });
    });
}, 10 * 1000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, function () {
    console.log('Push server listening on port ' + PORT);
});
