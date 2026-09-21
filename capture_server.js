// Seed Helper capture listener — receives auto-posted incidents/diags/sniffs
// from the userscript (127.0.0.1:8766) and writes them into captures/.
// Run:  node capture_server.js        (leave it running while using START)
// Then: "check the latest capture" → the newest file in captures/ has the JSON.
const http = require('http');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'captures');
fs.mkdirSync(OUT, { recursive: true });

const safeName = s => String(s || 'unknown').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40) || 'unknown';
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

function save(kind, body) {
    let type = kind;
    try { const j = JSON.parse(body); if (kind === 'incident') type = 'incident_' + safeName(j.type); } catch (e) {}
    const file = path.join(OUT, `seed_${type}_${stamp()}.json`);
    fs.writeFileSync(file, body);
    return file;
}

function latest() {
    const files = fs.readdirSync(OUT).filter(f => f.endsWith('.json') || f.endsWith('.log'))
        .map(f => ({ f, t: fs.statSync(path.join(OUT, f)).mtimeMs })).sort((a, b) => b.t - a.t);
    const pick = p => { const h = files.find(x => x.f.startsWith(p)); return h ? h.f : null; };
    return { incident: pick('seed_incident'), diag: pick('seed_diag'), sniff: pick('seed_sniff'), any: files[0] && files[0].f };
}

const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    if (req.method === 'GET' && req.url === '/latest') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(latest()));
        return;
    }

    if (req.method === 'POST') {
        let body = '';
        req.on('data', c => { body += c; if (body.length > 8e6) req.destroy(); });
        req.on('end', () => {
            let file = null;
            if (req.url === '/log') {
                file = path.join(OUT, 'journal.log');
                fs.appendFileSync(file, `[${new Date().toISOString()}] ${body}\n`);
            } else if (req.url === '/incident' || req.url === '/diag' || req.url === '/sniff') {
                file = save(req.url.slice(1), body);
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, file: file ? path.basename(file) : null }));
            if (file) console.log(`${req.method} ${req.url} -> ${path.basename(file)} (${body.length}b)`);
        });
        return;
    }

    res.writeHead(404); res.end();
});

server.listen(8766, '127.0.0.1', () => console.log(`seed capture listener → ${OUT} (GET /latest for newest)`));
