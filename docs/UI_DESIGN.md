# Study Notes interface design

Status: implemented · 21 October 2026 (design proposed 20 October 2026)

Companion: [UI audit](UI_REVIEW.md). The interactive design shown in the conversation is the visual reference. This document specifies the intended production behavior; prototype responses, capture diagrams, and review ratings are illustrative.

## Design direction

A quiet study workspace with the character of a personal notebook. Warm paper surfaces, forest-green actions, editorial lesson headings, and clear reading typography. Dark mode uses charcoal-green surfaces with a lighter sage accent. Decoration should stay subordinate to course material.

The app should answer three questions immediately: Where am I? What can I study next? Where did this idea come from?

## Layout and navigation

Desktop, at 960 px and above:

- A 194–216 px left navigation rail: Overview, Library, Review with exact due count, Ask your notes, then courses and modules.
- A compact top bar with location, global search, and appearance preference. The “Design preview” badge belongs only to the prototype.
- A flexible central area, with a maximum reading width of about 68 characters. Use the rest of the display for navigation and context rather than stretching paragraphs.
- Lesson context sits to the right when there is room. The section outline and source passage remain nearby while reading, with sticky positioning below the top bar where it is safe.

Tablet, 640–959 px:

- Reduce or collapse the navigation rail as space requires.
- Put source details below the reading area or in a dismissible panel. Do not squeeze the reading column to preserve a sidebar.
- Stack overview feature panels when they no longer fit comfortably.

Phone, below 640 px:

- One content column, 18–20 px side padding, compact top bar, and course drawer.
- Home, Library, Review, and Ask appear in a bottom navigation row. In production it can remain reachable, provided it respects the safe area and does not obscure content, keyboard focus, or an open keyboard.
- Lesson tabs fit across the available width; touch targets stay at least 44 px high. Source excerpts expand in place or in a labelled sheet.
- A mobile preview-size control is part of the design review surface, not a production app setting.

## Screen: Overview

Heading: “Pick up where you left off.”

Two primary areas:

1. **Continue reading:** the actual last-opened lesson, course/module, view, and a clear resume action. Restore its reading position. On a first visit replace this with the most recently updated lesson labelled “Recently updated”; do not infer a reading history from content timestamps.
2. **Review:** accurate due count, a short-session suggestion, and a review button. On zero due cards show “All caught up” and a secondary browse action. Never treat a failed count request as zero cards.

Below these, show the saved course library. The preview uses Agentic AI, nine saved lessons, and the due-count snapshot from the audit. Production values are live. “Saved lessons” makes clear that this is not the complete course syllabus.

## Screen: Library

Course title is primary; DeepLearning.AI is secondary. Group saved lessons by module using collapsible headings. Keep the last opened module expanded per device.

Lesson rows show title, number of personal notes, card count where present, transcript availability, and a short material status:

- Study notes ready
- Ready to generate
- Generating study notes
- Generation failed · Retry
- No transcript saved

Provide All lessons and Needs study notes filters. In the production search, results can match lesson titles, notes, and transcript passages. Each result identifies course, module, content type, and a readable excerpt. A passage result opens the correct lesson view, scrolls to the matching passage, and highlights it; opening the original video is a separate link.

Retain current recent-update ordering within module groups initially. Do not add “next syllabus lesson” until reliable ordering exists. Correct course-title extraction for newly captured lessons and provide a deliberate title correction for existing courses.

## Screen: Lesson

The heading includes course/module location, full lesson title, transcript state, note count, and flashcard count. Open video and the relevant primary action sit below the title. The primary action is Generate study notes when absent, and Review lesson when available. Export Markdown and Regenerate study notes live in a secondary action menu.

Keep the four existing views:

### Study notes

- Label generated material clearly.
- Give the summary a readable opening treatment, with no invented learning scores.
- Separate key concepts with spacing, meaningful headings, and compact timestamp actions.
- Label the current “What I might have missed” content “Additional points from the transcript.” Keep Add to my notes and saved confirmation.
- Present practice questions as individual answerable tasks; a user can navigate between the real generated questions. Persist drafts per lesson and question while switching views.
- Show feedback only after submission, with source timestamps and a retry path. Do not claim a correctness or mastery score.
- The prototype's “idea in one sentence” is an editorial sample. Initial implementation should use the existing Summary content in that treatment; a new one-sentence takeaway needs an explicit generation-format change.

Timestamp behavior: select the relevant source passage in the adjacent context area. Offer Read in transcript and Open video at this time. On phone, reveal the passage nearby instead of silently updating an offscreen sidebar. Context should preserve a clear route back to reading.

### My notes

Display screenshots and drawings as compact visual captures with timestamp, typed caption, and nearby transcript context. Open the original capture in a zoomable preview. Edit drawing explicitly opens the existing Excalidraw editor.

The prototype's diagrams illustrate the layout; production uses the original screenshot/drawing files. Do not replace captures with generated diagrams or fabricated captions. When there is no caption, show neutral metadata and transcript context.

### Transcript

Offer labelled find-within-lesson input, count of matches, readable timestamped paragraphs, and inline personal notes. Restore each view's reading position. Passage links must use stable identifiers so search and citations can land precisely.

The prototype uses shortened paraphrases to demonstrate layout. Production displays the saved transcript verbatim.

### Flashcards

Use inspectable question/answer rows, with answers initially collapsed. Include a clear Start review action scoped to the lesson's due cards. The prototype illustrates a selection; production uses actual stored cards and schedules.

## Screen: Review

