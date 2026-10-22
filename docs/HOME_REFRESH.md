# Home refresh · 22 October 2026

The existing overview felt static and administrative. The updated entrance uses a warm illustrated welcome, a time-of-day greeting, prominent reading/review choices, and a colorful shelf of actual courses. Detailed module and lesson browsing remains in Library. Reading surfaces remain restrained.

Research consulted before implementation:

- Nielsen Norman Group, [The Aesthetic-Usability Effect](https://www.nngroup.com/articles/aesthetic-usability-effect/): visual appeal can improve perceived usability; appearance must accompany working interactions.
- Self-Determination Theory, [Education](https://selfdeterminationtheory.org/topics/application-education/): autonomy and competence inform motivation-supportive learning environments.

Design interpretation: make returning feel welcoming, reduce the effort of choosing a next action, and offer meaningful choices. These sources do not establish that this specific redesign will improve study adherence. Avoid invented progress, mastery, or streaks. Course counts represent saved material, not syllabus completion.

Implementation uses local SVG markup and CSS with no new dependencies. Existing Paper/Evening/System appearance works with the new surfaces. Motion is restrained and disabled when reduced motion is requested. Asset version strings were updated.

Validation: JavaScript syntax check and all 11 existing API tests passed. Live phone-sized browser inspection verified the Evening home layout, real course/card counts, and course-shelf navigation into the correct filtered library. Desktop and other viewport sizes have responsive rules but were not visually checked in this pass.

Applied only the three interface files to the existing Raspberry Pi server. Previous interface files saved on that server under apps/study_notes/ui-backups/20261022-welcome/.

## Follow-up analysis using 21st.dev MCP

Catalog research completed 22 October 2026. Theme and template search worked; component searches and get_inspiration returned catalog-search errors. No component code was retrieved or installed.

Relevant reference: [Green Notes by massimobuonfrate01](https://21st.dev/community/themes/green-notes-1783614187319). Retrieved its actual theme CSS: parchment background #e9e4d8, cream card #F4EFE4, emerald #1d9f76, amber #efa02a, and charcoal Evening surfaces. This supports a warmer, more varied palette. Do not copy tokens wholesale: primary foreground #8d875e against primary #1d9f76 calculates to approximately 1.09:1 contrast.

Dashboard template search returned mostly CRM and SaaS marketing layouts, including Folio and Qronos. Their catalog descriptions mention feature groups, tabs and responsive layouts; these were metadata results, not visually reviewed templates. Education search returned portfolios rather than strong learning-product matches. They provide limited evidence for this app's direction.

### Recommended next design pass

1. Put the real resume action within the first phone screen. The first live mobile screenshot shows the welcome illustration occupying most of the initial viewport and the lesson action below it. Compress the welcome on phone and integrate the lesson action with it.
2. Give each course a stable visual identity based on its slug rather than list position. Use a consistent subject illustration or motif, accent color and clear title. Current numbered geometric covers feel generic and change identity if the order changes.
3. Surface one genuine saved idea or personal capture near the resume action when available. Keep quotations exact and linked to their source; use a neutral fallback if no suitable content exists. Personal material can make this space feel owned and recognizable.
4. Treat review as an approachable choice: lead with a five-card option when cards are due, keep the exact total secondary, and preserve accurate failed/zero count states. A direct short-session action would need to connect to the actual review flow rather than merely change the label.
5. Make responses to action satisfying: clear selected/revealed/saved states and a factual session-completion message. Restrained transitions should respect reduced motion. Continuous background animation would compete with reading.
6. Carry the visual identity into Library and lesson navigation while keeping long reading surfaces calm. The original pass concentrates almost all personality on Home.

Success checks: the main study action is visible at 390px width without scrolling; course identity remains stable when reordered; all key text stays readable in both themes; review entry and resume both work with real data; user feedback after repeated visits establishes whether returning feels more inviting. These are design hypotheses, not measured motivation outcomes.

## Desktop redesign implemented

User clarified the primary display is 21:9 ultrawide and approved extending the illustrated direction across the workspace. The mobile-first recommendations above are superseded by this desktop priority.

Added a peach/amber/lavender/sky palette in Paper and Evening appearances, subject illustrations for course covers, stable course colors derived from course slug, illustrated Library and Ask headings, lavender review treatment, amber lesson summaries, and a blue-accented source panel. The welcome and study actions share a row above 1600px; reading remains narrow with room for a 360px context panel. Local SVG/CSS implementation, informed by 21st theme research, adds no runtime dependencies or paid component retrieval.

Validation: all 11 API tests and JavaScript syntax check passed. Live Chrome inspection at 2520×1080 (21:9) covered Home in Paper and Evening, filtered Library navigation, a real processed lesson, Review setup, and Ask. Lesson reading measured 718px and source context 360px with no horizontal overflow. No browser console errors were reported. Preview screenshots are in docs/previews/. Original System preference and default browser viewport were restored after checks.

Deployed the three interface files to the existing server, retaining the preceding version in apps/study_notes/ui-backups/20261022-color/ on the Pi. Notes, transcripts, schedules and server logic were not modified.
