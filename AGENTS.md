# Verification

- Run `node --check seed_helper_v9.user.js` for userscript syntax.
- Run `node --test catalog.test.cjs` for catalog paging, completion filtering, and mocked fetch/XHR bridge regressions. These tests do not authenticate to or modify the live service.
- Run `git diff --check` before release. Live Tampermonkey validation is still required; Node tests do not verify the deployed site's response shape or browser sandbox behavior.

# Live evidence (no file handoff needed)

`capture_server.js` is a persistent local log sink on `127.0.0.1:8766`. Start it
with `start-capture.bat` (or `node capture_server.js`) and leave it running
while the queue runs.

The userscript auto-POSTs, no buttons required:

- `journal.log` — every status/debug line, streamed live (rotates at 8MB)
- `seed_diag_*.json` — compact bundle auto-posted on every queue transition
  (course skipped/done/returned), queue-complete, and catalog errors
- `seed_incident_*.json` — every stall incident (auto-download capped at 6)
- `seed_sniff_*.json` — manual DUMP payloads when sniffing

Latest file of each kind: `GET http://127.0.0.1:8766/latest`. Files land in
`captures/` — gitignored, safe to read directly when debugging.
