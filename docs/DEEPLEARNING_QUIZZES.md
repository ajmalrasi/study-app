# DeepLearning.AI module quizzes — 29 October 2026

Study Notes 0.5.0 adds DeepLearning.AI to the existing verified curriculum and
caption-import flow. The quiz engine, evidence snapshots and saved attempts are shared
with Udemy.

## Source contract

The Agentic AI lesson page includes structured course and video metadata in its
server-rendered `__NEXT_DATA__` payload. The adapter fetches HTML through the course
tab's signed-in browser session and returns only curriculum or caption fields. It never
returns session data, credentials, user progress, or unrelated query results.

The course's `lessons` dictionary supplies stable lesson IDs and content types. Every
entry must appear exactly once in `listing` module contents before sync succeeds. Modules
use their platform labels, such as `module-1`, as identifiers; names can change without
creating new local sections. Unknown outline structures, missing records, duplicates,
wrong-course responses and login redirects fail explicitly. There is no guessed lesson
count or relevance search involved in membership.

Observed Agentic AI inventory: **five modules, 50 items, 31 videos**. The remaining items
are readings, quizzes, and labs. `tests/fixtures/dlai_agentic_outline.json` contains only
sanitized public curriculum fields from that shape.

The caption adapter fetches the exact requested lesson page, verifies its lesson and
video IDs, and prefers English subtitle tracks. It supports direct WebVTT and subtitle
playlists, including a legacy subtitle-map fallback. Missing caption tracks and inaccessible
video metadata are distinct outcomes. It never downloads video files or navigates the
active lesson, and it does not mark lessons completed. Caption hosts are restricted to
DeepLearning.AI's learning/video services.

## Storage and compatibility

`course_curricula.platform` distinguishes `udemy` and `deeplearning`. Existing records
migrate with `udemy` as the default, and older Udemy clients remain compatible. DeepLearning.AI
item URLs must match the exact allowed origin, course slug and stable lesson ID.

Existing saved lessons are matched by provider, course, and lesson ID when their exact
URL differs due to renamed titles or encoding. Their IDs, transcripts, personal notes,
and previous answers remain intact. The existing import lease and coverage workflow
handles either platform.

## Verification

- The live course outline was compared with the visible syllabus: five modules and
  50 items, with 31 videos identified by metadata.
- The actual adapter retrieved valid timestamped WebVTT for Welcome! and Creating a tool
  without video playback, using public server-rendered lesson metadata.
- The Node suite verifies complete inventory checks, unknown structure rejection,
  lesson/video identity, English selection, session isolation, access errors, and caption
  host restrictions.
- API regression tests cover the previous schema migration, DeepLearning.AI URL validation,
  source matching across title changes, preserved lesson IDs/transcripts, module resync,
  provider-aware import claims, and missing-source gating. Existing Udemy and quiz tests
  remain part of the suite.

After copying the updated extension, reload Study Notes on each computer. Open the course,
click **Sync course sections**, then select modules under **Quizzes** and fetch missing
transcripts. Keep the signed-in course tab open until caption imports finish.

## Deployment and initial sync

The updated server is deployed on the existing Pi service. Its previous files and a
consistent database backup are at
`/home/ajmalrasi/apps/study_notes-before-dlai-modules-20261029-191804`.

Agentic AI's five modules were synced through the curriculum API, and the same adapter
imported its 16 missing video transcripts using public lesson-page metadata. All 31 video
transcripts are now available (8, 5, 5, 7, and 6 across the five modules). The 15 previous
lesson IDs were retained. The deployed browser UI confirmed **31 of 31** transcripts
available with **Selected modules** and **Entire course** options.

Extension 0.5.0 was copied to `/home/ajmalrasi/tgs/study` on `192.168.3.210`, with all
15 files verified against local SHA-256 hashes. Its prior files are backed up at
`/home/ajmalrasi/tgs/study-extension-before-dlai-20261029-191901`.
The user will reload the extension there. The new extension's buttons and signed-in
background imports have not been exercised live after that reload; their adapters,
server APIs, and module UI are covered by the checks above.

Final checks: 31 Python API tests and all five Node extension suites passed.
