# Website restrictions — 22 October 2026

The side panel is disabled globally and enabled separately for HTTPS Udemy
(including subdomains) and `learn.deeplearning.ai` tabs. The toolbar action is
disabled elsewhere. Shared page-injection helpers and screenshot capture also
check the target site; screenshots must target the currently visible lesson.

Removed required `<all_urls>` access. Required hosts now cover the supported
sites, `192.168.3.20`, and localhost. Custom notes servers request their specific
origin when settings are saved. Explicit toolbar action handling grants activeTab
for screenshots; Chrome's built-in panel toggle did not grant it in live tests.

Background transcript saving remains available for loaded supported lessons.
The automatic-transcript setting is honored by both the worker and panel;
explicit Process lesson can still request its transcript.

## Verification

- Live Chrome on the Mac: Udemy panel opens; hides when switching to GitHub;
  restores on return to Udemy.
- Final build: DeepLearning.AI panel opens with existing notes/transcript;
  screenshot saved at 1:53 after clicking the toolbar icon; panel hides on GitHub.
- Saving the existing default server address succeeds with narrowed permissions.
- `node tests/site_scope.mjs`: supported/unsupported host boundaries, per-tab
  panel configuration, navigation away, unsupported keyboard commands,
  blocked injection/capture, background transcript saving and opt-out.
- Existing page-adapter and timestamp-link tests pass.

Remote deployment requires extension reload in Chrome. Live browser controls
still cover the Mac, not `192.168.3.210`; file synchronization is verified separately.
The six changed runtime files were deployed to `/home/ajmalrasi/tgs/study` on
`192.168.3.210` after testing. Remote and local SHA-256 hashes match for every file.
Existing files were backed up in `study-backup-before-site-scope-20261022`.
