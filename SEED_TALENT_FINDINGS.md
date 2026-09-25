# Seed Talent Helper — Technical Findings

## Scope

This document records findings from `seed_helper_v9.user.js` and the captured session in `seed_sniff_1789482918984.json`. Confirmed observations are separated from hypotheses and untested behavior.

## Confirmed architecture

The course uses three relevant browser contexts:

1. `app.seedtalent.com` hosts the Seed Talent course page and sends course progress updates.
2. The CloudFront `scorm-launcher.html` frame hosts the SCORM runtime (`API_1484_11`).
3. A nested course-player frame renders the lesson UI and writes player state through the SCORM API.

The observed course update route is:

```text
PUT https://api.seedtalent.com/api/v1/courses/{utrId}/update
```

Its request body contains `cmiData`, a serialized JSON string with values including `cmi.location`, `cmi.suspend_data`, `progress`, and `cmi.session_time`. Course-level progress and the internal player state are related but distinct.

## Course-level versus internal completion

Course-level LMS state uses SCORM fields such as:

- `cmi.completion_status`
- `cmi.success_status`
- `cmi.progress_measure`
- `cmi.score.*`

Setting these fields can make Seed Talent report the course as complete. It does not necessarily update the lesson checkmarks rendered inside the embedded course player.

Internal lesson and block checkmarks are reconstructed from `cmi.suspend_data` when the player opens. This explains why the existing NUKE action can complete the Seed Talent course record while internal sections remain unchecked after reopening the course.

## Suspend-data format

The captured suspend-data values have this outer form:

```json
{"v":2,"d":[123,34,112],"cpv":"course-specific-value"}
```

Confirmed meanings:

- `v` is the serialization format version observed in this course.
- `d` is an LZW-compressed stream of character codes and dictionary references.
- Values below 256 are literal character codes.
- Values beginning at 256 are LZW dictionary references.
- `cpv` remained constant across all captured snapshots. Its purpose has not been established.

A decoder and encoder were tested against all 12 captured suspend-data snapshots. Decoding and re-encoding every snapshot reproduced the original `d` array exactly.

The decompressed payload is JSON shaped like:

```json
{
  "progress": {
    "lessons": {
      "1": {
        "c": 1,
        "p": 100,
        "i": {
          "0": { "c": 1, "i": { "0": { "c": 1 } } }
        }
      }
    },
    "p": 10
  }
}
```

Observed field behavior:

- `progress.p` is overall player progress.
- `progress.lessons` is keyed by numeric lesson index, not the lesson ID shown in `cmi.location`.
- A lesson's `p` increased as its blocks were completed.
- A completed lesson had `c: 1` and `p: 100`.
- `i` contains nested item/block state keyed by numeric index.
- Completed observed items had `c: 1`.
- Lessons not yet visited were absent from the map.

Captured progression examples included a lesson changing from `p:25` through intermediate values to `c:1,p:100`, while its nested items acquired `c:1`. Overall progress changed from 10 to 20 and then 30 after completed lessons.

## What remains unproven

The capture does not establish:

- The complete lesson manifest or the number and shape of all unvisited lessons.
- Whether extra or fabricated lesson indices are ignored safely.
- Whether `cpv` is validated or has semantic meaning beyond identifying a course-player version.
- Whether every assessment stores its result only in the same nested item map.
- Whether setting item `c:1` represents a passed quiz, rather than merely a visited/completed interaction block.
- Whether assessment answers, scores, and attempts are also stored in other SCORM fields such as `cmi.interactions.*`.
- Whether direct suspend-data modification survives all player validation and later writes.

For these reasons, ordinary block completion findings must not be treated as proof that fabricated state represents valid quiz results.

## OpenRouter quiz workflow

The current script can send visible question content and nearby course text to OpenRouter. It supports these detected interaction types:

- Single-select questions using radio-style options.
- Multi-select questions using checkbox-style options.
- Fill-in-the-blank text inputs.
- Matching questions with draggable left and right columns.

For single- and multi-select questions, the script asks OpenRouter for option numbers, updates the visible controls, emits input/change events where needed, and clicks Submit when `AUTO_SUBMIT_QUIZ` is enabled.

For fill-in-the-blank questions, it asks for a short answer, writes through the native input value setter, emits input/change events, and submits.

For matching questions, it asks for `L#,R#` pairs, performs drag interactions, and submits.

The script also records attempts, detects Correct/Incorrect feedback, remembers known-correct answers, avoids repeating known failed combinations, and retries some failed quizzes.

This is a real player interaction workflow: it submits answers through the course UI and allows the player to grade them. OpenRouter can produce wrong answers, and success depends on the question being detectable and enough relevant text being present.

### Assessment capture findings

Three later captures distinguished mid-course knowledge checks from the final assessment.

Mid-course question captures contained no `cmi.interactions.*` calls. Their answers changed `cmi.suspend_data` and were persisted through the normal course-update route. This indicates that their detailed interaction state is private player state rather than separately reported SCORM assessment data.

The final-assessment capture contained four sequential SCORM interaction records. For each submitted answer, the player:

1. Read `cmi.interactions._count`.
2. Added the next numbered interaction.
3. Set its `id`, `type`, `learner_response`, `result`, `correct_responses.0.pattern`, `description`, `weighting`, `latency`, objective ID, and timestamp.
4. Called `Commit`.
5. Persisted the accumulated state through the generic Seed Talent course-update route.

All four captured interactions used SCORM type `choice`. One recorded response was incorrect and three were correct. The incorrect record contained both the learner's selected response and a different correct-response pattern. This proves that the player had already graded the response before it wrote the SCORM record.

No separate assessment-grading HTTP endpoint appeared in these captures. The generic Seed Talent endpoint persisted the course/SCORM state but did not grade individual answers.

A subsequent last-question capture established the final transition:

1. The player recorded the final choice interaction as `correct` and committed it.
2. It set `cmi.success_status` to `passed`.
3. It set `cmi.completion_status` to `completed`.
4. It committed again and sent the normal course-update PUT.
5. Seed Talent changed the server record from `In-Progress` at 90 percent to `Completed` at 100 percent with `passed:true`.

No `cmi.score.*` call appeared during this transition. Seed Talent's completed response still contained `score:0`, proving that this course uses pass/completion status rather than a reported numeric score for completion. The player repeated the passed/completed writes later in the same sequence, after another suspend-data update.

The new player launch read `cmi.interactions._count` as zero even though earlier captured sessions had committed interaction records. In this observed launch, prior detailed interactions were not restored into the live SCORM interaction collection; the player's resumable assessment state was instead carried in suspend data. This observation should not be generalized to every course package.

Consequences for automation:

- Writing `cmi.interactions.*` directly would report a result; it would not ask the course player to grade an answer.
- A genuine unattended attempt must still provide an answer to the course player's grading logic.
- The current reliable method is to let the player render the question and automate its controls.
- A no-DOM method would require locating and invoking the player's internal assessment model and grading functions, or legitimately extracting the question definitions from course assets. Neither mechanism has been identified yet.

### Full-session HAR findings

A later HTTP Toolkit capture, `seed_har.har`, contains 261 entries spanning login/dashboard load, course launch, all course activity, final completion, and the immediate course-review request. The course itself ran from its start request to the completed update in approximately 192 seconds. The HAR includes sensitive login/session material and must be treated as a credential-bearing artifact.

This capture used a different Rise package than the earlier captures, under CloudFront course path `C4284/1752868326592`. It confirms the same three-context architecture and the same generic persistence route. After course launch, the only Seed Talent course write was:

```text
PUT /api/v1/courses/{utrId}/update
```

There were 84 successful update PUTs. No HTTP endpoint submitted a question for grading. The other observed traffic was course launch/data, an empty Storyline story-map response, static course assets, dashboard APIs, LiveChat, and browser/Google background services.

The package loads `scormcontent/locales/en.js` before lesson interaction. That file contains a Base64-encoded UTF-8 JSON document. Decoding it produced a 92,843-byte object with top-level `course`, `labelSet`, `fonts`, and `media` keys. This is package serialization, not encryption or a server grading exchange.

The decoded course object establishes:

- Eight lesson entries exist; the first is the cover and seven are progress-bearing lessons.
- Six ordinary content lessons complete in approximately 14-percent increments, followed by the final quiz lesson.
- The package contains two mid-course multiple-choice knowledge checks.
- The final quiz contains ten multiple-choice questions.
- Question text, answer choices, and correctness metadata are present in the initial locale payload before gated questions are displayed.
- The final quiz requires 80 percent, allows unlimited retries (`retryCount: -1`), reveals all answers, and does not shuffle choices or randomize question order in this package.
- `course.navigationMode` is `free`, while the theme sets `navigationRestricted: true`. The observed gate is therefore player/UI state, not evidence that Seed Talent withholds question data over HTTP.
- The ordinary content contains nine Continue blocks, one tabs interaction, one flashcard stack, and the two knowledge checks. No video block exists in this package.

The final SCORM update accumulated ten `choice` interactions and reported all ten as `correct`, then included `cmi.success_status: passed` and `cmi.completion_status: completed`. Seed Talent returned `Completed`, progress 100, and `passed:true`, while its numeric score remained zero.

The final carried suspend data was one player-state write behind the SCORM result: internal overall progress was still 86, the quiz lesson showed 90 percent/score 90, and its last item had not yet acquired the same completion fields as the preceding nine items. The same request nevertheless carried the tenth correct SCORM interaction and completed/passed statuses. This proves that player suspend state, SCORM interaction state, and Seed Talent course status can be temporarily inconsistent during the final transition. A later player write would be needed to determine whether the internal quiz lesson subsequently reaches 100 percent.

The Rise bootstrap exposes a `reportAnswer(data)` adapter that receives an already computed `data.isCorrect` and `data.correctResponse`, then records that result through SCORM. Combined with correctness metadata in the locale payload and the absence of grading traffic, this confirms local player grading for this package.

Two large Rise bundle responses were represented by size and metadata in the HAR but did not include response text: approximately 3.5 MB for `dc1846f6.js` and 903 KB for `be50c3a3.js`. A follow-up read of those exact public CloudFront assets identified the relevant internal architecture:

- The Rise Redux store is exported by its loaded Webpack module.
- Quiz action types include `QUIZ_LESSON_SELECT_QUIZ_ANSWER`, `QUIZ_LESSON_TOGGLE_ANSWER_SELECTION`, `QUIZ_LESSON_SET_ANSWER_TEXT`, `QUIZ_LESSON_SET_ANSWER_MATCHES`, `QUIZ_LESSON_SUBMIT_ANSWER`, `QUIZ_LESSON_ADVANCE_STEP`, and `QUIZ_LESSON_RESTART`.
- The quiz component computes correctness locally from the selected response and the item data before it calls the submit action.
- The submit reducer receives an already computed `isCorrect`, marks the item complete, recomputes score and percent complete, and determines whether the passing score was met.
- The component then calls `reportAnswer`, which produces the SCORM interaction.

Calling the submit action directly with a caller-supplied `isCorrect` would bypass the grading comparison rather than invoke it. A no-render internal approach would therefore need to initialize the real store, apply a real selection action, invoke the same correctness function, and follow the same report/submit sequence. That path is technically plausible but tightly coupled to minified module IDs and the specific Rise build; it has not been runtime-tested. It is unnecessary and less reliable than a one-button DOM-driven runner.

The `/api/v1/course-story/story-map` response had no nodes, final leaf, or visited content for this Rise course. Seed Talent's separate Storyline fallback logic therefore did not drive this course's progress. That fallback is package-type-specific and must not be generalized to Rise.

### Capabilities established by the HAR

For this package, a one-button unattended runner can legitimately:

1. Decode the locale payload immediately after course load and inventory all lessons and supported interaction types before they become visible.
2. Prepare model answers ahead of navigation instead of waiting for each question to appear before calling OpenRouter.
3. Advance the seven tracked lessons, activate Continue/tabs/flashcard controls, and answer both knowledge checks through the player.
4. Render each final question, apply the prepared answer, submit it to the player's local grader, observe feedback, and retry when permitted.
5. Wait for the player's tenth SCORM interaction and passed/completed commit, then verify the Seed Talent response before reporting success.
6. From the dashboard, identify an outstanding course, invoke its normal start route, and hand control to the same runner. Automatically selecting the next course is technically possible but was not implemented or verified in this capture.

Preloading question definitions removes the information disadvantage created by UI gating; it does not create a separate grading API. The reliable path still renders each quiz component and invokes the player's normal controls. A hidden or background tab may work, but MutationObserver/state-driven waits are preferable to fixed timers because browsers throttle inactive tabs.

These findings apply to this Rise package. Storyline, media-heavy, hotspot, ordering, simulation, or externally embedded packages may have different data and grading paths.

