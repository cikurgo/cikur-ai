# Medicine Boot Hardening v3

- UI now fast-paints before the Firebase/internal-CGO module graph is dynamically imported.
- Dynamic import errors are surfaced in a visible boot status instead of leaving a blank screen.
- Cache-busting version is 3.4.2.
- The V5.2 internal AI bridge remains intact; no external AI/API was added.
- Existing realtime source reuse hardening remains active: unchanged source hashes are reused instead of re-downloaded every scan heartbeat.
