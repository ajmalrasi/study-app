# Raspberry Pi review UI: audit and improvement plan

Date: 20 October 2026

## Scope and evidence

Reviewed the live Raspberry Pi interface at `http://192.168.3.20:8765/`: library, a processed lesson's study notes, personal screenshot notes, transcript with inline screenshots, and flashcard question/answer states. Also inspected `server/static/index.html`, the relevant server endpoints, and extension lesson metadata extraction.

The live library showed nine saved lessons and 40 due cards. These are observations at review time, not permanent metrics. No notes were edited, cards graded, AI jobs started, or application code changed. The browser viewport was approximately 763 px wide in dark mode; large desktop, phone, light mode, and assistive technology testing remain to be done. Search and Ask recommendations below come from source inspection rather than a live AI query.

## Assessment

The application has substantial learning functionality, but its presentation is still an early utility interface. The largest problems are information hierarchy, orientation, and continuity. A palette change alone would leave those problems intact.

Keep the existing timestamp links, personal-note/AI-output distinction, transcript annotations, editable drawings, source citations, and simple recall-first flashcards. Build a clearer learning workflow around them.

## Findings and priorities

| Priority | Current evidence | User consequence | Recommended change |
|---|---|---|---|
| P1 | Home is one flat list under a course heading; module is small metadata. | Finding related lessons requires scanning the whole list. | Course overview with collapsible modules, saved-lesson counts, and filters. On desktop use persistent navigation; on phones use a drawer. |
| P1 | The live course heading reads “DeepLearning.AI - Learning Platform.” | The source platform is more prominent than the actual course. | Display the actual course title, e.g. Agentic AI, with the platform secondary. Correct metadata extraction and provide a safe title correction for existing courses. |
| P1 | Forty due cards appear only as a small header badge. Unprocessed lessons have no explicit next action in the list. | The user must decide what needs attention unaided. | A small Today area: review due cards, reopen the last viewed lesson, and lessons ready to generate study material. |
| P1 | Lesson title lives in a small header; there is no course/module breadcrumb, adjacent lesson navigation, or section outline. | Readers lose context and must return home to change lessons. | Lesson heading with breadcrumb, previous/next navigation using a valid ordering, persistent tabs, and a section outline on wide screens. |
| P1 | Study notes and questions form one long bordered container. | Important concepts and practice tasks have almost the same visual weight. | Separate summary, timestamped concepts, additional points, and practice questions through spacing, type hierarchy, and restrained section treatment. Show one practice question at a time or collapse inactive questions. |
| P1 | Process, lesson review, export, and original-video actions are below all lesson content. | Useful actions require scrolling through the full document. | Move the main action to the lesson heading; place export and regeneration in a secondary menu. Label the first-time action “Generate study notes.” |
| P1 | Flashcards have a counter and two grades, but no session setup, next interval, undo, or save feedback. | Forty cards can feel like an open-ended task; mistakes are difficult to recover from. | Offer a short session, show remaining cards and next review interval, give visible save feedback, and add undo when the backend can restore the previous schedule. Preserve the simple two-grade scheme initially. |
| P2 | Personal screenshots fill nearly the whole content column; clicking an image launches the drawing editor. | Inspecting a screenshot unexpectedly becomes an editing task. | Image preview/lightbox with zoom, plus a separate “Edit drawing” action. Add captions and nearby transcript context. Keep an optional gallery for image-heavy lessons. |
| P2 | Transcript is dense paragraphs with embedded images; no local find, outline, or reading-position persistence. | Returning to a particular passage takes repeated scrolling. | Find within this lesson, stable passage anchors, match highlighting, position restoration, and optional side-by-side notes on desktop. Keep a single-column mobile view. |
| P2 | Search and Ask share an input but perform different tasks. Search results link to a lesson tab, not a specific in-app passage. | It is unclear whether to enter keywords or a question; context is lost after opening a result. | Explicit Search/Ask mode labels, scope by course, type filters, and links to the matching passage with a temporary highlight. Keep video timestamps as a separate action. |
| P2 | Ask displays cited answers, but source entries mainly identify lessons and times. | Verifying a claim requires leaving the answer. | Expand citations into readable excerpts in a side panel or mobile sheet; visibly state the active scope and handle insufficient evidence clearly. |
| P2 | Status is mostly “processed,” an inline job message, or a page-level error. | The user cannot easily distinguish missing transcript, queued generation, service failure, and an empty collection. | Consistent loading, ready, empty, error, and retry states; AI availability near AI actions. Use factual labels rather than “mastered” or “complete.” |
| P2 | Small inline actions, placeholder-only inputs, clickable heading navigation, and visual-only tab selection exist in source. | Keyboard, touch, and screen-reader use need more deliberate support. | Real home link, labelled inputs, semantic tabs, visible focus, announced loading/save status, descriptive image alternatives, and comfortable mobile controls. |

P1 is the first redesign; P2 follows or joins it when inexpensive. These priorities are design judgment based on the audit, not measured user-test results.

## Recommended information architecture

- **Today:** a compact action area for due reviews, the last viewed lesson, and unprocessed material. Avoid filling it with decorative metrics.
- **Library:** courses → modules → saved lessons, with recent and needs-processing views. Make clear this is the saved library, not the full course syllabus.
- **Lesson:** Study notes, My notes, Transcript, and Flashcards remain recognizable views within a consistent lesson layout.
- **Review:** a focused session with course/lesson context, reveal, rating, save state, and completion feedback.
- **Search / Ask:** globally reachable, with an explicit course scope and easy return to a lesson or passage.