### Changes required for the requested one-button mode

The current v9.08 runner is close to the desired interaction model but should not be treated as a reliable background state machine yet:

- START already broadcasts a running state to all frames and prioritizes quiz solving, feedback advancement, next-question navigation, retry, forward navigation, interactive blocks, media, and locked-Continue scrolling.
- It uses a one-second `setInterval` plus many fixed `setTimeout` delays. Hidden-tab throttling can make this slow or cause races. A MutationObserver-driven state machine with explicit transition acknowledgements would be more reliable.
- It still physically scrolls the course frame to expose blocks. This requires no user input and can run in a background tab, but it is not a true no-scroll internal-state implementation.
- Its media fallback automatically sends the SCORM completion payload whenever navigation is blocked and media is present. That behavior conflicts with genuine player-driven progress and can recreate the course-level/internal-state mismatch. It should be removed from START behavior.
- Single-select parsing still defaults to option 1 when model output cannot be parsed. It should retry or pause instead.
- The HAR contains no OpenRouter request. `GM_xmlhttpRequest` may have bypassed the HTTP Toolkit capture, or the run may have used cached/manual answers; this HAR alone does not prove that OpenRouter was called.
- Version 9.06 removes the exposed OpenRouter key from source and reads a replacement from local userscript storage. The previously exposed key must still be revoked.

A robust completion signal should require both the player's final SCORM interaction/status commit and the successful Seed Talent update response. It should not infer success only from visible navigation or a local click.

The explicit NUKE button and the START runner are separate concerns. The manual NUKE button can remain available with its confirmation dialog. Only the automatic invocation of the NUKE payload from START's blocked-media branch should be removed or disabled, because that invocation can unexpectedly produce course-level completion without matching internal player state.

### Coverage expansion strategy

Broader interaction support requires engine- and interaction-specific adapters rather than one universal click loop:

- **Storyline:** detect the Storyline player and use its accessible HTML controls where available. Use Seed Talent's observed story-map/final-leaf fallback only when the response contains real nodes. Canvas-heavy or custom Storyline packages need package-specific inspection of slide variables, triggers, and SCORM interaction writes.
- **Hotspots:** prefer semantic DOM/SVG hotspot elements and their labels. For image-only hotspots, capture the question image, ask a vision-capable model for the target, convert its normalized location into the verified image bounding rectangle, click it, and confirm player feedback. Never guess screen coordinates without locating the actual image element.
- **Ordering:** extract item text, ask for an ordered list, map the answer back by stable text or item IDs, perform sequential drag operations, and verify DOM/ARIA order before submission. Keyboard-accessible move controls are preferable to coordinate dragging when present.
- **Simulations:** model them as an observe/action/verify loop. DOM-based simulations can use labeled controls; canvas or remote-desktop simulations require screenshots, vision inference, bounded clicks/typing, and explicit state checks after every action. These are the least generalizable and may require per-course adapters.
- **External embeds:** detect the iframe provider. Same-origin embeds can use normal DOM handlers. Cross-origin embeds require a userscript match for the provider, a documented player API or postMessage contract, or browser-level automation. Unknown providers must be inspected before adding access.

For all adapters, unsupported or ambiguous states should pause and report the blocker rather than guess. Required evidence for a new adapter is a screenshot, interaction type/provider, DOM or accessibility snapshot when available, and a SNIFF/HAR capture covering one normal attempt and its feedback.

Version 9.02 introduced this detector. After five seconds with no normal action available, it checks for an unknown quiz, ordering/sorting interaction, hotspot, simulation/canvas surface, course-contained cross-origin embed, or Storyline surface. A first detection is deduplicated, reported to the top-frame panel with bounded non-sensitive evidence, and automatically pauses START. It does not modify either the explicit NUKE button or the existing media-triggered NUKE branch.

Version 9.03 fixes a separate terminal-navigation failure discovered during the first live attempt. Earlier forward-button matching treated `EXIT`, `EXIT COURSE`, `FINISH`, and `COMPLETE` as ordinary navigation and could send a newly started course directly to its Bye page. These labels are now excluded even when the element also has a generic Next/Continue class. START also detects a definite Bye/exit page, pauses, and instructs the user to reload.

A subsequent NUKE-specific capture for Rise package `C3317/1751382253591` found `API_1484_11` in the CloudFront launcher but contained none of NUKE's completion, success, score, objective, exit, or Commit calls. Only the player's normal location and suspend-data writes occurred, and Seed Talent remained In-Progress at zero percent. The failure was API discovery, not server rejection: the injected payload began traversal at cross-origin `window.top`, while the API existed on the launcher's current `window`.

Version 9.04 changes the shared payload to search the current frame first and retry for up to approximately ten seconds while the runtime loads. Isolated tests confirmed SCORM 2004 completion/status/score/objective/Commit writes with an inaccessible cross-origin top, delayed API appearance, bounded no-API behavior, and SCORM 1.2 fallback. The explicit NUKE button, terminal guard, and adapter detector remain otherwise unchanged.

Version 9.05 adds the stall-repair pipeline. After five seconds without a supported action, it first looks for semantic required-response messages and the previously supported unhandled categories. If no category matches and a likely course-content frame remains idle for 15 seconds, it pauses with an `unknown-idle` incident. Top-level Seed Talent wrappers, the CloudFront launcher, and SCORM driver utility frames are excluded so they cannot pause a progressing nested player.

Each incident records only a bounded, sanitized schema: player engine/frame path, blocker messages, visible control metadata and boolean state, locked navigation, canvas dimensions, external-embed origin/path, recent status/debug actions, runtime error summaries, and up to 30 network method/status/origin-path records. It excludes input values, full HTML/body text, query strings, request/response bodies, headers, cookies, stacks, profile data, and credentials; key/email/Bearer patterns are redacted again when the top frame accepts the cross-frame report. The panel exposes a user-initiated `INCIDENT` download button rather than downloading automatically. Manual NUKE and the existing media NUKE branch are unchanged.

The first incident bundle validated this pipeline on Rise package `C1140/1753831948910`. The player displayed three mandatory cards and the message `Complete the content above before moving on.` The incident exposed six current-generation `flashcard-side-flip__btn` controls: front and back buttons for each card. START only recognized the older `flashcard__turn` selector, so it never flipped any card and repeatedly scrolled toward the locked Continue control.

Version 9.07 adds a front-side-only selector (`*-front-flip-btn`) for this Rise flashcard grid. Each card is clicked once; after flipping, Rise makes its front side inert and records the item's `onStep` completion. Element IDs provide per-card retry identities even when buttons have no visible label. Locked-Continue scrolling is also capped at ten successful movements and only counts when `scrollTop` changes, allowing future misses to reach the 5/15-second incident pipeline instead of scrolling indefinitely.

A second incident on Rise package `C1669/1753832013613` showed a stall at Step 3 of a six-step `interactive-fullscreen`/`process` block. Current Rise renders the forward arrow as `button.carousel-controls-next`, while START only recognized the obsolete `.process-control--next`. Version 9.08 adds only that next-button selector; the last slide reports `aria-disabled="true"` and is skipped by the existing disabled filtering, and the per-control 15-attempt retry budget is unchanged.

Version 9.08 did not resolve the stall because the next control is claimed earlier by Priority C (forward navigation): its `aria-label="Go to next slide"` matches `[aria-label*="Next" i]`, so it was clicked exactly once under a `navId` of the block's `data-block-id` and then deduped by `clickedNavs` on every later tick. `hasUnlockedFwd` therefore stayed true, which both starved the C1 interactive handler of the control and suppressed the unknown-idle incident path. Live-DOM verification against the standalone package confirmed a second defect: `simulateHumanClick` fires a synthetic `click`, `el.click()`, and the React-props fallback in one invocation, advancing the carousel two slides per attempt and skipping intermediate `onStep` recordings — enough to leave the block permanently incomplete even when clicks land.

Version 9.09 makes two surgical changes: (1) `carousel-controls-next`, `-prev`, and `-item-btn` are excluded from forward-nav candidacy so C1 owns intra-block steppers; (2) all sequential "next" steppers (`carousel-controls-next` and the legacy `process-control--next`, `carousel-slider__control--next`, `block-carousel__control--next`) fire a single `el.click()` per attempt, verified to advance exactly one slide so every step's `onStep` records. The intro card's START button remains handled by forward navigation (`START` is a known forward label).

The same SNIFF confirmed START recovered on its own through the rest of the course: a gated checklist block in "Conclusion" was satisfied by continued locked-Continue scrolling, and the runner advanced lessons to 93% (final graded quiz, question 3/8) before the next genuine stall.

A third incident (`unknown-idle` on the Rise quiz card) exposed a different defect class: Priority A adds the detected question id to `attempted` before dispatching to a solver, but every terminal AI-failure path — missing OpenRouter key, all models exhausted, network error, timeout, and solver-side throws — set `isSolving = false` without releasing the id. The detector then skipped the question every tick (`already attempted. Skipping...`) until unknown-idle fired. Radios stayed unchecked because no answer was ever applied.

Version 9.10 routes all such failures through `releaseFailedQuestion()`: the in-flight question id is tracked in `activeSolveQId`, released from `attempted` on failure, and retried through Priority A with a 6-second backoff, bounded to 3 failures per question (`quizSolveFails`) before the stall pipeline reports it. Solver-callback rejections are caught centrally in `callOpenRouter`. The no-key path additionally releases the question and posts `SEED_PAUSE_REQ` so the user can enter a key and RESUME without losing the question. A fourth strand — pausing during the "Reading question..." dispatch delay dropped the solver while `attempted` stayed set — now releases the id too. `resetMemory()` and the Take-Again retry clear the failure map.

A fourth incident was the quiz's own **passed results screen** (score 80 ≥ pass 80): Priority D correctly refused the TAKE AGAIN buttons, but the page offers no forward navigation — only EXIT COURSE (terminal-guarded) and retake controls — so the runner idled into unknown-idle. The white screen is the Rise results card, which renders nearly empty in this theme. Version 9.11 records the pass when Priority D proves it (`passedQuizMsg`) and adds Priority E after forward navigation: on a passed results screen with no unlocked forward control it reads `cmi.completion_status`/`success_status`/`score` from the same-origin launcher/driver SCORM API (2004 and 1.2, cross-origin-safe), reports `✓ Quiz passed … course done` once, and pauses via `SEED_QUIZ_PASSED`. Retake remains correctly ignored; the wrong answers (80%) still cleared the threshold.

### Captured SCORM interactions — ground-truth answers

SNIFF analysis of `seed_sniff_1789486330213` and `actual_quiz_seed_sniff_1789485878170` proved the driver writes the **correct** answer on every submit: `cmi.interactions.N.correct_responses.0.pattern` (e.g. `urn:scormdriver:Lower-cost`), alongside `learner_response`, `result`, and `description` (the full question text). On any Take Again retry the correct answer is already recorded — no AI needed. Patterns are text-based (`urn:scormdriver:` prefix, hyphens for spaces, `[,]` separator, `[.]` for matching pairs), so they survive option reshuffling.

A fifth incident on a different course (`C0102`) confirmed the "selected several answers on a choose-one" bug: `detectActiveQuiz`'s `isMulti` fallback used `className.includes('multiple')`, which matches Rise's `quiz-multiple-choice-*` — its **single**-select class — whenever the option input wasn't a descendant of the wrapper (sibling inputs). Then `applyNums`'s native `checked` setter bypassed radio-group deselection, leaving several radios checked.

A second defect in that incident: the unknown-idle detector fired while an AI retry was in flight (`Retrying AI (1/3)`), because the in-flight call kept `isSolving` true but produced no actions — `stuckSince` accumulated and paused mid-solve.

