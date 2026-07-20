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
        var d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        if (!d.deviceMeta) d.deviceMeta = {};
        return d;
    } catch (e) {
        return { subscriptions: {}, schedule: [], deviceMeta: {} };
    }
}
function saveData(data) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}
var db = loadData();

// ---- Fixed daily reminders (the server now owns this schedule) --------------
// These used to only get registered when the app happened to be opened that
// day — meaning if you didn't open the app before, say, 11 AM, the 11 AM
// reminder simply never got queued at all. Now the server itself regenerates
// this list once per calendar day, per device, with zero dependence on the
// app ever being opened.
const FIXED_DAILY_ITEMS = [
    // Forced accountability check-ins — the push notification itself is just
    // a nudge; the actual "can't skip" enforcement (typed response required)
    // happens in the app once opened. The title is deliberately more urgent.
    { key: 'acc-morning', hour: 8, minute: 0, title: '🔒 Accountability Check', body: "Have you started your studies today? Open the app to confirm." },
    { key: 'acc-noon', hour: 12, minute: 0, title: '🔒 Accountability Check', body: "Are you studying right now? Open the app to answer." },
    { key: 'acc-midday', hour: 16, minute: 0, title: '🔒 Accountability Check', body: "Are you actually studying right now? Open the app to answer." },
    { key: 'acc-exercise', hour: 19, minute: 0, title: '🔒 Accountability Check', body: "It's 7 PM — time to go for exercise. Open the app to confirm." },
    { key: 'acc-2045', hour: 20, minute: 45, title: '🔒 Accountability Check', body: "Are you studying right now? Open the app to answer." },
    { key: 'acc-2110', hour: 21, minute: 10, title: '🔒 Accountability Check', body: "Are you studying right now? Open the app to answer." },
    { key: 'acc-library', hour: 22, minute: 15, title: '🔒 Accountability Check', body: "It's 10:15 PM — time to leave the library and head home. Open the app to confirm." },

    { key: 'block-block1', hour: 13, minute: 0, title: '📋 Block 1 (Morning) Check-In', body: 'How much of Block 1 (Morning) have you completed today?' },
    { key: 'block-block2', hour: 18, minute: 0, title: '📋 Block 2 (Afternoon) Check-In', body: 'How much of Block 2 (Afternoon) have you completed today?' },
    { key: 'block-block3', hour: 21, minute: 0, title: '📋 Block 3 (Evening) Check-In', body: 'How much of Block 3 (Evening) have you completed today?' },
    { key: 'block-block4', hour: 23, minute: 0, title: '📋 Block 4 (Night) Check-In', body: 'How much of Block 4 (Night) have you completed today?' },

    { key: 'mot-11', hour: 11, minute: 0, title: 'UPSC Tracker', body: "If you waste today, it will never come back. One more day of your preparation is gone. Get up — start now." },
    { key: 'mot-13', hour: 13, minute: 0, title: 'UPSC Tracker', body: "Half the day is gone. Look back honestly — did the morning count for something, or did it slip away?" },
    { key: 'mot-15', hour: 15, minute: 0, title: 'UPSC Tracker', body: "You are aging. You don't have much time left. Burn this time now, push hard and you will shine — or spend your whole life in remorse over days like this one." },
    { key: 'mot-18', hour: 18, minute: 0, title: 'UPSC Tracker', body: "The evening is here and the day is almost spent. Whatever you haven't done yet, there is still time tonight — don't let it slip." },
    { key: 'mot-20', hour: 20, minute: 0, title: 'UPSC Tracker', body: "Most people have stopped for the day. The ones who make it are the ones still going right now." },
    { key: 'mot-2130', hour: 21, minute: 30, title: 'UPSC Tracker', body: "A few hours of the day remain. What you do with them is what separates this year from a repeat of it." },
    { key: 'mot-23', hour: 23, minute: 0, title: 'UPSC Tracker', body: "One hour left in today. Not tomorrow — today. What's still undone?" },
    { key: 'mot-2315', hour: 23, minute: 15, title: 'UPSC Tracker', body: "45 minutes. This day does not come back. Use what's left of it." },
    { key: 'mot-2330', hour: 23, minute: 30, title: 'UPSC Tracker', body: "30 minutes left in today. Be honest with yourself about how it went." },
    { key: 'mot-2345', hour: 23, minute: 45, title: 'UPSC Tracker', body: "15 minutes left in today. To win tomorrow, you need proper sleep — heal your mind and body tonight so you can go again." }
];

// Given a device's timezone offset (minutes, from JS Date.getTimezoneOffset()),
// figure out today's date *in that device's local time* and queue any of
// today's fixed items that haven't happened yet. Safe to call often — it
// no-ops once a given local day has already been handled for that device.
function ensureDailyScheduleFor(deviceId) {
    var meta = db.deviceMeta[deviceId];
    if (!meta || typeof meta.tzOffsetMinutes !== 'number') return;
    var offset = meta.tzOffsetMinutes;
    var nowUTC = Date.now();
    var localMs = nowUTC - offset * 60000;
    var localDate = new Date(localMs);
    var y = localDate.getUTCFullYear(), mo = localDate.getUTCMonth(), da = localDate.getUTCDate();
    var dateKey = y + '-' + (mo + 1) + '-' + da;
    if (meta.lastAutoScheduledLocalDate === dateKey) return;
    meta.lastAutoScheduledLocalDate = dateKey;
    FIXED_DAILY_ITEMS.forEach(function (it) {
        var targetUTC = Date.UTC(y, mo, da, it.hour, it.minute, 0, 0) + offset * 60000;
        if (targetUTC > nowUTC) {
            var id = 'auto-' + dateKey + '-' + it.key + '-' + deviceId;
            db.schedule = db.schedule.filter(function (s) { return s.id !== id; });
            db.schedule.push({ id: id, deviceId: deviceId, group: 'auto-daily', time: targetUTC, title: it.title, body: it.body });
        }
    });
    saveData(db);
}

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

// Save/replace a device's push subscription. tzOffsetMinutes (from the
// browser's Date.getTimezoneOffset()) lets the server compute "8 AM your
// time" correctly and keep the daily schedule renewing on its own.
app.post('/api/subscribe', function (req, res) {
    var deviceId = req.body.deviceId;
    var subscription = req.body.subscription;
    var tzOffsetMinutes = req.body.tzOffsetMinutes;
    if (!deviceId || !subscription) return res.status(400).json({ error: 'deviceId and subscription required' });
    db.subscriptions[deviceId] = subscription;
    if (typeof tzOffsetMinutes === 'number') {
        if (!db.deviceMeta[deviceId]) db.deviceMeta[deviceId] = {};
        db.deviceMeta[deviceId].tzOffsetMinutes = tzOffsetMinutes;
    }
    saveData(db);
    ensureDailyScheduleFor(deviceId);
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
    // Independent of any app ever opening: make sure every subscribed device
    // has today's fixed reminders queued (no-ops instantly once already done
    // for the current local day).
    Object.keys(db.subscriptions).forEach(function (deviceId) {
        ensureDailyScheduleFor(deviceId);
    });

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
