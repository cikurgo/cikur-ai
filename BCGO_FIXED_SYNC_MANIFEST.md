# BCGO FIXED SYNC — 2026-09-05

SOURCE OF TRUTH
- bcgo.js: latest user-supplied BCGO, with only Firebase module provenance + cache-bust integration corrected.
- bcgo.html: latest user-supplied BCGO, with only the bcgo.js cache-bust query updated so the browser loads the fixed engine.
- cikur-config.js: exact user-supplied file; NOT MODIFIED.

ROOT FIX
BCGO previously imported Firestore/Auth functions from Firebase 10.8.0 gstatic while cikur-config.js created/exported db/auth using the project's local ./lib/firebase/firebase-firestore.js and ./lib/firebase/firebase-auth.js modules. The fixed bcgo.js now imports the same local modules, so db/auth and their functions come from the same Firebase module graph.

BOOT SAFETY
- No auth bypass.
- No forced authorization.
- No changes to admin_users rules.
- No changes to Firebase configuration.
- No changes to the 12-organ registry.
- No source mutation by BCGO.
- Internal AI remains optional to BCGO boot.

CACHE SYNC
- BCGO entry cache-bust: 2.16.1-firebase-local-sync-20260905
- Internal AI graph cache-bust: 5.2.5-sync-20260905

PROJECT-LEVEL DEPENDENCIES (INTENTIONALLY NOT FABRICATED)
./lib/firebase/firebase-app.js
./lib/firebase/firebase-firestore.js
./lib/firebase/firebase-auth.js
These must remain in the existing BCGO project at the same paths referenced by cikur-config.js and bcgo.js.
