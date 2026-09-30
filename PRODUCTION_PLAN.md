# Plan — Productize copy-check into Scholiphi (student + teacher + parent apps)

**Final plan file will live at:** `/Users/ani/Desktop/scholiphi/copy-check-poc/PRODUCTION_PLAN.md` (copied there on the first implementation step after ExitPlanMode).

---

## 1. Context

The [copy-check-poc/](../../Desktop/scholiphi/copy-check-poc/) has a working handwritten-answer-sheet grading pipeline proven on a chemistry paper (16/20 released). Pipeline: vision → reconcile → normalize → map → semantic → grade → review card + KaTeX rendering + verdict filtering.

We now need to productize this into the main Scholiphi apps across 5 assessment types, two teacher workflows, per-type result distribution, parent-app delivery, and honor the 4 report/review UI designs already in the POC.

## 2. All decisions locked

| Decision                                    | Value                                                                                                               |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Scope                                       | Production release — all 5 assessment types (class test, prep test, quick test, exam, assignment) go live together  |
| Storage                                     | Postgres/Drizzle from day 1; S3 for run artifacts                                                                   |
| Auto-release                                | **Yes** for prep/quick/class test; **No** for assignment (teacher-gated, unchanged) and formal exam (teacher-gated) |
| Student capture modes                       | Camera (Capacitor), PDF upload, Gallery import — all three                                                          |
| Student-to-PDF match (teacher direct-check) | AI auto-detects student from paper header + teacher override dropdown                                               |
| Teacher test-creation modes                 | Upload PDF, photo/scan, AI prompt, manual entry — all four                                                          |
| Certificate trigger (formal exam)           | Auto on teacher release → server-renders PDF → FCM push to parents with share-ready link + WhatsApp deeplink        |
| Copy-check backend location                 | Inside main scholiphi backend, `backend/src/services/copy-check/` (same process, same auth middleware)              |
| Report UI mapping                           | See §5                                                                                                              |

## 3. Assessment types in scope

| #   | Type        | Student page                               | Release gate            | Certificate             | Parent channel                                 |
| --- | ----------- | ------------------------------------------ | ----------------------- | ----------------------- | ---------------------------------------------- |
| 1   | Class Test  | `frontend/src/pages/class-test/`           | auto                    | —                       | Extend `/class-tests` in parent app + FCM push |
| 2   | Prep Test   | `frontend/src/pages/prep-test/`            | auto                    | —                       | Extend `/results` in parent app + FCM push     |
| 3   | Quick Test  | `frontend/src/pages/dashboard/quick-test/` | auto                    | —                       | Extend `/results` in parent app + FCM push     |
| 4   | Formal Exam | `frontend/src/pages/exam-page/`            | teacher                 | ✅ parent-shareable PDF | FCM push + WhatsApp share                      |
| 5   | Assignment  | `frontend/src/pages/asignments/`           | **teacher (unchanged)** | —                       | Extend `/results` + FCM push                   |

**Not in scope:** Chapter Test (MCQ only), Live Activity (real-time MCQ), AI Tutor, Timetable views.

## 4. Two teacher workflows

- **Workflow A — Assign-to-students**: teacher creates test (via any of 4 create modes) → chains through copy-check ConfirmQuestions + ApproveScheme → assigns to class → students see it, submit photos/PDFs → pipeline evaluates → auto-release (or teacher release for assignment/exam) → parent FCM push.
- **Workflow B — Direct-check ("Check Papers" section, new in teacher app)**: teacher uploads batch of student PDFs → AI auto-detects student from paper header → teacher overrides if wrong → batch evaluate → review each in AnswerReview UI. No student portal involvement.

## 5. Report / review UI mapping

| POC component (source design PDF)                                        | teacher-app  | student portal               | parent app                   |
| ------------------------------------------------------------------------ | ------------ | ---------------------------- | ---------------------------- |
| `TestAnalysis.tsx` (Teacher — test analysis)                             | ✅           | —                            | —                            |
| `ClassMatrix.tsx` (Teacher — class matrix + follow-up)                   | ✅           | —                            | —                            |
| `StudentReport.tsx` (Student & parent — individual report)               | —            | ✅                           | ✅ (same layout)             |
| `AnswerReview.tsx` + `ReviewCard.tsx` (Answer review — paper + feedback) | ✅ full edit | ✅ read-only (release-gated) | ✅ read-only (release-gated) |
| `AnnotationOverlay.tsx`                                                  | ✅           | ✅                           | ✅                           |

## 6. Backend architecture