The entry screen shows due count, scope, and selectable short-session size. Offer 5 or 10 cards, bounded by the number actually due, plus a way to review the remaining due queue. All-lessons and lesson-specific review must stay distinct.

During the session:

- Display current card, session progress, and source lesson.
- Show the question first. Space reveals the answer when focus is not in an input.
- After reveal, show two grades: Review again and Got it. Keys 1 and 2 are optional equivalents.
- Show the actual next interval for each grade. The preview's “Tomorrow” is an example, not a universal schedule.
- On submission disable grading until the write completes. On failure retain the card, display the failure, and offer retry.
- Undo restores the previous server schedule through a dedicated undo mechanism. The prototype only demonstrates local reversal.
- End session returns to review setup. Session completion reports this session's counts, and separately identifies whether more due cards remain.

The two-grade Leitner schedule stays unchanged. No scheduler replacement, streak system, or retention dashboard is part of this design.

## Screen: Ask your notes

Keep a clear separation between finding words and asking for an explanation. The Ask view includes a labelled question field, explicit course scope, a primary Ask action, and a small number of relevant example questions.

Answers show numbered source references. Selecting one expands the exact excerpt, its lesson and timestamp, and links to the transcript and original video. Keep citations inspectable without leaving the answer. Provide clear states for no relevant material, unavailable AI, and retry.

The prototype contains three fixed sample responses. Production continues to use the existing retrieval and AI endpoints; it must never present these fixed responses as actual generated answers.

## Visual system

| Token | Paper | Evening |
|---|---|---|
| Background | `#FAF9F6` | `#171B19` |
| Reading surfaces | `#FFFEFA` | `#202622` |
| Navigation surface | `#EEEFE9` | `#1C211E` |
| Main text | `#263B32` | `#E2E9DF` |
| Secondary text | `#5E6D64` | `#A3B2A6` |
| Accent | `#30664E` | `#A6D6B5` |
| Accent foreground | `#FFFEFA` | `#14291D` |
| Soft highlight | `#E7EEE3` | `#2B3B2E` |
| Divider | `#DDE2D7` | `#36443A` |

Use system sans-serif for controls and body, with Georgia or a similar local serif for major reading headings. Avoid external font dependencies. Body: 15–16 px, line height 1.65–1.8; metadata: 12–13 px; headings: 28–34 px. The compact preview uses some smaller navigation metadata; production accessibility checks take precedence over literal reproduction.

Spacing: 4, 8, 12, 16, 24, 32 px. Controls: 7–8 px radius. Large surfaces: 10–12 px. Prefer dividers over repeated bordered boxes. Use consistent stroke icons, paired with labels for important actions. Due counts are neutral information, not red alerts.

Appearance preference: System, Paper, Evening. Reading preference: Standard, Comfortable. Preferences are browser-local initially. Measure text and control contrast in both themes during implementation.

## Loading, empty, error, and keyboard states

- Loading: preserve the layout and existing content where appropriate; use restrained placeholders and a labelled status region.
- Empty library: brief extension setup guidance and an explanation of how lessons appear.
- No study notes/cards: explain what generation produces and offer the relevant action.
- AI busy/unavailable: keep notes readable and allow retry. Distinguish a server connection error from an AI error.
- Processing: update a status region without re-rendering inputs or resetting position. Report real steps, not invented percentages or precise completion estimates.
- Navigation: abort stale requests or reject their results when the route changes.
- Accessibility: semantic navigation, real links, labelled inputs, visible focus, keyboard-operated tabs and dialogs, Escape-to-close, focus return, and announced save/error states. No meaning conveyed by colour alone.
- Touch: 44 px major targets, readable input text, and no hover-only actions.

## Implementation boundaries

The redesign targets the server-hosted review interface. Keep FastAPI, SQLite, existing capture/sync behavior, and the drawing editor. Split the existing one-file review UI into maintained HTML, styles, and JavaScript modules as needed; a large client framework is not required to achieve this design.

First implementation: navigation shell, real course labels, library grouping/status filters, lesson layout, transcript search, source context, capture preview, theme/read-size preferences, and resilient state handling.

Supporting API additions: exact count-only due summaries and scope, passage identifiers and excerpts, actual interval previews, protected review writes, and undo. Resume can be device-local initially; clearly distinguish it from synced learning history.

Follow with review-session polish and Ask source inspection. Do not silently bundle watch tracking, mastery analytics, full syllabus discovery, card authoring, or a scheduling migration into the redesign.

## Review checklist

Confirm the library, processed/unprocessed lesson, transcript search, capture preview, review setup/reveal/grade/error/undo/completion, and Ask/source flow. Check 360, 390, 768, 1024, and 1440 px widths, 200% zoom, both themes, long titles, keyboard-only operation, no data, slow AI, and network failure. Use actual lesson content for final visual QA.


## Implemented validation

The review UI is now maintained in `server/static/ui/app.js` and `app.css`, with a local SVG icon sprite, SVG/PNG favicons, and touch icons. No external fonts or icon services are required.

Validation: 11 isolated API tests cover existing-database migration, exact scoped due counts, real interval previews, concurrent retry protection, stale rating protection, undo and conflicts, regeneration, course rename persistence, search/passage identifiers, source excerpts, and assets. Browser checks cover actual saved lessons and captures, draft restoration, source navigation, server-backed grade/undo in a separate database copy, keyboard tabs, and widths of 360, 390, 768, 1024, and 1440 px without horizontal overflow.

Reading preferences and resume positions are browser-local. Review undo is available within the current session; the backend prevents an undo from overwriting a later rating. Existing Markdown export, drawing editing, and extension capture APIs remain available.
