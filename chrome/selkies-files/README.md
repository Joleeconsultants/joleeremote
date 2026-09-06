# Selkies fancyindex file-browser shell

Vendored `header.html` + `footer.html` from Selkies `addons/selkies-web-core/nginx`
at the commit in `UPSTREAM` (kept in lockstep with the dashboard pin when possible).

The hop / portal assembles: header + current path + `</h1>` + `table#list` rows + footer.
Footer JS adds `download` and `?token=` on file links. Do not invent a custom Session files page.

Refresh: `bash scripts/sync-selkies-files.sh` (or pass a SHA / `latest`).