- **Lift services** from `copy-check-poc/backend/src/services/*` → `backend/src/services/copy-check/*`. Native deps already available in scholiphi backend Docker image (sharp, pdf-lib, poppler pdftoppm). Provider registry piggy-backs on POC's `providers/` folder for now.
- **Postgres schema** — new tables in `backend/src/db/schema/copy-check.ts`:
  - `copy_check_exams` — id (uuid pk), source_type ('class_test'|'prep_test'|'quick_test'|'exam'|'assignment'), source_id (fk to that type's own table), school_id, config JSONB (ExamConfig), approval JSONB, marks_normalization JSONB, timestamps.
  - `copy_check_runs` — id (run_id, uuid), exam_id fk, student_id fk (nullable for anon direct-check), original_pdf_s3_key, evaluation JSONB (PipelineResult slim), released_at, released_by, teacher_notes, source_type.
  - `copy_check_run_artifacts` — run_id fk + s3_key + type ('page_png'|'annotated_pdf'|'evaluated_pdf'|'overlay_svg').
  - `copy_check_history` — student_id fk + run_id fk + percentage + released_at (append-only, feeds cross-test deltas).
  - `copy_check_link` — junction: `source_type` + `source_id` → `copy_check_exam_id`.
- **S3 layout**: `copy-check/{school_id}/exams/{examId}/paper.pdf`, `copy-check/{school_id}/runs/{runId}/{original,annotated,evaluated}.pdf`, `copy-check/{school_id}/runs/{runId}/pages/*.png`. Presigned URLs to frontend.
- **New routes** namespaced under `/v1/copy-check/`:
  - `POST /v1/copy-check/exam/generate` — paper PDF + meta → exam config (async job returns jobId).
  - `POST /v1/copy-check/exam/:id/approve` — R1 gate.
  - `POST /v1/copy-check/exam/:id/grade` — studentId + PDF/photos → runId (async).
  - `POST /v1/copy-check/exam/:id/grade-batch` — N PDFs; returns array of `{pdfIndex, detectedStudent, confidence, runId}`.
  - `GET /v1/copy-check/run/:runId` — teacher full view.
  - `GET /v1/copy-check/run/:runId/student` — read-only slim (release-gated).
  - `POST /v1/copy-check/run/:runId/release` — manual (assignment + exam); auto-fired for prep/quick/class test on pipeline complete.
  - `POST /v1/copy-check/run/:runId/re-detect-student` — teacher override.
  - `GET /v1/copy-check/run/:runId/certificate.pdf` — formal exam only.
  - `GET /v1/copy-check/exam/:id/report`, `/matrix`, `/students`.
- **Per-type route extensions** — each of `class-test`, `prep-test`, `quick-test`, `exam`, `student-assignment` gains `POST /:id/submit-scanned` variant that:
  1. Uploads PDFs/photos to S3.
  2. Calls copy-check `/grade`.
  3. Attaches `runId` back to submission row.
  4. **Auto-release** for class/prep/quick; **no auto-release** for assignment + exam.
- **Parent notification hook** (in `backend/src/services/notifications.service.ts`): `sendCopyCheckReleaseNotification(runId)` — resolves student → parents → FCM push with `data.url = /results/detail/{runId}?child={studentId}`.

## 7. Student portal (`frontend/`)

- **New shared component** `frontend/src/components/scanned-answer/`:
  - `ScannedAnswerSubmit.tsx` — 3 capture modes: Capacitor Camera, file picker (PDF/images), gallery import. Preview thumbnails, drag-to-reorder, delete, crop.
  - `PhotoSequenceEditor.tsx` — reorder / rotate / crop per page.
  - `EvaluationStatus.tsx` — polls `/v1/copy-check/run/:runId` every 5s. Shows stages (uploading → extracting → grading → complete) → routes to result page.
- **New pages**:
  - `frontend/src/pages/handwritten-review/HandwrittenReviewPage.tsx` — wraps `ReviewCard` for student read-only display (from `/run/:runId/student`).
  - `frontend/src/pages/handwritten-report/HandwrittenReportPage.tsx` — wraps `StudentReport` for individual report card. Same layout as parent app.
- **Existing pages get scan-submit CTA**:
  - `ClassTestTakePage.tsx` — add scanned-answer alongside existing MCQ / text.
  - `PrepTestPage.tsx` / `QuickTestTakePage.tsx` — same.
  - `ExamPage.tsx` — currently info-only; add "Submit answer sheet" CTA (visible after `startTime`).
  - `AsignmentDetailPage.tsx` + `HomeworkAttachmentDrawer.tsx` — replace existing upload with shared `ScannedAnswerSubmit`; unchanged release logic.
- Each test-type history page (prep/quick/class) gains a "Handwritten submissions" tab.
- Copy from POC into `frontend/src/lib/copy-check-types.ts`: `QuestionGrading, QuestionReview, StudentAnswerPayload, PipelineResult, ExamConfig` (student-safe subset).
- Copy from POC into `frontend/src/components/copy-check/`: `ReviewCard.tsx, AnnotationOverlay.tsx, MathText.tsx`.

## 8. Teacher app (`teacher-app/`)

- **New section** `teacher-app/src/pages/check-papers/`:
  - `CheckPapersListPage.tsx` — lists copy-check exams with linked source type + submission counts.
  - `CheckPapersUploadPage.tsx` — batch upload, per-PDF auto-detected student + confidence + override dropdown, submit-all triggers `grade-batch`.
  - `CheckPapersReviewPage.tsx` — routes to `AnswerReview` per student.
- **Copy POC pages** into `teacher-app/src/pages/copy-check/`:
  - `AnswerReview.tsx, ClassMatrix.tsx, TestAnalysis.tsx, ConfirmQuestions.tsx, ApproveScheme.tsx, ExamList.tsx`.
  - `ReviewCard.tsx, AnnotationOverlay.tsx` → `teacher-app/src/components/copy-check/`.
- **Extend existing test-creation pages**:
  - `ClassTestCreatePage.tsx` — "AI grading enabled" toggle. When on: after questions generated, run copy-check `POST /exam/generate` on the assembled paper → route through `ConfirmQuestions` + `ApproveScheme` → link `class_tests.id` → `copy_check_exams.id`.
  - `CreateAssignmentPage.tsx` — same toggle.
  - `ExamDetailsPage.tsx` — same toggle.
- **New test-creation modes** for teachers:
  - Photo / scan (Capacitor Camera) — new capture flow → same paper-extract pipeline.
  - Manual entry — new form: type each question + marks + rubric + acceptable answers. Skips paper-extract, goes directly to ApproveScheme.
- **Certificate generator** (formal exam only): server-side PDF render of `StudentReport.tsx` via existing Puppeteer helper (or Playwright). Endpoint `GET /v1/copy-check/run/:runId/certificate.pdf`.

## 9. Parent app (`parent-app/`)

- **Extend** `parent-app/src/pages/results/ResultsPage.tsx`:
  - Merge copy-check runs into per-exam list (source: `GET /v1/copy-check/parent/:parentId/runs?child=:studentId`).
- **New page** `parent-app/src/pages/results/ResultsDetailPage.tsx` at `/results/detail/:runId`:
  - Renders `StudentReport` layout (same component as student portal).
  - Sub-tabs: Overview (report card) + Answer review (per-question, expandable `ReviewCard`).
  - Read-only, source: `/run/:runId/student`.
- **Extend** `parent-app/src/pages/class-tests/ClassTestsPage.tsx` — per-test drill-in exposes "Review answers" CTA when `copyCheckRunId` present.
- **Reuse** child selector pattern from `ExamTimetablePage.tsx:167-182`.
- **Notification wiring**: fire on release via two channels:
  1. Existing `POST /push/register` FCM stack. Notification type `RESULT`, `data.url = /results/detail/:runId?child=:studentId`. Existing `AppLayout.tsx:57-64` navigator handles routing.
  2. **Existing WhatsApp flow** (school_whatsapp_notification_configs — see `services/school-whatsapp-notification.service.ts`). Copy-check reuses the same template pipeline the school already uses for absent/fees/homework notifications. A new template `RESULT_RELEASED` sends "{{child}}'s {{exam}} — {{marks}}/{{max}}. Tap to view: {link}" to the parent's WhatsApp number pulled from `users.phoneNumber`. Fires only when the school has WhatsApp opt-in and the parent has a valid phone.
- **Share** (formal exam certificate): add `@capacitor/share` plugin. Share sheet with pre-filled text "{Child}'s {Exam} result — see attached" + PDF URL for WhatsApp/email.
- **Result page UI**: parent app's `/results/detail/:runId` renders the exact layout from the ~/Downloads "Student & parent view — individual report" PDF. That layout is already implemented in the POC's `StudentReport.tsx`; parent app imports that component verbatim so student portal and parent app show pixel-identical report cards. The "Answer review" sub-tab reuses `ReviewCard.tsx` (same read-only slim payload as the student portal).

## 10. Implementation steps (build + test one by one)

Each step is a shippable + testable unit of the production release. Test acceptance = a specific human action succeeds. The full 24-step sequence delivers the production system; nothing here is treated as MVP or throwaway.

### Foundation

**Step 1 — Backend copy-check library** — copy `copy-check-poc/backend/src/services/*` + `providers/*` into `backend/src/services/copy-check/` and `backend/src/services/copy-check/providers/`. Fix imports. `pnpm --filter backend build` + `pnpm --filter backend type-check` passes. **Test**: unit tests from POC pass in the main backend context (`pnpm --filter backend test`).

**Step 2 — Drizzle schema + migration** — add `copy_check_exams`, `copy_check_runs`, `copy_check_run_artifacts`, `copy_check_history`, `copy_check_link` tables. `pnpm db:generate` + `pnpm db:migrate` in dev DB succeeds. **Test**: `psql \dt copy_check_*` shows 5 tables; insert/select round-trip works.

**Step 3 — Core copy-check routes** — implement `/v1/copy-check/exam/generate`, `/exam/:id/approve`, `/exam/:id/grade`, `/run/:runId`, `/run/:runId/release`. Wire to DB. **Test**: from Postman/curl, generate exam from a sample PDF → approve → grade sample answer PDF → runId returned → GET returns full evaluation.

**Step 4 — S3 wiring for run artifacts** — replace POC's file-JSON storage with S3 puts for PDFs + PNGs. Presigned GET URLs served to clients. **Test**: after a grade run, S3 lists all expected keys under `copy-check/{school_id}/runs/{runId}/`.

**Step 5 — Student auto-detect helper** — new `backend/src/services/copy-check-student-detect.ts` reads the top of a scanned paper (Gemini vision) to extract name + roll → fuzzy match against class roster → returns `{studentId, confidence}` or null. **Test**: run against 3 scans (chemistry Aarav, biology mock, GK sample) — matches known students; unknown headers return null with confidence < 0.4.

### Teacher — direct-check flow (self-contained, ship first)

**Step 6 — Backend `grade-batch` endpoint** — accepts N PDFs, calls auto-detect per PDF, returns array `[{pdfIndex, detectedStudent, confidence, runId}]`. **Test**: upload 3 PDFs → returns 3 runIds + detected students.

**Step 7 — Teacher "Check Papers" section** — add `teacher-app/src/pages/check-papers/{CheckPapersListPage,CheckPapersUploadPage,CheckPapersReviewPage}.tsx`. Router entry `/check-papers`. **Test**: teacher opens `/check-papers`, sees exam list, opens one, uploads 3 PDFs, sees auto-detected students, corrects one, clicks "Evaluate all", waits, review pages load.

**Step 8 — Copy POC teacher pages** — `AnswerReview, ClassMatrix, TestAnalysis, ConfirmQuestions, ApproveScheme, ExamList` + `ReviewCard, AnnotationOverlay` into `teacher-app/src/pages/copy-check/` and `.../components/copy-check/`. Wire routes. **Test**: after Step 7 evaluate, `AnswerReview` renders correctly; class matrix + test analysis populate.

### Student portal — scan submit

**Step 9 — Shared scanned-answer components** — `frontend/src/components/scanned-answer/{ScannedAnswerSubmit,PhotoSequenceEditor,EvaluationStatus}.tsx`. Capacitor Camera + file picker + gallery. **Test**: on a demo page, all 3 capture modes produce a list of files, drag-reorder works, submit posts to a mock endpoint.

**Step 10 — Copy POC student components** — `ReviewCard, AnnotationOverlay, MathText, StudentReport` → `frontend/src/components/copy-check/` + `frontend/src/pages/handwritten-review/HandwrittenReviewPage.tsx` + `frontend/src/pages/handwritten-report/HandwrittenReportPage.tsx`. **Test**: navigate to `/handwritten-review/:runId` after a run — page renders read-only ReviewCard.

**Step 11 — Wire into ClassTestTakePage** — add "Upload handwritten answer" CTA. On submit → `POST /v1/class-tests/:id/submit-scanned` → polls `/run/:runId` → routes to `HandwrittenReviewPage`. **Test**: student takes class test, uploads scan, waits, sees review.

**Step 12 — Wire into PrepTestPage + QuickTestTakePage** — same pattern. **Test**: same as Step 11 for each type.

**Step 13 — Wire into ExamPage (formal)** — CTA visible after `startTime`. Same pattern but result stays hidden until teacher releases. **Test**: submit → status "Awaiting teacher release"; after teacher release, review appears.

**Step 14 — Wire into AsignmentDetailPage** — replace existing upload with `ScannedAnswerSubmit`. Pipeline auto-runs but does NOT auto-release. **Test**: submit → status "Awaiting teacher review" (unchanged existing message); teacher publishes → review appears.

### Auto-release + parent notification

**Step 15 — Auto-release hook** — in pipeline complete handler, if `source_type in (class_test, prep_test, quick_test)` call release automatically. **Test**: end-to-end for each type; released_at is set; `/run/:runId/student` returns 200.

**Step 16 — Parent FCM notification service** — new helper `sendCopyCheckReleaseNotification(runId)` fires FCM push to each parent of the student. Type: `RESULT`, `data.url = /results/detail/:runId?child=:studentId`. **Test**: fire against a test parent device → push arrives → tap opens the correct URL.

### Parent app

**Step 17 — Parent ResultsPage extensions** — merge copy-check runs into existing per-exam list. **Test**: parent opens `/results`, sees new copy-check run rows alongside legacy marks.

**Step 18 — Parent ResultsDetailPage** — new page at `/results/detail/:runId`. Renders `StudentReport` + expandable per-question `ReviewCard` from slim payload. **Test**: tap a run from `/results`, page opens showing report card + per-question review.

**Step 19 — Parent class-tests extension + WhatsApp share for certificate** — extend `/class-tests` per-test drill-in with "Review answers" link. Add `@capacitor/share` for formal-exam certificate. **Test**: parent taps "Share result" on a formal exam → share sheet opens → picks WhatsApp → message prefilled with PDF link.

### Teacher test creation

**Step 20 — Teacher AI grading toggle + chained rubric approval** — `ClassTestCreatePage.tsx`, `CreateAssignmentPage.tsx`, `ExamDetailsPage.tsx`: add "AI grading enabled" toggle. When on, chain through `ConfirmQuestions` + `ApproveScheme` and store linkage. **Test**: teacher creates a class test with toggle on, walks through the chain, publishes; students see it as a scan-submit test.

**Step 21 — Teacher photo-capture and manual-entry create modes** — new capture UIs on the create pages. Photo → same paper-extract pipeline; manual → direct to `ApproveScheme`. **Test**: teacher takes a photo of a paper question paper, extracts, approves. Separately teacher types a paper manually, approves. Both produce a valid exam.

### Formal exam certificate

**Step 22 — Server-rendered certificate PDF** — endpoint `GET /v1/copy-check/run/:runId/certificate.pdf` renders `StudentReport` layout via Puppeteer. Auto-fires on teacher release for formal exam. **Test**: release a formal exam run → PDF appears at endpoint → download opens correctly formatted single-page report.

### Timetable linkage (last)

**Step 23 — Exam-timetable ↔ copy-check exam link** — `exam-timetable` entries gain optional `copyCheckExamId`. Student `/exam-timetable` page shows "Submit answer sheet" CTA when past `startTime`. **Test**: teacher schedules an exam with a copy-check exam linked; student opens timetable, sees CTA, taps → routes to submit flow.

### Cleanup

**Step 24 — Deprecate copy-check-poc/** — remove standalone POC server + Vite app after all 5 test types are green. Keep `copy-check-poc/PRODUCTION_PLAN.md` + `copy-check-poc/test-cases/` for reference. **Test**: nothing outside `copy-check-poc/PRODUCTION_PLAN.md` and `copy-check-poc/test-cases/` remains.

## 11. Verification (end-to-end scenarios)

1. **Student takes class test with photo submission** → auto-release → parent gets FCM → parent opens `/results/detail/:runId` → sees report + per-question review.
2. **Teacher direct-check** — uploads 5 student PDFs → auto-detected → 1 override → all evaluate → `AnswerReview` per student + `ClassMatrix` populates.
3. **Formal exam** — teacher creates + approves → students submit → teacher releases → certificate PDF auto-generated → parent gets FCM → parent shares to WhatsApp.
4. **Assignment** — student submits scan → pipeline runs → teacher reviews (unchanged UI) → teacher publishes → parent sees + reviews.
5. **Regression** — Chapter Test MCQ auto-grade still works; Live Activity real-time quiz still works.
6. **Provider cascade** — kill Gemini key → OpenAI takes over → all 5 flows still work end-to-end.

## 12. Out of scope for this production release

Deferred to future work; not gating this launch:

- Batch grading of >100 papers concurrently (queue infrastructure).
- Multi-language OCR (Sanskrit paper works via generic vision; dedicated per-script models are a follow-up).
- Video/audio submissions.
- Adaptive difficulty engine.
- Anti-cheat / copy-detection between students.
