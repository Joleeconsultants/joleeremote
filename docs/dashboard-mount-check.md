# Built dashboard deployment check

Run `npm run check:dashboard` after building the dashboard. Install the test
browser with `npx playwright install --only-shell chromium`; on Windows an
installed Edge can be used with `DASHBOARD_BROWSER_CHANNEL=msedge`.

The check serves the actual committed JavaScript and CSS on an ephemeral
loopback port, mounts the original dashboard, opens Screen Settings and resets
the controls with no native capability. It fails on uncaught browser errors or
missing controls. The inert iframe cannot open a remote session, and requests
outside the local fixture are blocked. Browser and server close on failure too.

The public PR workflow rebuilds the dashboard and checks that the committed
assets match before running the mount check. This is a predeployment gate:
merge it only after its check passes, then sync the exact checked public assets
to the private application. Live Windows and original-behavior verification
still follow deployment; a synthetic mount is not functional acceptance.

Regression proof: the broken DPI bundle at bf49864 fails to mount because
getStoredInt is out of scope; the corrected ce5b782 bundle passes. Testing pure
helpers and compiling alone did not catch that error. React portals mean an
empty #root is normal; this check inspects #dashboard-root and its controls.