Version 9.12: (1) `isMulti` now scans real input types across all wrappers then the container — radios ⇒ single, checkboxes ⇒ multi — before any className fallback, and `applyNums` hard-caps single-select to one answer. (2) `findScormApi`/`scormGet` extract the same-origin launcher/driver API (2004 `GetValue` + 1.2 `LMSGetValue`); `findPriorInteraction` matches the question by normalized description (tolerates `True/False:` vs `True or False:` prefixes); `scormAnswerNums`/`scormAnswerText`/`scormMatchingPairs` translate the recorded `correct_responses` pattern and run it through the existing apply path before the AI is ever called. (3) `isSolving` resets `stuckSince` so a slow AI retry no longer triggers the stall detector. The AI fallback chain was also populated: `MODELS` now lists nemotron-3-super → nemotron-3-ultra → `openrouter/free` (OpenRouter's free-models router), and network-error/timeout paths fall through to the next model instead of stranding the question. OpenRouter free-tier limits: 50 req/day under $10 lifetime purchased credits, 1000 req/day at ≥$10; 20 req/min either way; failed requests count.

A sixth incident (`unknown-idle` on a Video.js lesson) exposed a video-path regression: the standalone `playBtns` loop ran *before* the `<video>` element path and returned every tick, so when `.vjs-big-play-button` was present the script clicked the overlay 3× and gave up — the muted `m.play()` + scrub-to-end logic never ran. The overlay clicks cannot work anyway: synthetic clicks carry no user activation, so Video.js's `play()` is rejected by autoplay policy. The broad `[aria-label*="Play" i]` selector additionally matched "Playback Rate" controls sharing the same block id. Version 9.13 runs the `<video>` element path first (it already dismisses the overlay via its ancestor walk, sets `muted`, plays, and scrubs to `duration-5` at 16× so `ended` reaches the Rise runtime), and the play-button loop now only handles blocks containing no media element (true iframe/embeds).

A follow-up SNIFF (`seed_sniff_1789672683613`) revealed the video path also **auto-injected the full SCORM completion payload** (`completion_status=completed`, `success_status=passed`, `progress=1`, `score=100`, all objectives, `exit=normal` + Commit) on every tick while media was present — 843 SetValue / 110 Commit calls in one capture — effectively an automatic NUKE whenever a video appeared, before playback was even attempted. This violated the START=genuine / NUKE=explicit split and falsified the whole-SCO score. Version 9.14 removes the injection from the media path entirely (NUKE retains the payload via its explicit `SEED_NUKE` handler), sets `playbackRate=16` unconditionally so a video still fast-plays when `duration` hasn't loaded, and logs video state (`paused`, `currentTime`/`duration`) to the debug journal for incident diagnosis. The 45s+ incident latency on this page traced to per-attempt 7s `nextActionTime` windows resetting `stuckSince` — expected behavior, not a detector bug.

Retesting v9.14 showed the video "played then randomly stopped" on each attempt and froze after attempt 3. Two root causes: (1) the early "already finished" marker wrote `watchedMedia` under the index key `'media_'+i` while the skip check used the block-derived `mediaId` — so an ended video was never marked done, and each retry's `m.play()` on an ended Video.js element **restarted it from zero**; attempt 3 exhausted the retry budget mid-restart = the visible freeze. (2) The scrub+ended poll was a one-shot `setTimeout` — it could not recover from buffer stalls at 16× or Video.js re-pausing, and for ≤10s videos it seeked to `0` (a restart). Version 9.15 uses `mediaId` consistently and replaces the one-shot logic with a per-video watchdog (500ms ticks, ~45s cap): once `duration` resolves it seeks to `d-5`, re-plays on pause, nudges `currentTime` forward on stall, and marks watched + dispatches `ended` on finish. Note: SNIFF cannot observe playback — media elements bypass fetch/XHR — so diagnosis relied on the journal and course-side API responses (which also confirmed the earlier auto-nuke had already recorded the course `Completed` in 13s).

A second flashcard variant then stalled: `blocks-flashcard--column` grids render `li.flashcard` cards whose flip buttons carry **no `id`** — the v9.07 selector `[id$="-front-flip-btn"]` matched nothing, so START scrolled toward the locked Continue indefinitely. Live package inspection (course `C0319`, "Partners for Freedom") showed the distinguishing markup: unflipped cards lack `li.flashcard--flipped`, and the actionable control is `.flashcard-side--front .flashcard-side-flip__btn` (back-side buttons share the class — parent scope is required). Verified end-to-end on the live package: flipping all three fronts cleared the locked Continue. Version 9.16 adds `li.flashcard:not(.flashcard--flipped) .flashcard-side--front .flashcard-side-flip__btn` — self-deduping via the `:not(.flashcard--flipped)` guard rather than element identity, since these buttons have no ids.

### Rise video anti-skip + flashcard-slider stepper (v9.17)

Two more findings from the C0319 package ("Last Prisoner Project", Release lesson — `cmi.location` in SNIFF identified it):

1. **The video player reverts programmatic seeks and clamps playbackRate.** Live probe: `currentTime = d-5` snapped back to 0; ~70s at `playbackRate=16` advanced only ~148s (≈2×). The watchdog's re-seek loop was therefore fighting the player — the user-visible "still messing with it after advancing." The watchdog also kept running on detached elements after SPA navigation and could stack parallel instances per retry. v9.17: detects a reverted seek (`currentTime` falls >2s below target) and stops seeking permanently for that element (`noSeek`); clears on `!m.isConnected`; guards with `m.__seedWd` so the medias loop waits on a live watchdog instead of spawning retries; widened finish tolerance to `duration-1`; stall give-up at ~30s of no progress, hard cap ~6min. Videos on anti-skip players now simply play through at the clamped rate.
2. **`block-flashcards-slider` is a sequential stepper** (`button.block-flashcards-slider__arrow--next/--prev`, `aria-disabled` at bounds, localized "Next/Previous flashcard" labels; `button.process-counter__btn` step dots with `aria-current`). Its "Next" aria-label would be claimed and deduped by forward-nav — the same dead-code trap as v9.08's carousel. v9.17 excludes `block-flashcards-slider__arrow` and `process-counter__btn` from forward-nav, adds the next-arrow and step counters to C1 as single-`click()` sequential steppers, and extends the active-skip to `aria-current="true"` (boolean form used by counter buttons).

### Forward-nav dedupe dead-lock (v9.18)

The v9.17 stall on the Release lesson generalized the v9.08 bug class: `hasUnlockedFwd` was set `true` for **any** enabled forward candidate *before* the `clickedNavs` dedupe check, and `clickedNavs` deduped permanently. So a control claimed by forward-nav — clicked once but never navigated (React `onClick` not reached, SPA re-render swapping the node, or a stepper arrow mis-claimed via `[aria-label*="Next" i]`) — held `hasUnlockedFwd` open forever: "Forward path open — waiting for transition..." → C1 never runs, the stall detector never fires, and **no incident can ever be generated**. The user sees enabled controls while the runner is silently dead.

Three gaps closed in v9.18:

1. **Time-windowed dedupe.** `clickedNavs` stays a Set for the quiz-feedback path; a new `fwdClickLog` Map records `{n, at}` per `navId`. A click in flight gets an 8s transition grace; after that the same control is re-clicked (self-heals clicks that never landed and mis-claimed steppers — worst case ~8s/step).
2. **Retry ceiling releases the flag.** After 4 clicks on the same `navId` without a transition, the element is skipped *before* `hasUnlockedFwd` is set — C1, interactives, scrolling and eventually the incident detector regain control instead of waiting forever.
3. **Exclusion gap closed.** `process-control--next`, `carousel-slider__control--next` and `block-carousel__control--next` were C1-owned steppers that forward-nav could still claim (they were never in the exclusion list); all three added.

Note: `navId` for elements without `data-block-id` embeds `docY`, so scroll drift still regenerates ids — the retry cap primarily bounds block-id'd claims, which is where the observed dead-locks occurred. Also documented: SNIFF's `suspend_data` writes during the stall confirmed course-side progress recording was healthy; the dead-lock was purely DOM-side.

### Checkbox-list double-toggle + pacing pass (v9.19)

A stall on a different course (Birchmount Gift Card, UTR 2811259 — "(Read and select each box to move on)") exposed the same double-fire defect on `label.block-list__option`: `simulateHumanClick` dispatches a `click` event **and** calls `el.click()` — on a `<label>` each triggers activation behavior on the inner checkbox, so the box toggles twice per attempt (net unchecked). The checked-skip guard then never fires; 15 retries exhaust into the locked-scroll loop. v9.19 clicks the inner `input` once (single native toggle; falls back to one `el.click()` when no input is present).

*Correction (v9.20):* live package inspection later showed this course's checkbox block is the legacy `role=checkbox` hitarea variant with no `input`/`label` at all — the observed stall was an unhandled adapter, while the double-toggle fix remains correct for true input lists.

Same version trims the deliberate human-pacing delays roughly in half (jitter preserved): forward-nav click 800–1300→350–650ms + window 2500→1500ms; interactive click 600–1000→250–500ms + window 1500→900ms; quiz feedback-advance 800–1400→400–700ms + 2500→1500ms; next-question 600–1300→350–700ms + 2000→1200ms; take-again retry 1000→500ms + 3500→2000ms; embed play-button 800→400ms + 4000→2000ms; pre-solve "reading" pause 1200–2400→500–1000ms + window 1500→800ms. Untouched: the 7s video attempt window and watchdog (playback is genuinely time-bound on anti-skip players) and AI retry backoff (rate-limit semantics). Remaining perceived slowness on video lessons is the ~2× clamped real-time playback, not delay code.

### Legacy role=checkbox list variant + in-place section reveals (v9.20)

Live inspection of the Birchmount Gift Card lesson (package `C0367`, lesson `eT-_U7OTGvOioVy4eUPpKerf3RpOUPt9` — recovered from the sniffer's frame URL, `scorm-launcher.html?courseUrl=...`) resolved the "froze after flipping cards" report and corrected the v9.19 diagnosis of the earlier checkbox stall:

1. **Rise `.continue-btn` does not navigate — it reveals the next section in place.** Clicking it rendered 9→13 `data-block-id`s with the same `#/lessons/` hash, and the player auto-scrolled its inner `.page-wrap` scroller (`window.scrollY`/`document.body.scrollHeight` never move — the lesson scrolls inside a wrapper div). The button is then consumed and re-rendered as "Continued" text.
2. **The real checkbox block was `block-list--checkboxes block-list--legacy`, not `block-list__option`.** It contains **zero `input`/`label` elements**: each item is `div.block-list__checkbox__hitarea[role="checkbox"][aria-checked]` — a styled hit-area div over `i.icon-checkmark-valid`. The earlier stall was therefore an *unhandled adapter* (selector never matched), not the double-toggle bug — though that bug is real for true `<input>` lists and the v9.19 fix stands. Verified live: one `el.click()` per hitarea flips `aria-checked` to `true`; all six checked → hint removed → `.continue-btn` enabled.
3. **Why it looked frozen without scrolling:** `.continue-hint` (locked divider) is not in `fwdSelectors`, so Priority F's locked-scroll has no target; with no matching interactive the runner idles until the 15s incident. The user dumped inside that window.

v9.20: adds `div.block-list__checkbox__hitarea[role="checkbox"]` to C1, skips `aria-checked="true"`, single-clicks it (the synthetic sequence would double-toggle it the same as a label), and gives each hitarea a per-index `intId` since they share block id + no text.

### Legacy blocks-accordion variant (v9.21)

Same course, next stall — "Tips for Successful Selling" (`hgjZzS4Qg_JPqtjrub9n3ZZT2QDG6dMs`): a `blocks-accordion` (`--legacy`) renders each item as `section.blocks-accordion__item--closed > button.blocks-accordion__header[aria-expanded]` — a third class family distinct from both prior accordion selectors (`accordion__title-text`). Verified live: one `el.click()` per header flips `aria-expanded` to `true`; all three open → divider unlocks.

v9.21 adds `button.blocks-accordion__header` to C1 (the existing `aria-expanded === 'true'` skip covers opened items) and generalizes the single-click rule: **any C1 element bearing `aria-expanded` gets exactly one `el.click()`** — the synthetic sequence would dispatch a click *and* call `el.click()`, toggling it twice (open→closed). This is the third instance of the double-fire bug class (labels, role=checkbox hitareas, aria-expanded toggles).

Also documented from this stall: the 15s unknown-idle incident is real but only counts *pure* idle — action windows (`nextActionTime`) reset `stuckSince`, and the report path is `SEED_UNKNOWN_IDLE` → pause + "Download INCIDENT" status, so a dump taken inside the window shows no incident yet.

### Flashcard stack carousel — div vs li cards (v9.22)

New course (Ozone Secret Agent Vape, package `C0443`, UTR 2813139): `blocks-flashcard--stack` is a **combined stepper+flip block** — `block-flashcards-slider__arrow--next` advances a slick carousel of `div.flashcard` cards, and each card must also be flipped (`flashcard-side-flip__btn` ×8 = 4 cards × front/back). The v9.17 slider arrow handled the stepping, but the v9.16 flip selector required `li.flashcard` — this variant renders `div.flashcard` inside `div.block-flashcards-slider__slide`, so the script stepped through all four cards without ever flipping and the divider never unlocked. Verified live: flip(visible slide)→next interleave satisfies the gate (the stack also exposes adjacent slide edges, so several front flips are clickable before the first next).

v9.22 generalizes the flip selector to `.flashcard:not(.flashcard--flipped) .flashcard-side--front .flashcard-side-flip__btn` (tag-agnostic — covers both `li.flashcard` grids and `div.flashcard` stacks/slides). Off-viewport slides are excluded by the existing horizontal-bounds `isVisible` check, so only the active slide's front flip is offered each tick — producing the required flip→arrow→flip sequence naturally.

### Quiz false-pass + retry-loop defects (v9.23) — CORRECTS the entry below

SNIFF `1789749565446` (Ozone C0443 quiz) showed attempt 1 submitting 4 `cmi.interactions` (2 correct, 2 incorrect — "2 grams" vs correct "0.5", and an over-selected multi-select) → 50% FAIL. The earlier entry read this as a healthy retry; SNIFF `1789752054902` (41 min later, same UTR 2813139) proved that wrong: **no interactions 4-7 ever appeared, `cmi.score.raw` stayed 50, `cmi.exit` stayed `suspend`, `progress` stayed 67, and no `cmi.completion_status`/`cmi.success_status` was ever sent** — yet `cmi.location` had moved to the next lesson and the panel had printed both "Retrying failed quiz..." and "✓ Quiz passed". The script declared a pass the course never recorded and abandoned the quiz mid-failure.

Two defects found and fixed:

1. **Score regex skipped a digit-less score into the pass mark.** Verified live on the C0443 package: the results screen can render `Your score undefined%` when the score doesn't interpolate, alongside `PASSING 80%`. The old `/(?:YOUR SCORE|…)[^\d]*(\d+)/` ran `[^\d]*` straight through `undefined%` and captured the pass mark's `80` → `80 >= 80` → false `passedQuizMsg` → Priority E reported "passed" → forward-nav left the lesson. Reproduced exactly (`ys=80, ps=80 → PASS`) on the real fail screen. Fixed by bounding the gap to `[^\d%]{0,30}` — digits must appear before the next `%` — for the `ys`, `ps`, and both `100%` checks (`cText.includes('100%')` had the same flaw whenever a course's pass mark is 100%).

2. **Driver-authoritative veto added.** `cmi.success_status`/`cmi.score.scaled` now gate the DOM pass checks: `failed` (or `scaled*100` below the page's pass mark) forces RETRY even if DOM text looks like a pass; `passed` short-circuits to a genuine pass. In the real session `scaled` was `0.5` vs pass `80` — veto → Take Again → bounded retry, never a false abandon. Fail-open design: no API → DOM-only behavior as before.

3. **Percent-encoded `correct_responses` defeated answer reuse.** scormdriver percent-encodes multi-word option identifiers — the captured Q3 pattern is literally `urn:scormdriver:High%20THC%20Potency[,]urn:scormdriver:Distillate%20Oil%20Only[,]…`. `scormNorm` strips non-alphanumerics, so `High%20THC%20Potency` normalized to `high20thc20potency` ≠ option text `highthcpotency` → `scormAnswerNums` would return null even with the API reachable. `scormPatternParts` now `decodeURIComponent`s each segment, making multi-word SCORM-verified answers deterministic. (v9.24 note: the reuse path was in fact never reached at all — see below — but this fix is still required for it to work now that it can run.)

Regression check: the detection logic was replayed against the real fail-screen text (`undefined%`, real `50%`, real pass, `75/75 Congratulations`, stale-scaled-0.5-but-UI-passed) — all fail variants now resolve RETRY; genuine passes still detect; a stale low `scaled` with a passing UI errs toward one bounded extra retake rather than a false completion.

### findScormApi never found the API — reuse path was dead code (v9.24)

SNIFF `1789754518016` (same C0443 quiz, ~20 interactions across 6 attempts) exposed the deeper bug behind the "infinite retake" loop:

- Retakes WERE submitting: `cmi.interactions` grew 4→24, score improved 50→75 — but plateaued below the 80 pass mark.
- Every attempt: Q1/Q2/Q4 correct, **Q3 identical wrong answer** — the AI selecting 4 options (`High THC Potency, Distillate Oil Only, Full of Terpenes, No Artificial Flavors`); the correct combo (recorded by the SCO's own `SetValue` calls every submit) is 3: `{High THC Potency, Distillate Oil Only, No Artificial Flavors}` — no "Full of Terpenes".
- **Zero script-side `GetValue` calls in the entire sniff.** The only `cmi.interactions._count` reads (24 = 6 attempts × 4 questions) are the SCO's own record-creation pattern. `findPriorInteraction` never executed a single read → `findScormApi()` returned null every time.
- Root cause: `API_1484_11` lives on the **scorm-launcher.html window — the content frame's *grandparent*** (`scormcontent` → `scormdriver/indexAPI.html` → `scorm-launcher`). The driver's own `SCORM2004_ScanParentsForApi` walks the ancestor chain for exactly this reason, but `findScormApi` only probed `parent` (indexAPI — a driver shell whose found API sits in a JS var, not on its window) plus its children (blank/AICCComm frames). v9.24 walks the ancestor chain and each level's child frames, mirroring the driver's discovery.
- User-visible pattern explained: "asks AI on some questions, not others" = the *history cache* (`past.attempts` with a `Correct` result) covering Q1/Q2/Q4 — Q3 was never correct so it re-asked the AI every time and got the same deterministic wrong combo.
- Corollary: the SCORM `correct_responses` reuse path (v9.12) had never actually fired in production — every prior "retry" was the history cache plus AI luck. With the API reachable, `findPriorInteraction` can finally read `correct_responses` (which the SCO writes on every submit — 24 `SetValue` calls in this sniff alone), and the v9.23 `decodeURIComponent` fix makes the `%20`-encoded multi-word patterns match option text.

### correct_responses readback returns "" — course model used instead (v9.25)

SNIFF `1789755962239` confirmed the v9.24 frame-walk fix works — script-side `GetValue` calls finally appear (`_count`, `description`, `success_status`, `score.scaled`, `correct_responses`) — but exposed a platform limitation: **`cmi.interactions.N.correct_responses.0.pattern` returns `""` on every read**. This scormdriver build accepts the SCO's `SetValue` writes (visible in the sniff) but does not serve them back via `GetValue` — `correct_responses` is effectively write-only here, so the driver-reuse path can never supply answers on this platform.

Replacement ground-truth source, verified live on the C0443 package: **`window.courseData`** in the scormcontent frame is a base64-encoded JSON of the entire course model. Every quiz question ships with `answers[]` (id + HTML title), `correct`, `corrects`, and `type`; the quiz block also carries `settings.passingScore` (80) and `shuffleAnswerChoices:false` (stable option indices). Decoded C0443 defs matched the SCO-recorded patterns exactly, including Q3's `corrects = {High THC Potency, Distillate Oil Only, No Artificial Flavors}`.

Data-model subtlety that matters: on `MULTIPLE_CHOICE` questions `corrects` can list *wrong alternates* (Q2's `corrects` = {2, 0.25} while `correct` = 0.5, the SCO-verified answer). The resolver therefore uses `corrects` only for `MULTIPLE_RESPONSE` and `correct` otherwise.

v9.25 adds `courseDataAnswerNums(qId, plainOpts)`: decodes `courseData` once (cached), walks for objects with `answers`+`correct`/`corrects`, fuzzy-matches the normalized question title, maps correct ids → answer titles → option indices. Wired **first** in the solve chain (before history cache, SCORM readback, and AI) — Rise MCQ/MR questions now answer deterministically on attempt 1, with no API key and no wrong-first-attempt cost. Non-Rise frames lack `courseData` → returns [] → existing chain unchanged.

Limitations (documented, unfixed): fill-in-the-blank and matching solvers don't consume `courseData` yet — the defs exist there too (`answers`/`correct` shapes differ by type); the same walk can be extended if needed.

### SCORM-verified quiz retry confirmed in production (no version change) — SUPERSEDED

This entry previously concluded the retry path was working; SNIFF `1789752054902` disproved that (see above). The `cmi.score.*` writes observed were attempt-1's own Commit, not a passing retake — no retake submission ever reached the driver.

### Known solver limitations

- It currently requires the question and controls to be rendered in the DOM.
- Unsupported question types are not handled automatically.
- Image-only, video-dependent, hotspot, ordering, and complex simulations may lack enough text or compatible controls.
- The model response is probabilistic and is not guaranteed correct.
- The current single-select parser falls back to option 1 if it cannot parse an answer, which can create an avoidable incorrect attempt.
- The configured model may be unavailable, rate-limited, or changed by its provider.
- Automatic selection still uses player-side clicks, input events, or drag events; it is automated but not a server-side/background-only assessment API.

### Userscript sandbox cannot see window.courseData (v9.26)

SNIFF `1789756673815` showed v9.25 still calling AI on every C0443 question: `window.courseData` is visible in page-context DevTools/Playwright but **invisible inside the Violentmonkey isolated world**. `quizDefs()` resolved [] → chain fell through to AI exactly as before. v9.26 reads `unsafeWindow.courseData` first, then `window.courseData`, then scrapes the inline `courseData = "..."` assignment out of `document.documentElement.innerHTML` (DOM is shared with the page; charset widened for URL-safe `+`/`/`/`=`/`-`/`_`).

### C1012 "Ozone FX Gummies" stall — view-tracking gate + new selectors (v9.27)

SNIFF `1789757768410` + live reproduction on package `C1012/1712676689937` ("Minor Cannabinoids" lesson, `SF1aSf-AKITJ9vwFaQjtssYfUx56_Dre`) exposed three distinct findings:

- **Checkbox variant**: this package renders `div.block-list__option[role="checkbox"]` (the option div itself carries the role) — not `label.block-list__option`, not `div.block-list__checkbox__hitarea`. Selector generalized to `.block-list [role="checkbox"]`, with per-index retry IDs and single `.click()` for all role-checkbox controls (double-fire toggles them back off). Guard added: a `label.block-list__option` inside an item that also has `[role="checkbox"]` is skipped as decorative.
- **`completeAll` divider = view-tracking gate**: the divider item is `{"type":"completeAll","title":"CONTINUE","completeHint":"..."}` — it unlocks only when **every block above has dwelled in the scroller viewport** (IntersectionObserver "viewed" marks, not just interactives done). Verified live: all checkboxes checked + all accordions open still left the gate locked; a paced top→bottom scroll of the real scroller unlocked it.
- **The real scroller is `.page-wrap`** (`scrollHeight 3491` vs `clientHeight 861`). `.lesson-main`/`document`/`window` scrolls do nothing — every prior "scroll" in the isolated test silently no-opped.
- **Locked state renders only a hint div — no button** (`button.continue-btn` appears *after* unlock). The hint never reached `fwdCandidates`, so old Priority F (which needed a locked button element) never engaged → no scroll → stall → idle.
- v9.27 rewrites Priority F as a **top→bottom view-sweep** of the actual scroller, once per page (`pageSweepArmed`/`pageSweepDone`), whether or not a locked button exists. Lesson pages share one `location.hash`, so forward-nav clicks clear the sweep state to re-arm it for the next page.

- **`window.courseData` absent on this build** — the course model loads via `window.__fetchCourse(locale)` → `locales/{name}.js` JSONP → `deserialize()`. `quizDefs()` now fires `__fetchCourse()` once when no `courseData` raw string exists; the same `walk()` finds defs in either model shape (C1012's 5-question MC quiz resolves all 5 defs). Fetch is async, so it is warmed at script start — first question may still fall through if it lands before resolution.
- **suspend_data v2 is obfuscated**: `{"v":2,"d":[...numbers...],"cpv":"..."}` — `d` is a shifted char-code array (not plain ASCII, not simple ±index). Block-level progress could not be decoded; treated read-only.

### Diagnostics overhaul — journal persistence, state snapshots, answer-source tracking (v9.28)

Purely additive diagnostics (no runner-logic changes):

- **Cross-frame persisted journal**: each frame owns a GM key `seed_journal::<origin+pathname>` holding its last 150 actions (status+debug, noise-filtered — countdowns/sniff-heartbeats/video heartbeats and consecutive dupes excluded). Survives navigation/reloads; keys expire after 7d. `mergedJournal()` merges all frame keys into one timestamped timeline tagged per frame — answers 'what did the script do' at any stall without reconstructing from network side-effects.
- **`buildDiag()` state snapshot**: engine, url, scrollable scrollers (class/heights/scrollTop), interactive inventory (checkbox checked/unchecked, accordion open/closed, videos), continue-btn state, lock-hint presence, course-model reachability (`courseData` global / `__fetchCourse` / resolved def count), sweep state, isSolving. Embedded automatically in every incident; also refreshed to `seed_diag::<frame>` every ~20s while running and on demand.
- **DIAG button**: broadcasts `SEED_DIAG_REQ` (relayed down the frame tree like SNIFF_SET), waits 700ms, downloads `{meta, journal, diags}` — state capture with no sniffer needed.
- **Enriched DUMP**: same bundle plus `events` (the sniff array, capped 2000). Filename stays `seed_sniff_*`; the `events` key keeps old parse tooling working.
- **Answer-source field**: `answerSrc[qid]` set at each solver decision point (courseData/history/scorm/ai) and written into each history attempt as `src` — the LOGS window shows a `[source]` badge per attempt, and dumps answer 'did the deterministic path actually fire' definitively.
- **runId**: START stamps `seed_runid`; included in dump/diag meta so multiple files correlate to one session.
- Panel debug line now shows the last 5 messages (rolling) instead of only the most recent.

### v9.28 DIAG empty + stall root cause — hash-keyed sweep suppression (v9.29)

DIAG `1789762421315` returned `journal:[]`, `diags:{}` despite live activity — **the `@grant` block was missing `GM_listValues`/`GM_deleteValue`**, so every GM-key enumeration silently failed (try/catch swallowed it). Writes worked; reads returned empty. Fixed in `a11f54a`. Lesson: **grant changes require re-saving the script in Violentmonkey** — the header is only re-read on install/update.

DIAG `1789993701744` (post-fix) captured the real stall:

- Content frame alive and running (journal: "Completing interactive block", "Advancing") — injection and SEED_STATE relay confirmed working on the 3-deep frame tree.
- `sweep.armed: 0` while `lockHint: true`, `continueBtn: null`, `checkboxUnchecked: 1`, `accordionClosed: 2` — the Priority F sweep had **never armed** on that page.
- Root cause: `pageSweepDone`/`pageSweepArmed` were keyed on `framePath + location.hash`, but **all four lesson pages share one hash**. Once any page's sweep marked the key done — e.g., a manual scroll landing near the bottom sets `atBottom` immediately — every later page on the hash skipped the sweep permanently. The user's manual scroll mounted the lazy checkbox, the loop clicked it, and the course flowed — until the next divider.
- Secondary diag bug: `buildDiag()` reported the frame-local `state` var, so running content frames showed `state:"stopped"`. It now reports `iframeState` for non-top frames.

v9.29 redesign — no done-set at all:

- Signature = `framePath | hash | scrollHeight | heading` in `sweepArmed`; a page change (new height/heading) or lazy-mount growth produces a new signature and re-arms automatically. Reaching the bottom simply stops stepping — nothing persists to suppress the next page.
- `sweepTopDone` (per hash) limits the scrollTop=0 reset to once per page load, so lazy-mount growth re-arms without yanking the viewport back to top each burst.
- `sweepReswept` (per signature) allows exactly one return-to-top resweep when the bottom is reached but a gate is still locked — covers mid-page landings where upper blocks were never viewed.
- Sequence verified by construction against the live package: arm → dwell 1.5s (top blocks register) → step 250px/1.5s → lazy controls mount mid-sweep and get clicked by C1 → bottom → resweep if still locked → Continue appears → forward nav.

### Quiz stall — attempted-but-unanswered deadlock (v9.30, DIAG 1789994511996)

Course: **C3552 "The Case for Chemohunting"** (second Rise package on the page alongside C1012 — both course iframes coexist; frame diag keys distinguish them). The quiz (`quizDefs:12` resolved via `__fetchCourse`) stalled at "What is a key differ…": `already attempted. Skipping...` repeated every second with no "Next question…" — the card showed SUBMIT + 4 options, nothing selected, no feedback label, no NEXT button.

**Root cause:** `attempted.add(qid)` fires when a solve is *scheduled*, not when an answer is *committed*. Once a qid lands there, nothing short of the narrow A1 error-text path ever releases it. A submit click that never landed, or a Take Again pass that reset answers, leaves the question `attempted` + unanswered forever → skipped each tick → no NEXT exists → permanent stall. `quizSolveFails` release only fired on AI-solve failures, not on "answer never stuck."

**Fix:** in `detectActiveQuiz`'s skip branch, an `attempted` card is now checked for a committed state — any `input:checked`, `[aria-checked=true]`, `[aria-pressed=true]`, `--selected`/`is-selected`/`matched`/`dropped` classes, a visible `.quiz-card__feedback-label`, or a non-empty text input. If the card is still unanswered AND no solve is pending for it (`qId !== activeSolveQId`), it's released from `attempted` for a re-solve, bounded by `quizSolveFails[qid] < 4` (cleared on Take Again, so retake passes legitimately re-solve every question). After 4 releases the question stays skipped and the idle watchdog reports it rather than looping.

### New question type — dropdown-matching variant (v9.31, DIAG 1789995181995)

Same C3552 course, Q02/13 "Match each term to its most appropriate descriptor". Rise renders this matching question as `li.matching-item.matching-item-immobile.droppable` rows — term on the left, **`<select>`/popup-listbox control on the right** — a different class family than the drag variant (`matching-interaction-item` / `matching-interaction-piece`). The LIs matched the generic `.quiz-card__interactive li` MCQ selector → misclassified `mcq` → AI answered "1,2,3,4" → capped to 1 → clicked the row LI → "Please answer the question to continue" → release → loop.

**Fix:** (1) `detectActiveQuiz` detects `li.matching-item` rows carrying `select`/`[role=combobox]`/`[aria-haspopup]` controls → new `matching-dd` type, before MCQ classification. (2) Def walker now also collects objects with `title`+`pairs[]` — matching defs store correct pairings there, not `answers`/`correct` (explains why C3552 resolved `quizDefs:12` for a 13-question quiz). (3) `solveMatchingDropdown` — term extraction (clone minus control, strip leading number/handle noise), descriptor pool from select options or one trigger-open read of `[role=option]`, answers resolved via `courseDataMatchingPairs` → `scormMatchingPairs` → AI (same L#,R# contract), applied by setting select values (+`input`/`change`) or clicking the fuzzy-matched menu option. A row that won't set releases the question (bounded) instead of submitting an incomplete card into the unbounded A1 loop. If a def matches by title but the `pairs` shape is unrecognized, the debug line logs the raw def keys for the next DIAG.

**Verification note:** the descriptor dropdowns could be native `<select>` or custom button+listbox — the solver handles both, but the exact widget is unverified against live DOM (Playwright profile was locked). If it stalls, the debug line `matching-dd: N terms, M descriptors, control=TAG` plus a DIAG will show which path ran.

### Live results + MCQ drifted-selection loop (v9.32, DIAGs 1789997780628 / 1789997851267)

**matching-dd worked** — `control=BUTTON` (custom dropdowns, not selects), terms/descriptors read cleanly, AI path applied and the quiz advanced. But courseData didn't fire: `quizDefs` stayed **12** — the `title`+`pairs` gate missed this def. No `def keys` log → no title-matched def found at all. SCORM path can't help on first attempts (needs a prior submitted `correct_responses`).

**New stall: drifted checked-state loop.** "What is the primary…" (real MCQ): solver clicked `input.quiz-multiple-response-option__input` → browser set `checked` natively → **Rise's React state never saw it** → submit → "Please answer the question to continue". On every retry `input.checked` still read true → solver skipped the click → submit → error → release → loop. A1's release was working; the solve-side "already selected, skip" optimization trusted a checked state Rise disagreed with.

**Fixes:**
1. `errorReleased` set — A1 now marks released qids; `solveQuiz` treats `currentlySelected` as untrusted on that retry: for a drifted `input.checked=true` it **silently resets to false first**, then clicks — so the native toggle lands ON and the change event reports `true` to React (a naive re-click would toggle OFF and deselect).
2. **A1 release is now bounded** (`quizSolveFails`, 4) — it previously deleted unconditionally; past the bound the question stays attempted and the idle watchdog reports instead of looping.
3. Walker widened again: `title|prompt|question|stem` + `pairs[]` **or** `type` matching /match/i. `courseDataMatchingPairs` probes `pairs|matches|matchings|responses|items` and, when no def title-matches, dumps the collected def titles so the next DIAG reveals the real shape.

### Follow-up on the drifted-selection loop (v9.33, DIAGs 1789998630878 / 1789998656870)

The v9.32 force-re-click fired correctly (`stale selected state — resetting before re-click` → re-clicked the input → submit → **error persisted anyway**), so clicks on `input.quiz-multiple-response-option__input` provably don't reach Rise's state. Structural suspect: every tick shows **two** SUBMIT detections (`MCQ Options=0` + `MCQ Options=4`) — Rise keeps the submitted card mounted. If the submit bar sits outside the card, `submitBtn.closest()` falls back to `.lesson-main` and title/options/submit can bind to **different cards** — the solver could be marking a stale card's options while the submitted card stays genuinely unanswered.

**Fix:** `detectActiveQuiz` now binds `container` to `.quiz-card--active:not([inert])` (the same selector A1/A2 already use — its error text is what drives the release loop, so it provably exists on these pages). Submits belonging to a stale `quiz-card` are skipped; when no active card exists the old closest-chain applies. Also: when A1 hits its retry bound, it dumps the option markup + card classes into the journal once, so the next DIAG shows the real DOM instead of another guess.

### Live-verified root cause + fixes (v9.34, direct C3552 Playwright session)

The course loaded directly at `…/C3552/1745622841118/scormcontent/index.html#/lessons/DiWquway9QsmZmvzA5JbJm6H_Zeexodw` — quiz defs resolve via `__fetchCourse()` (`quiz.items`, 13 defs incl. the previously-uncollected MATCHING one). Both remaining bugs were root-caused against the live DOM:

**MCQ parity bug (the "Please answer" loop).** Multiple-response options are `<label class="quiz-multiple-response-option"><input type="checkbox">` — a label *wrapping* the input. Any click inside a label forwards to its control, so `applyNums`' triple call (input + label + `__text` div) toggled checkboxes an **even number of times → net unchanged**; the native setter then forced `checked=true` (React never saw it) → submit → "Please answer" → loop. Radios survived because they can't un-toggle — only MULTIPLE_RESPONSE stalled. **Fix:** `setOptState` clicks **once** on `clickTargetFor`, verifies `isChecked` after ~500ms, escalates to the wrapper only if wrong, setter fallback last. Live-verified: the exact looping question graded **Correct** with a single `input.click()`.

**Matching def shape + orientation (why AI fired).** `type:"MATCHING"` defs have no `pairs`/`correct` — pairs live in `answers[]` as `{title: term, matchTitle: descriptor}`; the v9.32 `/match/i` walker now collects them (quizDefs 12→13). `courseDataMatchingPairs` extracts that branch first. The DOM was inverted vs the original solver: rows are `li.matching-item-immobile` (descriptor + `button[data-select-trigger]` combobox, `aria-owns` → separately-mounted listbox); options are `[data-select-item]` with `data-value` = 0-based `li.matching-item-movable` index. `solveMatchingDropdown` rewritten accordingly: pool = movable terms, rows = descriptors, `setRowValue` opens the row's trigger and clicks the option with `data-value` === movable index. Manually driven live → **Correct**.

Also: `committed` check in `detectActiveQuiz` now counts `[data-select-item="current"]:not([data-value=""])` — a filled dropdown row — so a submitted matching-dd card isn't mistaken for unanswered on retake passes.

### Double-activation root cause (v9.35, DIAG 1790000963923 — live-verified)

The v9.34 run still looped on "Please answer" — the user watched options select then deselect. Root cause sat **inside `simulateHumanClick` itself**: it dispatched a synthetic `click` event AND called `el.click()` — **both** are real activations on checkboxes/radios (and label-forwarded controls). Two toggles = net unchanged DOM while React's `onChange` fired twice; a `__reactProps$` mock call then invoked the handler a third time with a stale `target`. Radios masked it (re-clicking a checked radio is a no-op) — only `MULTIPLE_RESPONSE` checkboxes and toggle-widgets broke.

**Fix:** `simulateHumanClick` now dispatches pointer/mouse pre-events only (Radix triggers still need `pointerdown`), then performs **exactly one** activation — the inner `input` for wrapper elements (clicking a wrapper inside a `<label>` forwards a second click), `el.click()` otherwise. The `__reactProps$` block is gone: `el.click()` already reaches React's root-delegated listeners.

**Verification (live Playwright, real C3552 quiz):** ran the verbatim v9.35 functions against the active `quiz-multiple-response-option` card — one `sim` call per option, verify, submit → Rise **graded the submission** (`Incorrect` on a shuffled option — a real grading, vs "Please answer" = uncommitted). Old sequence measured DOM flicker consistent with the user's "selects then deselects" report.

Testing workflow note: `localhost` script-src injection is PNA-blocked from public origins; raw.githubusercontent 404s on private repos. Verbatim-function injection via `browser_evaluate` is the working pattern; `eval` and inline `<script>` are permitted on the Rise content frame.

### Labeled-graphic loop (v9.36, DIAG 1790011519015 — live-verified on C1256)

New course "(the) Essence Product Line" stalled with `Re-clicking forward control xN: clrpdwv2u01ck3575lokfa1od`. The block is `interactive-fullscreen/labeledgraphic` — 6 `button.labeled-graphic-marker` pins, each opening a bubble card with its own `button.bubble__next`/`bubble__prev`/`bubble__close` pager (`aria-label="Next"`). The bubble pager buttons report `visibility:visible` + layout size **even when their bubble is closed**, so forward-nav claimed `bubble__next` via `[aria-label*="Next" i]`, clicked it every 8s, and looped — the click only pages an (invisible) bubble card, never navigates.

**Fixes:**
- D exclusion: `button[class*="bubble__"], [class*="bubble"] button` — bubble controls are always intra-block, never page nav.
- C1 skip: viewed markers carry `labeled-graphic-marker--complete` + `aria-label "…, Viewed"` (this build doesn't use `is-visited`), so markers were re-clicked every tick after viewing. Both signals now skip.

**Verified live:** clicked all 6 markers → each flipped to `Viewed`/`--complete` → `CONTINUE` button unlocked (`disabled` cleared). Markers remain clickable while a bubble is open (`elementFromPoint` hits the marker pin), so no close-bubble step is needed.

## Credential security

Version 9.06 no longer contains an OpenRouter key in source. The panel's `KEY` control stores or removes the replacement value through local userscript storage, and both quiz solving and summary generation stop safely when no key is configured.

The previously exposed key must still be revoked and must not be reused. Create a replacement, enter it locally with `KEY`, and do not include it in logs, dumps, screenshots, documentation, or source control.

## Current safe next steps

1. Revoke the previously exposed OpenRouter key, create a replacement, and configure it locally with `KEY`.
2. Test each supported question type in a limited course and verify that the course itself grades the submitted answer.
3. Change parse failures to retry or pause instead of defaulting to option 1.
4. Capture assessment-specific SCORM calls, especially `cmi.interactions.*`, to document how genuine quiz attempts are persisted.
5. Keep suspend-data decoding diagnostic/read-only until unvisited lesson structures and assessment state are understood.

### Silent-stall root cause + sorting adapter (v9.37, DIAG 1790014642688 � live-verified on C1256)

The C1256 run sat on the lesson page after START: `state: running`, zero journal entries for 17+ min, `.page-wrap` 4032px at scrollTop 70, `continueBtn: null` (the button isn't mounted until lazy content loads), `sweep.armed: 0`. Every reachable priority produces at least one journaled line within a minute � total silence meant the tick **threw before reaching any status**.

**Root cause:** a brace-scope bug in Priority E. `const playBtns` was declared inside `if (!hasUnlockedFwd)` but `for (const pb of playBtns)` sat *after* that block's closing `}` ? `ReferenceError: playBtns is not defined` every tick, killing the loop between the media section and Priority F (the sweep). Pages with a visible unlocked CONTINUE never entered `!hasUnlockedFwd`, which is why earlier runs survived � the C1256 lesson top (continue unmounted below the fold) was the first page to hit it. Confirmed live: the tick-wrap journaled `tick error: playBtns is not defined` on injection, and `node --check` passes because it's a runtime scoping error, not syntax.

**Fixes:**
- playBtns loop moved back inside the `if (!hasUnlockedFwd)` block (missing `}` restored).
- Tick body extracted to `tickBody()` and wrapped in try/catch ? `reportTickError` journals each unique exception once (`tick error: msg @ frame`) and drives `stuckSince` so a persistent crash pauses via the 15 s idle watchdog instead of dying invisibly.
- The `Delay Ns` branch is journal-filtered *and* used to reset `stuckSince` � a perpetually re-armed `nextActionTime` was indistinguishable from a dead script. Continuous delay now counts toward the 15 s watchdog; sweep steps reset `stuckSince` explicitly (a working sweep is progress, not idle).
- `buildDiag` now reports `nextActionIn`, `stuckFor`, and the last 4 `runtimeErrors` (kind + message + source:line) � the three fields that separate "delay loop" from "thrown tick" in one DIAG.
- `fwdCandidates` skips `#seed-panel` controls � the panel's `? START` button matches `isKnownForwardLabel('START')` and the tick self-claimed it in single-frame contexts.

**Sorting adapter (new, `interactive-fullscreen/sorting`).** The sweep found a card-sort deck (`block-sorting-activity`: `.playing-card--draggable` cards dragged onto `.pile` zones, `deck__title` counts `N/5 Cards Correct`). The course model carries the answer key: `items[] {id,title,pileId}` + `piles[] {id,title}`, and **DOM card element ids equal model item ids** � deterministic, no AI. `_sortingKey` (itemId ? pile title) is collected by the same `quizDefs()` model walk. Priority E2 (inside `!hasUnlockedFwd`, before F): the active card is `.playing-card[aria-hidden="false"]`; it is dragged via `simulateDrag` onto the `.pile` whose `.pile__title` matches. Placed cards unmount from `.playing-card` entirely, so the selector always returns the next card. Per-card retries bounded at 4 via `sortRetries`.

**Drag-vs-sweep race (found in live verification):** the first drag attempt missed � the F sweep scrolled the block mid-drag and the pointer-move target went stale. E2 now **pins the block into view** (`scrollTop` centered, `Positioning sorting block...`) before each drag and only fires when both card and pile are on-screen; the 2.5 s claim delay also blocks F from wandering mid-drag. After the fix all 5 cards sorted live (`5/5 Cards Correct`), the `completeBlock` divider unlocked, CONTINUE advanced to the next quiz card.

Note: `SEED_UNKNOWN_IDLE` pauses via `applyState('paused')` � in single-frame injection tests the script pauses on its *own* incident postMessage (`window.top` === self). Real usage targets the wrapper frame, so this is an injection artifact, not a bug.

### Scroller resolution bug (v9.38, DIAG 1790016189929)

v9.37 reached `Positioning sorting block...` then went silent again � `scrollers.top` stayed 0 while `Positioning` re-emitted (deduped). Cause: `sortBlock.closest('.page-wrap, .page__wrapper, .lesson-main, [style*="overflow"]')` returns `.lesson-main` � the *nearest* matching ancestor � which on Rise is `overflow:visible` with scrollHeight == clientHeight: a dead container. The pin's `scrollTop +=` wrote to it and `.page-wrap` never moved ? block stayed off-screen ? pin looped ? `Unknown idle` ? pause.

**Fix:** shared `scrollContainerFor(el)` � walks ancestors and returns the first with `scrollHeight > clientHeight + 40` (the element that actually scrolls, `.page-wrap`), falling back to `documentElement`. Applied to the sorting pin, `simulateHumanClick`'s scroll-into-view, and forward-nav's scroll-to-button � all three had the same latent dead-scroller bug. Verified live: the walk skips `.lesson-main` (sh==ch==6127, overflow visible) and resolves `.page-wrap` (sh 6196 / ch 861).

### False idle-pause during work claims (v9.39, incident 1790016535657)

Real run on C1256: all 5 sort cards landed (18:48:32�44), `CONTINUE` unlocked (`disabled:false`, `lockHint:false`) � then `Unknown idle` paused it one tick after the last card. Cause: `stuckSince` began accumulating ~18:48:30 and each `Sorting card` claim set `nextActionTime` (+2.5 s), routing ticks through the delay branch � which counts continuous delay toward the 15 s watchdog but never sees that the delay IS the work. At 15 s it fired before the post-sort sweep reached the now-unlocked divider.

**Fix:** work claims reset `stuckSince` (sort pin, sort drag, C1 interactive claims, video watchdog wait, video/play-button claims). The delay branch also exempts `isSolving` � AI round-trips legitimately exceed 15 s (the tail already exempted it, but delay returns never reach the tail). Pattern: any `nextActionTime` that means "work in progress" must reset the idle clock; only unowned delay counts as a stall.

### quiz-match matching variant — misdetect + missed drops (v9.40, DIAG 1790016995730)

C1256 knowledge-check matching (`li.quiz-match__item--draggable` chevron terms → `li.quiz-match__item--immobile.droppable` descriptor cards) was misclassified as `single-select (6 opts)`: the droppable LIs matched the generic option scan while the real matching selectors (`button.matching-interaction-piece`) found nothing. It then burned AI retries on a question the course model answers deterministically (`answers[].title → matchTitle`), and the sweep kept scrolling mid-solve (top-reset pulled the card off-screen — the "scrolls all the way up" symptom).

**Fix:**
- `detectActiveQuiz` collects the quiz-match columns and classifies `matching` before MCQ. Droppable LIs are `aria-hidden="true"` hit targets — `isVisible`/`isOptionVisible` would drop them, so this variant filters on rect size only (off-viewport rows are still valid pair members; filtering them produced `L(4) R(4)` and broke courseData resolution).
- `solveMatchingQuestion` now tries `courseDataMatchingPairs` before SCORM/AI (same order as the dropdown solver) — MATCHING defs resolve with zero API calls.
- Priority F sweep yields while `isSolving` — scrolling mid-solve invalidated drag coords and re-armed the top-reset.
- quiz-match remounts/re-sorts items after every drop — held refs detach (verified live: the dragged li never gained `--matched` while a fresh query showed it at index 0). The drag loop re-resolves L/R by text each pair.
- Per-pair land verification + one retry + a final residual pass. A missed drop wedges the card at 5/6 (submit stays `--disabled` and the partial state counts as "committed" → permanent skip → infinite sweep). If items still refuse to land the question is released so the idle watchdog reports it honestly instead of looping forever. Drop targets are scrolled into the real scroller first (`ensureVis`) since the pointer hit-test resolves at viewport coords.

**Verified live:** `Dragging 6 pairs` from courseData → `matching: L5 → R1 did not land — retrying` (exactly the wedge path) → `Matched! Submitting...` → `Advancing...` → next lesson, where the following MCQ solved via `Course-data answer hit`.

### Empty piece-text under visibility:hidden → courseData miss → AI wedge (v9.41, DIAG 1790018288706)

v9.40 reached the quiz-match card correctly (`Matching L(6) R(6)`) but still asked the AI: `getPieceText` reads `el.innerText`, which returns `""` for `visibility:hidden` items (lazy mount / mid-animation). All 6 term/descriptor texts normalized to `""` → `courseDataMatchingPairs` found no matches → `scormMatchingPairs` empty → AI → `AI parse fail` ×3 → `attempted` + partial `--matched` counted as `committed` → "already attempted. Skipping" + sweep forever. Live DOM: `computedStyle.visibility = "hidden"` on the li while `innerText=""` and `textContent` holds the text (plus svg title/desc noise).

**Fix:**
- `getPieceText` now reads `.quiz-match__item-content .fr-view` / `> span:last-child` via `textContent` (visibility-blind, skips svg noise) before the innerText fallback. Verified live: all 6 terms + 6 descriptors extracted under `visibility:hidden`.
- The `committed` gate no longer counts `[class*="matched"]` when the container holds `li.quiz-match__item--draggable` — a partial match is mid-solve, not a committed answer, so the card releases for bounded re-solve instead of skipping forever.

**Residual risk:** `quizSolveFails>=4` still skips silently — if a card is truly unsolvable the sweep loops without an incident. Deliberately left: the bound prevents unbounded churn, and the sweep reports "Reviewing page" so the state is visible in DIAG.

### Passed-quiz results screen swept forever → false Unknown idle (v9.42, incident 1790019031738)

The Knowledge Check passed cleanly (`cmi: completed/passed/1 — course done`) at 19:27:39 — then the script kept ticking. The passed-report (Priority E) fires once via `quizPassedReported`; subsequent ticks fall to Priority F, which swept the results page (no forward nav — only TAKE AGAIN/EXIT) until the 15s watchdog emitted `Unknown idle` ~3min later. The header docs already promised "report completion and pause" — the pause was never implemented.

**Fix:** `applyState('paused')` after the pass report. Results screens are terminal for the helper — user exits or NUKEs manually.

### Auto-capture pipeline (v9.42)

Incidents/diags now auto-POST to a local capture listener on `127.0.0.1:8766` (port 8765 already serves the local BTTF app, so the legacy `/log` POSTs stay there): `storeIncident` → `POST /incident`, DIAG/DUMP buttons → `POST /diag|sniff`. New `capture_server.js` writes them into `captures/` and serves `GET /latest` (newest file per kind). Silent no-op when the listener isn't running — behavior unchanged otherwise.

**Workflow:** run `node capture_server.js` alongside the course → any stall lands in `captures/` automatically → "check the latest capture" instead of downloading + uploading files manually.

### C1282 tabs block unlocked nothing — new selector variant (v9.43, incident 1790019665083)

C1282's "About Us" lesson gates CONTINUE on a Rise **tabs** block (`button.blocks-tabs__header-item`, role=tab — EXCELLENCE/INNOVATION/IMPACT). C1's interactive selector knew `tab-nav__item` but not this variant → nothing claimed → sweep ↔ Idle loop → `Unknown idle`. **Fix:** added `button.blocks-tabs__header-item` to the C1 selector + `--active` to the current-tab skip + generic `/--(visited|complete|seen)\b/` viewed-marker skip so visited tabs can't cycle forever.

Also fixed: `helperVersion` was hardcoded `'9.33'` in `buildIncident`/`storeIncident` (every incident mislabeled) — centralized into `HELPER_VERSION` const now used by the dump meta too.

### C1282 tabs ping-pong — EXCELLENCE↔INNOVATION, IMPACT starved (v9.44)

v9.43 claimed the tabs block but looped between the first two tabs forever: with INNOVATION active, EXCELLENCE was the first non-active tab in DOM order and got re-clicked every tick. Rise tab strips expose **no viewed marker** (`--after-active` is positional only), so the marker skip can't disambiguate. **Fix:** sequential forward-only progression for `blocks-tabs__header-item` and `tab-nav__item` — only the tab immediately after the active one is clickable (wraps to index 0 when the last is active), same model as the slide-dots guard.

### Queue mode — catalog autopilot (v9.45)

New QUEUE panel button runs every outstanding course back-to-back: catalog → detail → completion → back to catalog → next. Mechanics:

- `seed_queue` GM flag (`{active, tried, current, done, pages}`) persists across navigation; `whenBodyReady` auto-`applyState('running')` when armed so each new page self-starts. Iframes pick up 'running' via the existing 1.5s SEED_STATE_QUERY poll.
- Course list comes from the app's own API: the page sniffer now relays `api.seedtalent.com/api/v1/courses/*` response bodies to the top frame even with SNIFF off (200k cap for these endpoints; catalog bodies are truncated to 2k inside sniff dumps). `courses/outstanding` is authoritative (empty = done); `by-category` + DOM anchors are fallbacks.
- `pickNextCourse` prefers API uuids, skips `tried` ids; DOM fallback filters cards containing 'revisit'/'100%'.
- Queue-aware exits: SEED_QUIZ_PASSED → done++ → catalog; SEED_UNKNOWN_IDLE / SEED_UNHANDLED / SEED_TERMINAL_PAGE / SEED_PAUSE_REQ → mark tried, skip, catalog (each course's incident still stores + POSTs to the listener).
- Watchdogs: detail page with no SCORM iframe for 90s → skip (idle watchdog doesn't cover app pages — `isLikelyCourseContentFrame` false). Catalog pager: ≤40 next-page clicks in DOM-fallback mode. Queue auto-disarms after 12h.
- Latent bug fixed en route: `applyState('paused')` in tickBody's passed-quiz branch was a ReferenceError (panel-scoped, invisible to module-level tickBody) — replaced with `state = 'paused'`; the SEED_QUIZ_PASSED message already carried the real pause.

### Queue picker used the wrong endpoint — instant "complete" (v9.46, sniff 1790101837887)

v9.45 treated `courses/outstanding` as authoritative; it actually returns `{"items":[]}` (a different concept) → empty pick → "Queue complete — 0 done". The real catalog source is `courses/by-category`: `[{id, name, courses:[{id(uuid), name, progress, status, canStartCourse, userTestResults}]}]`. Picker now walks by-category for objects carrying uuid `id` + progress/status fields, skipping `status:Completed`/`progress>=100`/`canStartCourse:false`. If the catalog body was never captured, the queue reloads the page once to let the sniffer catch the fetch, then falls back to DOM anchors + pager.

### Queue live run — two stalls (v9.47, sniff 1790102351248 + incident 18:38:15)

**Grön Arcana (skipped, not completed):** slide-deck lesson (`lesson-one-page-slides`, step 4/5). Quiz answered Correct → step 5 dot + next-btn stayed `disabled until content is completed`. The only enabled control was `lesson-one-page-slides__page-down-btn` ("Scroll page down") — the step had unviewed content below the fold *inside the slide*, and nothing clicked it → 15s idle → queue skip. Fix: `page-down-btn` added to C1 (clicks until the slide bottoms out → step completes → dots unlock).

**Black Label flip-flop:** `flashcard-side-flip__btn[id$="-front-flip-btn"]` had no `--flipped` guard. Rise renders both card faces with backface-visibility — the flipped card's front button keeps a non-zero rect → isVisible passes → re-click flips it back → loop (user scroll broke it manually). Fix: selector scoped under `.flashcard:not(.flashcard--flipped)` + container-level guard skipping any `flashcard*` ancestor with flipped/viewed/complete class or a `", Viewed"`-style aria-label.

**Queue mechanics verified:** picked real incomplete courses by name (`Queue: opening Grön Arcana…`, `Black Label - NJ`), queue-skip on incident worked, tried-map advanced to next course. Note: skipped courses reset on re-arm (new QUEUE press) — Grön will retry next run.

### Frozen-scroller sweep masked the idle watchdog — 2min silent stall (v9.48, sniff 1790103306542)

"ish - nj" opened via queue, SCORM frame mounted, then 2min of `Idle` with **no incident**. Cause: Priority F's scroll step does `scrollTop += 250` and unconditionally claims progress (`stuckSince = 0`). On a page whose scroller reports `scrollHeight > clientHeight` but can't actually move (frozen/transform-paged intro), the branch repeats forever — deduped status = invisible, watchdog permanently reset. Fix: measure `scrollTop` before/after; ≤0 movement counts toward `sweepStuck[sig]`, and after 6 no-ops the branch stops claiming so the 15s idle watchdog fires → incident → queue skip. `sweepStuck` clears in resetMemory.

### Selected-but-unsubmitted quiz wedge + silent --active gate (v9.49, diag 1790103708936)

Grön Arcana slide-deck Q2 ("Which Grön product is dreamy and introspective?"): solver picked option 1 (history cache hit), then `Completing interactive block` (page-down) fired mid-solve — the ~1.2-2s later `isVisible(submitBtn)` check failed post-scroll so **SUBMIT was never clicked**. Rise shows no error (never asked), so the card sat attempted+selected forever: empty-looking radios + enabled SUBMIT + stale `Correct` banner from a sibling card.

**Bug A — silent skip:** `detectActiveQuiz`'s `--active` gate (`ownCard !== activeCard → continue`) emitted zero journal output — the answered feedback card kept `--active`, shadowing the live card's submit every tick. Fix: the gate now binds the submit's own card when it has live options and no feedback; skips (with a debug line) only when that card is resolved or option-less.

**Bug B — committed pin:** `activeSolveQId` was set at solve-start but cleared only in failure paths — a finished solve pinned `qId === activeSolveQId` → treated as committed forever. Now cleared at all four solver exits, and `submitClickedAt[qid]` records real submit clicks.

**Bug C — no unsubmitted rescue:** a card with a selection but no feedback and a live submit now gets SUBMIT re-clicked directly (4 tries, 4s grace vs the solver's own click), then falls through to the idle watchdog → incident → queue skip.

### Replay-button loop starved lower priorities (v9.50, incident 19-20-58)

C10539 (Belushi's Farm): quiz submitted correctly (radio disabled+checked), checkboxes done — but the page sat mid-scroll with 2 unflipped flashcards and `sweep.armed:0`. Cause: the playBtn selector `[aria-label*="Play" i]` / `button[class*="play"]` matches VJS's post-finish **"Replay"** control — each click restarted the finished video ("Video finished" logged 4x), and every claim returned before Priority F could sweep. Fix: filter replay/again-labeled buttons out of playBtns — replaying a watched video is never a completion requirement. Also confirmed working-as-designed: `external-embed` correctly detected a cross-origin paperform.co survey (C11271) → incident → queue skip; it can't be auto-filled.

### matching-interaction uses click-pair, not drag — "Please answer" loop (v9.51, diag 1790105617975)

Rove Q4/10 "Match the following voltage settings and colors": solver found the pairs via courseData and "dragged" them — but matching-interaction pieces are `<button>` elements (paired via aria-pressed + hidden "Matched with X" span), so simulateDrag's HTML5 DragEvent sequence registered **zero** pairs → submit → "Please answer the question to continue" → release → re-solve → loop (also each cycle took minutes under timer throttling).

Also the grip/socket direction is **reversed** on this card — ⋮⋮ grips on the RIGHT column — so even real drags aimed at non-draggables.

Fix (solveMatchingQuestion pair loop, non-quiz-match only): `canDrag` detects a real drag source (`draggable`/`li.draggable`/`data-rbd-drag-handle`) and drags that side onto the other; otherwise click-pairs via simulateHumanClick (single activation — safe on buttons), trying both click orders. Every pair is verified through getCurrentMatchText on BOTH elements; unlanded pairs count into `unmatched` → releaseFailedQuestion (bounded re-solve) instead of submitting to the "Please answer" loop. quiz-match path untouched.

### Shared submit-bar wrapper poisons the --active gate (v9.52, incident 1790170308706)

Wildberry C4820 step 4/5: Card A answered (Correct), Card B live with enabled SUBMIT — every tick logged `submit skipped — belongs to a non-active card`. Cause: B's submit bar sits **outside** its card, so `closest()` climbed to a shared wrapper containing Card A's feedback → the v9.51 `resolved` check saw feedback and skipped the live submit forever.

Refined gate: `staleActive = cardResolved(activeCard)`. A live --active card keeps the original skip (foreign submits are stale). When --active is itself resolved, bind `nearestLiveCard()` — the unresolved, option-bearing `.quiz-card` nearest the submit's rect — covering both the shared-wrapper case and stale-ownCard. Disabled inputs excluded from `cardLive` so answered cards don't qualify.

### Raffle/giveaway embeds — paperform.co auto-fill (v9.53)

Giveaway lessons (Rove Ice Packs, OCB Survey, Old Pal Survey, Grön Halloween) embed a cross-origin `*.paperform.co` iframe — previously an instant `external-embed` incident/skip. Added `@match *://*.paperform.co/*` so the script runs inside the form frame:

- **Child frame** (`raffleTick` on the main tick): fills fields from the `seed_form_profile` GM value — set once via the new **👤 INFO** panel button (name, email, phone, store, address, city, state, zip, DOB, instagram; nothing hardcoded). Label→field mapping via aria-label/placeholder/name/id/wrapper text keywords. React-safe `setNativeValue` (prototype setter + input/change/blur). Consent checkboxes (agree/certify/21+/terms) auto-checked. Submits via the action button, bounded at 12 clicks ≥4s apart (covers multi-page Next chains), success detected via thank-you/entered text → `SEED_RAFFLE_DONE` postMessage to parent.
- **Parent frame** (`handleRaffleEmbed`): intercepts the `external-embed` detection for paperform hosts — holds the incident for a 90s grace window, then falls back to the normal incident path on FAIL/timeout. On DONE the signature is marked handled and `stuckSince` resets (real progress). No-profile case nags via `SEED_RAFFLE_NEEDS_PROFILE` — the profile can be entered live mid-run since the child re-reads GM storage every tick.

### matching-interaction: drag-then-click poisons the pair clicks (v9.54, diag 1790174075987)

C11613 "Click and drag each intention to the correct flavor" looped ~5min: `Dragging 8 pairs` → 87s → `8 pair(s) would not land` → release → re-solve. Two compounding causes:

1. `simulateDrag`'s pointerdown on an rbd drag handle puts the piece in pending-drag state; the follow-up `simulateHumanClick` pairing clicks then landed on a confused control — and both click orders failed anyway.
2. Verification only read `span.visually-hidden-always` "Matched with" text — this card may mark pairs via `--matched` classes / aria-pressed instead.

Fix: drop `simulateDrag` entirely for non-quiz-match pieces. Per pair: plain `el.click()` L→R, plain R→L, then `simulateHumanClick` both orders (plain clicks avoid triggering the rbd sensor). `landed()` now also accepts both-pieces-`aria-pressed`+`--matched` class / `li--matched` ancestor. `getCurrentMatchText` reads all `visually-hidden*` span variants. Unlanded pairs log the failed texts for the next capture.

### matching-interaction: identical column sets → identity self-pairs (v9.55, incident 1790176140370)

C11613 retry: all 4 click strategies ran per pair but every pair failed — `mango ↔ mango`, `relax ↔ relax`. Root cause found in the incident's control list: this card marks **every** piece `li` as both `draggable` and `droppable`, so `col1Btns` and `col2Btns` selected the same 8 buttons. `col1Texts===col2Texts` → the AI's `L1,R1` answer mapped each piece onto itself → click-pair toggled a piece's own aria-pressed → never a pair.

Fix: when the two column sets fully overlap, re-split all pieces by x-center at the largest x-gap (the visual two-column split is reliable even when li classes aren't). Debug line reports the re-split counts.

### Raffle filler: icon-only pager arrow missed (v9.56)

Paperform's paginated forms use a full-width icon-only arrow button (no innerText/aria-label) — the action regex never matched it, so the filler filled the first page then sat at "filling fields…". Fallback chain now: text-matched buttons → submit/next/arrow-classed → widest visible button outside field wrappers (the next bar; unlabeled back arrows are small).

### Raffle filler: composite address block + custom dropdown (v9.57)

Paperform's dispensary-address question nests Street/City/State/Zip/Country sub-fields under a wrapper containing "dispensary" — the keyword hit `store` before each field's own label, so every sub-field got the store name; and Country is a custom picker (re-rendered hidden inputs), not a fillable text field.

Fixes: `raffleFieldLabel` now returns `{own, ctx}` — keyword mapping tries the field's own label first, wrapper context only as fallback. Added `country` profile field (defaults to "United States"). Native `<select>` gets option text/value matching with a first-real-option fallback. Custom `[role=combobox]`/`aria-haspopup` dropdowns open one tick and click the matching `[role=option]` next. Re-fills capped at 3 per field (React re-renders were wiping values → every-tick re-fill spam).

### Raffle DONE path starved the queue (v9.58, sniff 1790252319983)

C10539: raffle submitted successfully at 11:23, then `Raffle entry submitted — continuing…` repeated for ~55min — the course never advanced and the queue never moved on. `handleRaffleEmbed`'s DONE branch returned `true` every tick → reset `stuckSince` forever → watchdog starved (same failure class as the v9.48 frozen-sweep bug).

Fix: DONE is now one-shot — delete the host, mark the signature handled, reset `stuckSince` once, `return false`. The normal engine flow resumes; if the page still can't advance, unknown-idle fires at 15s → queue skips/continues. Any branch that reports "handled" must still let the watchdog see real progress.

### Hidden-tab throttling — worker-driven tick + sleep release (v9.59)

Chrome intensively throttles page timers in hidden/occluded/minimized tabs (~1/min after ~5min hidden). A QUEUE run in a backgrounded window crawled — every `sleep(350)` inside a solve stretched to ~60s.

Mitigation: a module-level blob `Worker` runs `setInterval(postMessage,1000)` — worker timers are exempt from intensive throttling. While `document.hidden`, each worker message (a) releases queued `sleep()` waiters whose deadline passed (hidden sleeps degrade to ~1s granularity instead of ~60s) and (b) drives an extra `tickBody`. Foreground path is untouched. CSP may block `blob:` workers on some pages — the normal interval remains as the throttled fallback. Nuclear alternative: launch Chrome with `--disable-background-timer-throttling --disable-backgrounding-occluded-windows --disable-renderer-backgrounding`.

## v9.60 — unknown-idle grace for freshly-mounted frames (diag 1790342931282)

Queue logs showed several courses skipped at almost exactly mount+15s
(C4418 Resin Rosin ~16s, C11528 DARK HEART ~15s): Rise lazy-mounts first
content in ~10-15s, so the 15s idle watchdog could fire before the page
rendered — healthy courses were being skipped as "stuck". The watchdog now
requires the frame to be ≥30s old before an unknown-idle incident can
report; the 15s bound is unchanged for mid-course stalls, and
unhandled-adapter detection (external embeds, Storyline) still probes at
5s. Skips remain explicit and bounded — just not premature.

## v9.61 — panel version badge was hardcoded

The "Seed Helper vX.YZ" badge was a literal string in the panel template,
not bound to `HELPER_VERSION` — it read v9.59 on v9.60, making it look
like Violentmonkey updates weren't applying when they were. Now renders
`v${HELPER_VERSION}` so it can't drift again.

## v9.62 — incident auto-download + flashcard guard self-match bug

**Auto-save:** incidents now `downloadJson` automatically inside
`storeIncident` (all types) — unattended queue runs leave evidence without
anyone clicking INCIDENT. Chrome may ask once to allow automatic downloads
for the site.

**C11528 (DARK HEART) recurring stall** — same flashcard lesson stalled
across 5 sessions: one "Flipping required card" then idle → unknown-idle,
with 2 `flashcard-side-flip__btn` buttons still present and continue locked
("Complete the content above"). Root cause candidate found in the guard:
`el.closest('.flashcard, [class*="flashcard"]')` **self-matches** — the
button's own class contains "flashcard", so `closest()` returned the
button and the flipped-card check never saw the card. Fixed: prefer
`closest('.flashcard')`, else walk ancestors past `--side` wrappers to a
card-level element. Selector widened to any front-face
`.flashcard-side-flip__btn` (the old arms required literal `.flashcard`
+ `--flipped`/id conventions this variant may not share); back-face
buttons are skipped explicitly. `controlEvidence` now records `id` and
the card ancestor's class for flip buttons — the next incident shows
whether unclaimed cards were actually flipped.

## v9.63 — generic sweep scroller + skip-reason telemetry (5× unknown-idle incidents)

Five fresh v9.62 incidents auto-downloaded. All Rise stalls shared
"Complete the content above before moving on" with unclaimed controls:
- C2653 BITS: 5 `labeled-graphic-marker` buttons "Not viewed" — never
  claimed once (no 'Completing interactive block' entries at all).
- C2818: carousel mid-block. C2814: only Zoom-image buttons + lock.
- C2267 Wyld: all 4 cards confirmed `--flipped` (the new `card:` field
  works — C11528-class flips are completing), remaining wedge was a quiz
  card + unchecked block-list inputs.
- Coassemble embed: unsupported surface, correctly skipped.

Root suspect for the BITS-class stalls: `isVisible` filters markers that
are `opacity:0` until scroll-mounted, AND the sweep only probed
`.page-wrap/.page__wrapper/.lesson-main` — if the scroll container uses
other class names the sweep silently never armed (no 'Reviewing' lines in
any of these journals). Two changes:

1. Sweep resolves the scroller generically — walk up from the locked
   button or first `[data-block-id]` to the outermost scrollable ancestor.
2. Skip telemetry: every filtered interactive now records a reason code
   (vis/locked/active/expanded/visited/fc-done/backface/checked/tab-order/
   dot-order/tries-cap) in `lastC1Skips`, appended to the Unknown-idle
   debug line and incident journal — next stall names the actual filter.

## v9.64 — div-variant block-list options (C1750 RYTHM)

4 more incidents (still 9.62): C1750 stalled with 4 `div.block-list__option`
checklist rows — the interactives selector only covered `label.…` and
`.block-list [role=checkbox]`, so a div-variant option with no inner
role el was invisible. Added `div.block-list__option` to the selector,
shared the label/div filter (a div containing a role=checkbox still defers
to the role element), and widened `isListOption` so div options get a
single `el.click()` — `simulateHumanClick`'s dispatched-click + el.click()
pair would double-toggle a listener-based div (check+uncheck = no-op).

Other incidents reviewed: C2044 Puffco = embed video player with
"Forward seeking disabled" — retries bounded, honest skip. C2163 slide
deck at 10/10 with next-step gated on content completion — the v9.63
generic sweep should reach lazy-mounted leftovers. C1520 quiz answered
Correct but locked — same below-fold class.

## v9.65 — card-sort alt-pile fallback (C3851 Bacio Gelato)

Live diag showed "Pink Panties → Gelato" dragged 3× while other cards
landed first-try — drags DO register, so a bounce = the model's pile was
wrong. Old behavior: 4 identical drops then exhaust → card stays active →
idle → incident. Now: 4 tries on the model pile, then each OTHER pile
once (cap = 4 + nAltPiles) — wrong model answers self-correct on 2-pile
decks. Same frame also showed a quiz AI retry loop ("Incorrect" →
re-solve, past-failures injected) — separately bounded, no change.

## v9.66 — skip telemetry was being truncated by the 160-char journal clip

Six v9.65 incidents reviewed: all flashcards confirmed `--flipped` (DARK
HEART, CORE SIX, SAVVY, Puffco — flips verified working incl. the
`flashcard--stack` variant), and `labeled-graphic-marker` "Not viewed"
buttons remain the dominant unclaimed control (SAVVY, BRIQ 2).

But the v9.63 `skips:` suffix never appeared: `journalPush` clips text at
160 chars and `'Unknown idle: ' + signature(≤140)` consumed the whole
budget, silently truncating the telemetry. Reordered — skips now lead the
line, signature trimmed to 90.

Multi-video note (user-observed, Puffco What's New): embed play buttons
each get 3 bounded clicks; several buttons churn ~30s before the watchdog.
Clicks likely don't reach the cross-origin player — honest skip either
way, just slow. Not changed yet.

## v9.67 — triedInteractives telemetry (35-incident batch analysis)

35 incidents across ~28 courses — a broad QUEUE sweep, not one stuck
course. 8 were the same Coassemble embed (correct repeated skip). 24 had
interactive-class controls still present; 23 had locked navigation.

Root-cause gap found in the telemetry itself: `lastC1Skips` was empty in
every incident because a claimed-first candidate `return`s mid-loop each
tick — the remaining candidates never evaluate, so no skip reasons ever
accumulate. Incidents now carry `triedInteractives` (intId → try-count)
from `interactedBlocks` — shows exactly which controls burned their 15
tries, distinguishing "clicks never registered" from "never reached".

Batch observations: RYTHM held 20+ `process-counter__btn` steppers +
4 div options; Wyld confirmed all-flipped cards with a quiz wedge +
unchecked block-list inputs; multi-video Puffco embed-play churn bounded.

## v9.68 — the bare-el.click() single-fire regression (13-incident batch)

0 done / 13 skipped — but the new `triedInteractives` data named the root
cause: Puffco burned **15 tries each** on markers, tabs, and steppers;
'Go to next slide' ×5; objections markers ×15. Clicks claimed but never
registered.

Root cause: the C1 claim path used **bare `el.click()`** for
steppers/toggles/checkboxes because of a comment claiming
`simulateHumanClick` "dispatches a click event AND calls el.click()".
That was stale — the dispatched click was removed (DIAG 1790000963923)
and it now sends pointerover/down/up + ONE el.click(). Bare el.click()
emits NO pointer events, so Rise components bound to onPointerDown
never see the click. The ×15-try pattern across markers/steps/tabs/
options = pointer-bound controls invisible to a click-only activation.

Fix: all C1 claims use `simulateHumanClick` — pointer events for
onPointerDown builds, single activation (no double-fire) for onClick
builds, and its inner-input resolution covers the old label/div path.

## v9.69 — vis sub-reasons + persisted unsupported-surface set (37-incident batch)

v9.68's unified pointer-click did NOT fix the broad skip class (0/37) —
but `skips:` telemetry now names the filters. Dominant reason `vis:`
(~10 courses): candidates exist in DOM but `isVisible` rejects them.
isVisible has no vertical-bounds check, so `vis:` can't mean
"below fold" — it means hidden/inert/offscreen-x/zero-size. v9.69 splits
it: `vis-aria / vis-rect / vis-x / vis-inert / vis-style / vis-pe` so
the next incidents distinguish lazy-mount (style) from inactive-slide
content (inert/x) from pointer-events-locked (pe).

Also: `triedInteractives` ×1 entries (70 of ~85) suggest claims DO
register where controls are genuinely live — the ×16 capped controls
are concentrated in specific courses (Puffco, RYTHM steppers).

Plus: the same Coassemble embed fired 9× in one run. `unhandledSurfaces`
now persists per version (`seed_unsupported_surfaces` GM key) — a known-
unsupported surface posts SEED_UNHANDLED with no incident, so queue
instant-skips it without a re-download. New versions re-probe.

## Session closeout — the stale-copy discovery (final batch, 35 incidents)

Decisive forensic result: all 35 incidents self-report `helperVersion:
9.69` yet contain ZERO `vis-` subcodes, ZERO `(known)` unhandled hits,
and the Coassemble embed still re-fired 8x. Conclusion: **none of the
v9.69 code ran** — the installed copy had its version strings bumped
9.68->9.69 without receiving the code edits (same ghost as the hardcoded
v9.59 badge). This also casts doubt on whether v9.68's pointer-click fix
was ever genuinely exercised — the "fix didn't work" read from the
37-batch is now suspect, not confirmed.

Validated wins across the session: flashcard stall class dead,
card-sort alt-pile self-correction, queue hygiene + auto-incident
download, and the skips/triedInteractives telemetry pipeline.
Outstanding: the `vis:` wall — controls present but failing isVisible —
awaiting the v9.69 subcodes (inert/x/style/rect/pe/aria) to split it.

**Handoff note:** on a new machine, install the script by pasting the
full file — never hand-edit version lines. A version string without the
code produces exactly this class of misleading telemetry.