Desktop: left navigation, central reading column, optional contextual panel. Keep prose constrained to a comfortable width instead of stretching paragraphs across the display. The existing 780 px maximum can remain a useful reading constraint; it should not constrain the entire desktop application.

Phone: a single content column, compact heading, accessible course drawer, reachable primary actions, and no mandatory split panes. Persistent navigation must not hide focused controls or consume too much reading space.

## Visual direction

A quiet personal study notebook: clear course identity, warm neutral light surfaces, readable dark surfaces, stronger heading hierarchy, consistent spacing, subtle separators, and one restrained accent. Use consistent icons with text for key actions. A red due-count badge currently makes an ordinary study queue look like an alert; a neutral count with an inviting review action would be calmer.

Keep personal notes and generated material visibly labelled. Rename “What I might have missed” to something less authoritative, such as “Additional points from the transcript,” and retain timestamps. AI feedback should be easy to verify and should not imply it measures mastery.

Provide explicit light/dark/system and reading-size preferences. The current system-based dark mode is a useful foundation.

## Research and implications

1. [Nielsen Norman Group: usability heuristics](https://www.nngroup.com/articles/ten-usability-heuristics/) emphasizes visible status, recognition, consistency, and user control. Implication here: persistent location, clear generation states, recoverable review actions, and named next steps.
2. [Readwise Reader: organizing content](https://docs.readwise.io/reader/docs/organizing-content) documents filtered views and library organization. Implication here: courses, modules, and simple saved views should replace repeated scanning of one chronological list.
3. [Readwise Reader: highlights, tags, and notes](https://docs.readwise.io/reader/docs/faqs/highlights-tags-notes) describes annotations in the margin, notebook sidebars, and keyboard navigation. Implication here: bring notes and source passages together in context, with a responsive single-column alternative.
4. [RemNote: getting started with spaced repetition](https://help.remnote.com/en/articles/6022755-getting-started-with-spaced-repetition) documents global and document-specific due-card practice and recall-before-rating. Implication here: keep both review scopes and the current reveal-first behavior; improve session clarity before changing the scheduler.
5. [W3C: target size](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html) specifies a 24 by 24 CSS px minimum with exceptions. Aim for roughly 44 px for major phone controls as a design choice, while auditing inline timestamp spacing separately.
6. [W3C: visible focus](https://www.w3.org/WAI/WCAG22/Understanding/focus-visible.html) requires a visible indicator for keyboard focus. Add intentional focus styling and verify the actual keyboard journey.

These are reference patterns and standards, not proof that copying another product will work. Validate the proposed layout against the user's actual lessons and study habits.

## What existing data supports

**Mostly UI work:** visual hierarchy, module grouping, processed/transcript filters, action placement, image previews, theme preferences, section outlines, transcript find, better loading/error presentation, and a clearer Search/Ask distinction. Existing lesson data includes notes, cards, generation metadata, answers, and latest processing job.

**Small API/data additions:** accurate due counts without downloading card contents, per-course due counts, last-opened lesson and reading position, stored session limits, review undo, and specific source-passage anchors. Backend review writes also need protection against duplicate submissions and clear failure handling.

**New tracking or source data:** review history and retention trends, learning completion, watch progress, and canonical syllabus order. `updated` means content changed, not last studied; `processed` means AI material exists, not learned. Do not invent percentages, mastery scores, course completion, study-time estimates, or “next syllabus lesson” from these fields. A browser-local last-viewed record is a viable first version of resume, with its device-specific limitation stated.

## Interaction issues to address alongside redesign

- Processing polls call the full lesson renderer every three seconds. If inputs are present, this can discard focus or unsaved text. Update only the job/status region and preserve drafts.
- Asynchronous page requests are not cancelled or checked against the current route. A slow response can overwrite a newer screen. Guard rendering by the active route/request.
- Tab changes reset scroll to the top. Preserve position per lesson/view and provide a deliberate “back to top” control.
- The due badge fetches at most 200 cards; review fetches at most 50. Counts and completion text must distinguish the session from the complete due queue.
- The review's two grade buttons remain active while saving, and failures have no local feedback. Disable repeated submissions, preserve the current card on failure, and offer retry.
- Search results need in-app passage anchors. Current timestamp links open the original course video, a useful separate behavior to retain.

These are code-derived risks and limitations; they were not all reproduced against production data during this audit.

## Delivery sequence and acceptance

1. Design the library and one representative lesson using existing real content. Agree the navigation, typography, reading density, and phone layout through a reviewable prototype.
2. Implement the library/lesson foundation and robust loading, navigation, and draft preservation. Retain existing API behavior where practical.
3. Improve review sessions, source inspection, search, and resume behavior with the smallest necessary API additions.
4. Evaluate deeper analytics or scheduling changes only after the core study experience is comfortable.

Validate at phone, tablet, and wide desktop sizes, in light and dark modes, with keyboard navigation and 200% zoom. Check long titles, image-heavy lessons, unprocessed lessons, no transcript, no due cards, slow AI, network failure, and more than 50 due cards. Success means the user can find a module, resume reading, inspect a screenshot, verify a cited passage, and complete a short review without losing context or work. Do not claim speed or learning gains until tested.
