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

The current v9.06 runner is close to the desired interaction model but should not be treated as a reliable background state machine yet:

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

### Known solver limitations

- It currently requires the question and controls to be rendered in the DOM.
- Unsupported question types are not handled automatically.
- Image-only, video-dependent, hotspot, ordering, and complex simulations may lack enough text or compatible controls.
- The model response is probabilistic and is not guaranteed correct.
- The current single-select parser falls back to option 1 if it cannot parse an answer, which can create an avoidable incorrect attempt.
- The configured model may be unavailable, rate-limited, or changed by its provider.
- Automatic selection still uses player-side clicks, input events, or drag events; it is automated but not a server-side/background-only assessment API.

## Credential security

Version 9.06 no longer contains an OpenRouter key in source. The panel's `KEY` control stores or removes the replacement value through local userscript storage, and both quiz solving and summary generation stop safely when no key is configured.

The previously exposed key must still be revoked and must not be reused. Create a replacement, enter it locally with `KEY`, and do not include it in logs, dumps, screenshots, documentation, or source control.

## Current safe next steps

1. Revoke the previously exposed OpenRouter key, create a replacement, and configure it locally with `KEY`.
2. Test each supported question type in a limited course and verify that the course itself grades the submitted answer.
3. Change parse failures to retry or pause instead of defaulting to option 1.
4. Capture assessment-specific SCORM calls, especially `cmi.interactions.*`, to document how genuine quiz attempts are persisted.
5. Keep suspend-data decoding diagnostic/read-only until unvisited lesson structures and assessment state are understood.
