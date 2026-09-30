# ScholiPhi UI reference review

Implemented against the recent Downloads PDFs and the accompanying eight-board `ScholiPhi — Test Report UI (Teacher & Student views)` HTML/PDF. The two individual-report PDFs are duplicates.

| Supplied reference                                                 | Implemented screen                                                               |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| Teacher view — test analysis                                       | `/exam/:id/report`                                                               |
| Teacher view — class matrix and follow-up                          | `/exam/:id/matrix`                                                               |
| Answer review — paper on the left, feedback on the right           | `/review/:runId`                                                                 |
| Student & parent view — individual report                          | `/exam/:examId/students/:studentId/report` and released `/review/:runId/student` |
| Parent guide (combined reference)                                  | `/review/:runId/parent`                                                          |
| Setup flow, question check, answers and rules (combined reference) | `/create-exam`, `/exam/:id/questions`, `/exam/:id/scheme`, `/exam/:id/grade`     |

The shared header, typography, lavender canvas, semantic score colours, tables, comparison panels and mobile layouts now follow the references. The question check retains the original PDF and its current page when saving edits. Merging preserves other unsaved question drafts. Scheme approval depends on mark totals, individual answers and evaluation rules. Trial review opens in another tab so the batch remains available; adding PDFs retains the existing queue.

Report actions use real navigation, print/download, copy-link and release-gated acknowledgment. Teacher edits save marks/comments together and rebuild evaluated PDFs. Family headers stay within family reports. Follow-up groups and dates are explicitly browser-local drafts; they do not claim to send messages or assign homework. Attendance, other subjects and whole-syllabus coverage remain honest unavailable states when no source data exists. Current uploads accept PDFs; question-bank and external school integrations are not implemented.

## Verification

- Frontend production build and backend TypeScript check pass.
- All 66 backend tests pass, including mark invariants, merging/mapping, release gates, atomic mark edits, updated PDF artifacts and teacher rules.
- Desktop (1440px) and mobile (390px) browser checks pass for setup, teacher analysis/matrix, answer review, student report and parent guide. No JavaScript errors or page-wide horizontal overflow in checked screens.
- Browser interaction checks cover merge/draft preservation, normalization, save errors and retries, in-flight edit locking, answer/rule approval, upload gating, matrix filters/group persistence, question navigation, zoom, comments, acknowledgment and release errors.
- Live clear-paper answer review keeps the scanned page beside Q5 feedback, exposes the pending independent check, blocks release, and serves both original/evaluated PDFs.
- `output/verification/ui/` contains live screenshots and clearly named fixture screenshots for released reports. Report fixture checks did not alter real student records.

## Clear-paper marking test

Source: `output/443abab5-a2b9-47b8-9726-c05b01559f08--aarav-gupta--1790185683/pages`.

Verification draft exam: `d1c4ec6d-e40c-4610-864d-7dc5c815584f`.

Review: http://localhost:5190/review/d1c4ec6d-e40c-4610-864d-7dc5c815584f--aarav-gupta-clear-scan--1790188301349

Used all three original PNGs byte-for-byte and the existing cached blocks; no new extraction/OCR calls. Source scans, cached blocks and source exam hashes remain unchanged. Only a separate draft exam/result was created. The draft combines Q1 and Q5 subparts and retains the 20-mark total.

| Question | Draft marks |
| -------- | ----------- |
| 1        | 3.2 / 4     |
| 2        | 0 / 1.6     |
| 3        | 2.4 / 2.4   |
| 4        | 1.6 / 2.4   |
| 5        | 8.8 / 9.6   |
| Total    | 16 / 20     |

Q1 now credits four of five blanks, confirming the earlier mapping correction. The configured second provider was unavailable on Q5. This exposed a fallback that discarded a completed first grading pass. The pipeline now preserves available marks/evidence and requires teacher review if the independent check fails; a regression test covers this. Q5 was regraded once from the same cached answer/scans to recover its first-pass score. The result remains a draft with every question flagged and no release.

Detailed evidence: the run's `verification.json`, `source-integrity.json`, `q5-first-pass.json`, and `evaluation.json`; recovery log at `output/verification/q5-recovery.log`. Verification `.mts` scripts invoke live grading and are not part of the offline test suite.
