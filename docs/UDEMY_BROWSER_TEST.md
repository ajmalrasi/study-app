# Udemy compatibility browser test — 21 October 2026

Tested the unpacked extension at `/Users/ajmalrasi/study_notes/extension`
in the signed-in Chrome browser on this Mac, against the shared notes server
at `192.168.3.20:8765`. This is not a browser test on `192.168.3.210`.

## Failures reproduced and fixed locally

- Udemy captions are rendered by Shaka without native `<track>` elements.
  The extension now requests captions for the current enrolled lecture through
  the signed-in Udemy session. English captions are preferred.
- Udemy replaces URL hashes and restores playback positions during initialization.
  Timestamp links are captured at document start and checked after the player initializes.

## Live browser results

| Check | Udemy | DeepLearning.AI |
| --- | --- | --- |
| Video and lesson detection | Passed | Passed |
| Transcript displayed and saved on server | Passed | Passed |
| Seeking from transcript timestamp | Passed | Passed |
| Quote saved | Passed | Passed |
| Bookmark saved | Passed | Passed |
| Typed note saved | Passed | Passed |
| Alt+N pauses, saves, resumes | Passed | Passed |
| Video screenshot | Passed; frame inspected in drawing editor | Passed; frame inspected in drawing editor |
| Drawing edit and Save acknowledgement | Passed | Passed |
| Switching to another video and loading its distinct transcript | Passed | Passed |
| Saved timestamp link | Exactly 45s, paused | Exactly 23s, paused |
| Notes remain available after extension reload | Passed | Passed |

Udemy: course `aws-certified-solutions-architect-associate-saa-c03`, introduction
lecture `13528014` and Creating an AWS Account `13541138`.
DeepLearning.AI: Agentic AI, Welcome (`pu5xbv`) and What is agentic AI (`nae3i1`).
An intermediate Udemy article correctly disabled video tools. Udemy automatically
marked that article complete; its original incomplete state was restored.
Test notes include the text “Extension browser test”; test quotes, bookmarks,
screenshots and annotated frames were also saved during verification.

## Automated checks

Run `node tests/page_adapters.mjs` and `node tests/timestamp_links.mjs`.
They cover serialized page functions, current-lecture caption selection, caption
errors, existing DeepLearning.AI subtitle paths, early hash capture, delayed video
readiness, late resume restoration, and preserving site navigation hashes.

## Limits

The remote PC's browser is not exposed to the available browser controls.
After these tests, the user requested deployment to `192.168.3.210`. The tested
`page.js`, `content.js`, `background.js`, and `manifest.json` were copied to
`/home/ajmalrasi/tgs/study`; all four remote SHA-256 hashes match the local files.
Previous files are backed up at
`/home/ajmalrasi/tgs/study-backup-before-tested-udemy-20261021`.
Chrome on that PC still needs an extension reload and live verification there.
LLM processing, search/ask, offline queue recovery, blank sketches, and other
courses/languages were not exercised in this browser session.
