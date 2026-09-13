# CIKUR GO — HARD CUT DEPLOYMENT CHECKLIST

- [ ] Replace the deployed BCGO-CGO-Medicine-Executor files with the complete `deploy/` package.
- [ ] Keep `INTEGRATION-MANIFEST.txt` at package root.
- [ ] Do not mix old Medicine/Executor files with this package.
- [ ] Admin login succeeds.
- [ ] BCGO source scan completes and reads the deployed Customer/Mitra source.
- [ ] Captain receives BCGO_STATE and selects the real active case target.
- [ ] Captain dispatches Medicine investigation without waiting for Executor.
- [ ] Medicine receives BCGO/Captain packets on `CIKUR_GO_BCGO_CGO_BRIDGE_V1`.
- [ ] Executor receives Medicine candidate/review packets on the same channel.
- [ ] Human Gate opens only after Executor review = VALID.
- [ ] Approval reaches Medicine, then Captain authorization reaches Executor.
- [ ] Executor readback/validation is visible.
- [ ] Failed or missing execution target stays fail-closed.
- [ ] Change one Customer source file harmlessly; wait for the 20s scan cycle and confirm architecture/source revision changes.
- [ ] Confirm Workbench remains on the selected target and does not jump file-by-file during scanning.
- [ ] Confirm removed referenced file enters REVIEW/UNKNOWN instead of false HEALTHY.
