Truth Console complete patch

Replace files:
- server.mjs  (or use the extensionless "server" file and rename it to server.mjs)
- public/app.js
- public/index.html
- public/style.css
- tools/proof-session.mjs

Optional:
- tools/browse-folder.ps1 is included, but the current browser UI uses typed path suggestions, not native folder browse.

Main fixes:
- Custom path loading accepts project root, .truth folder, latest-run.json, or summary.json.
- API returns clear 400 JSON errors with checkedPaths instead of generic 500.
- POST /api/projects and DELETE /api/projects/:id route order fixed.
- Server binds to 127.0.0.1 by default.
- Missing parent/left/right/target become red synthetic nodes.
- Command evidence objects resolve to stdout/stderr evidence files.
- proof-session command execution has timeouts and safer spawn behavior.
- config/projects.json starts empty.
