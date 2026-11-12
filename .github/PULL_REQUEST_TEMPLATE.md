## What changed

<!-- One paragraph. What can a user do now that they could not do before? -->

## Verification

- [ ] `npm test` passes
- [ ] `npm run check` passes
- [ ] If the UI changed: opened the page (hosted or standalone) and checked the console
- [ ] If data semantics changed: added a test for the derived structure, not only the first-level field

## Compatibility

- [ ] No change to the HTTP payloads, or the change is additive and documented
- [ ] Old single-file snapshots still open
- [ ] Node 22.13 remains supported

## Docs / version

- [ ] CHANGELOG updated
- [ ] `docs/verified.md` has evidence (commands, numbers, screenshots)
- [ ] Version bumped only when this is a release PR
