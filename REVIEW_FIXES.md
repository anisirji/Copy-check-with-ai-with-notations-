# Deep-review fixes — 2026-09-24

Source: `/Users/ani/.claude/plans/shiny-drifting-yao-agent-ae91c0c04e021e4e4.md`.

## Confirmed defects

| Finding                                | Resolution                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1: path traversal                     | Validated single-component storage IDs in HTTP parameters and store methods. Applied bounded run paths to pipeline, regrade and seeding. Encoded slash/backslash, dot segments, percent escapes and null bytes are rejected before file access. Original StudentStore class names were already slugged; that finding was overstated.                                                                                                                |
| B2: approval and normalization updates | Optional undefined metadata preserves the saved value; explicitly clearing approval is honored. Merge and normalization deliberately revoke approval, including same-total normalization. Only the dedicated approval operation grants approval. Ordinary JSON PUT requests did not previously erase omitted normalization, and existing merges already cleared approval via content comparison; tests now pin down the intended behavior directly. |
| B3: concurrent writes                  | A shared mutex keyed by absolute file path covers each entire read/modify/write operation across store instances. JSON publication uses temporary files and atomic rename. Question edits, merges, normalization, approval, paper attachment, history append, student add, grading revisions, release, metadata and acknowledgment use the relevant shared lock. Repeated release preserves its original timestamp.                                 |
| B4: inferred student identity          | Regrade requires an explicit, valid saved studentId. It no longer parses student identity from the run name; missing identity fails before new directories or provider calls.                                                                                                                                                                                                                                                                       |
| N4: seeding ceiling                    | Responses return requestedCount and actual count. Invalid/non-integral counts and unsafe seed paths fail.                                                                                                                                                                                                                                                                                                                                           |
| N5: mistake tagging                    | A digit alone no longer makes a partial answer careless. The heuristic requires both a numeric value and a calculation symbol.                                                                                                                                                                                                                                                                                                                      |
| N6: blank tag handling                 | Extracted a named resolver. A teacher-requested blank tag cannot contradict a written or partially credited answer.                                                                                                                                                                                                                                                                                                                                 |
| N7: unmatched feedback                 | Teacher feedback without a matched answer remains in the review record; no arbitrary comment box is drawn on page 1.                                                                                                                                                                                                                                                                                                                                |
| N8: students without history           | Real deltas sort ahead of missing history; students without history then sort by lowest score, with a stable name tie-break.                                                                                                                                                                                                                                                                                                                        |
| N10: static audit exposure             | Removed the broad output-directory static server. An explicit media allowlist blocks evaluation JSON, cached blocks, model/audit data, logs, staging directories and symlinks outside the output root. Review PNG/PDF links still work.                                                                                                                                                                                                             |

## Clarifications and maintenance

- N1: added an unsupported numeric-marker regression and documented Q. prefix normalization; no synthetic zero-root question is created.
- N2: named the analyzed historical total used for report compatibility.
- N3: documented the existing rule: an exam ID denotes one sitting; later releases/regrades of that ID are revisions. A new sitting needs a separate exam ID. No arbitrary date-window heuristic was introduced.
- N9: renderer text escaping was already correct and remains intact.
- Explained sub-cent topic rounding with a concrete example and hoisted question-content comparison out of the loop.
- Grade requests validate the student ID as a string, so object/array/numeric values do not become accidental IDs.
- Exam lists validate candidate records and ignore non-exam JSON and temporary files.
- Corrupt records fail without replacement; HTTP handlers return an error rather than leaving an unhandled rejection.
- Removed matrix CSS specificity overrides, guarded empty-class percentages and removed the report non-null assertion. ConfirmQuestions was already formatted into readable statements/JSX in the current revision; no behavior-changing extraction was needed for that stale nit.

## Validation

- **83 backend tests pass**, including 17 added regressions covering traversal across 24 endpoint shapes, unsafe store IDs, simultaneous mutations, atomic publication, approval/normalization, missing student identity, seed count, tagging, annotations and missing history.
- Backend TypeScript check and frontend production build pass.
- Teacher report/matrix browser interaction checks pass at desktop and mobile sizes, including print export, empty states and no browser errors.
- Live read-only check confirms the assessment list and clear-paper review load, PNG/PDF assets render, raw evaluation/blocks JSON returns 404, and the unreleased family report stays blocked.
- Tests use isolated temporary stores and fake grading/rendering where appropriate. No grading/OCR provider calls or changes to the original paper/student results were made for this review.

## Scope of protection

The mutex coordinates a single Node backend process; it is not a cross-process database transaction. Multiple backend workers need shared transactional storage or a cross-process locking scheme.

The static audit bypass is closed. The POC still has no teacher identity/session system: its existing teacher APIs and review media assume a trusted local environment. The release gate is a workflow control, not authentication. Adding a production login and authorization model remains separate work; the media allowlist must not be described as adding authentication.
