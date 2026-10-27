# Section quizzes — 27 October 2026

The server and review UI are deployed to the existing Raspberry Pi service.
The local Chrome extension files are updated to 0.4.0; the user deferred reloading
the extension, so live extension sync/import verification remains outstanding.

## Data and behavior

- Udemy curriculum comes from the signed-in browser's subscriber curriculum endpoint.
  All pages must be fetched, counts must match, and IDs must be unique before a
  transaction replaces the current inventory. Chapters supply section identity;
  video lecture IDs match saved lesson URLs. Articles and existing quizzes are separate.
- Sync updates existing lesson grouping without creating hundreds of empty lessons.
  Future captures also prefer the verified curriculum heading over the page's DOM heading.
- Explicit import jobs contain every missing video in the selected sections. The
  extension claims work with an expiring lease and reports each lesson separately.
  It fetches captions without changing the current lecture or playing videos.
  Missing captions and failures stay visible. A new job retries missing transcripts.
- Quiz creation snapshots every available source chunk and the omitted lesson list.
  Missing transcripts require explicit partial-quiz opt-in. Saved lesson selection
  is clearly distinguished from a verified complete course/section inventory.
- Generation extracts topics from every chunk, saving each completed extraction.
  A deterministic plan alternates lessons before allocating additional questions.
  Keyword retrieval searches only the quiz's snapshot and always includes the
  planned topic's source. A second model pass checks support and MCQ consistency.
  Invalid references, duplicate normalized question text, invalid options and
  unsupported questions are rejected. This is an automated check, not a guarantee
  of factual correctness; the UI retains evidence for inspection.
- A quiz is ready only when the requested count is reached, every included lesson
  is represented, and there are no omitted video transcripts. Otherwise it is
  explicitly partial, or an error if no questions could be produced. Processing
  every transcript does not mean a finite quiz tests every detail.
- Generation resumes after restart and can be paused. Background quiz generation
  and existing lesson generation share a lock; interactive feedback remains available.
- Quiz attempts have separate server-saved drafts, optimistic edit versions,
  checked feedback, scores and completion state. Retakes retain earlier attempts.
  Written feedback uses the saved expected answer and evidence; MCQs grade directly.
  Questions do not expose expected answers before checking. Local draft recovery
  and explicit conflict resolution protect unsynced edits from other tabs.
- Updating/deleting an original lesson does not alter saved quiz evidence. The
  source view flags changed/deleted originals. Existing SQLite backup jobs include
  all new tables. Original notes and flashcard scheduling are unchanged.

## Validation

- 27 Python API tests passed, including exhaustive ten-lesson processing, complete
  curriculum validation, missing-source opt-in, immutable evidence, long transcript
  chunking, idempotent creation, lease ownership, stale edits, in-flight grading
  conflicts, question validation, independent retakes and missed-question practice.
- Four Node suites passed: `udemy_curriculum.mjs`, `page_adapters.mjs`,
  `site_scope.mjs`, and `timestamp_links.mjs`.
- The configured Jetson model generated and verified a two-question multiple-choice
  quiz against an isolated transcript fixture. No fixture was written to production.
- Chrome browser checks against an isolated server covered selecting a saved quiz,
  starting an attempt, navigating with draft text, feedback, reload/resume, completing
  the attempt, and viewing result/retake controls.
- The actual deployed quiz workspace and APIs were inspected through an SSH local
  connection. Direct browser access to the LAN IP returned address-unreachable;
  the server's LAN endpoints and the forwarded browser session both responded.
- Live Udemy inspection confirmed 458 curriculum rows, 33 sections, stable chapter
  and lecture IDs, and caption metadata for a previously missing IAM video.

## Remaining user steps

Reload Study Notes on this Mac, open the enrolled Udemy course, use **Sync course
sections**, then select sections and **Fetch missing transcripts** on Quizzes.
Keep that Udemy tab open while the import runs. Caption import and curriculum sync
are covered by isolated tests but have not been exercised live with the reloaded extension.

After the user supplied SSH authentication, extension 0.4.0 was copied to
`/home/ajmalrasi/tgs/study` on `192.168.3.210`. Every copied file's SHA-256 hash
matches the local extension. That PC's previous files are backed up at
`/home/ajmalrasi/tgs/study-extension-before-quiz-update-20261027-172005`.
The user will reload the extension there; live sync/import verification is still pending.

Pre-deployment source/static files and a consistent SQLite backup are saved on the
Pi at `/home/ajmalrasi/apps/study_notes-before-quizzes-20261027-170001`.
