# Copy-check productization — how to test end-to-end

Branch: `feat/copy-check-productization`

## Prereqs

```bash
cd backend
pnpm install                         # already run; deps: sharp, pdf-lib, @google/generative-ai, @anthropic-ai/sdk, groq-sdk, google-auth-library
pnpm db:ensure:copy-check            # creates 5 tables + 3 enums (idempotent, safe to re-run)
```

Optional but recommended for auto-detect fuzzy matching:

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;
```

Env vars (backend `.env`):

- `GEMINI_API_KEY` and/or `OPENAI_API_KEY` (at least one — provider cascade)
- `ANTHROPIC_API_KEY`, `GROQ_API_KEY` (optional fallbacks)
- `WHATSAPP_API_KEY` + `WHATSAPP_SENDER_PHONE` (optional — WhatsApp arm of parent notifications)

## Backend endpoints (`/v1/copy-check/*`)

Exam authoring (teacher/admin):

- `POST /v1/copy-check/exam/generate` — multipart `paper` PDF + form fields (sourceType, title, subject, classLabel, totalMarks, optional sourceId)
- `PATCH /v1/copy-check/exam/:id` — edit rubric/tags/marks before approval
- `POST /v1/copy-check/exam/:id/approve` — lock scheme (R1 gate)
- `GET /v1/copy-check/exam/list` — list all copy-check exams for the tenant

Grading:

- `POST /v1/copy-check/exam/:id/grade` — single PDF (multipart `pdf` + optional `studentProfileId`)
- `POST /v1/copy-check/exam/:id/grade-batch` — N PDFs (multipart `files[]` + optional `body` JSON with `overrides[]`). Auto-detects each student.
- `POST /v1/copy-check/run/:runId/re-detect-student` — teacher override

Reads:

- `GET /v1/copy-check/run/:runId` — teacher full view
- `GET /v1/copy-check/run/:runId/student` — release-gated slim view (student/parent)
- `POST /v1/copy-check/run/:runId/release` — manual release for assignment + formal exam
- `GET /v1/copy-check/exam/:id/runs` — teacher grading dashboard
- `GET /v1/copy-check/student/:studentProfileId/runs` — student history + parent list

## Per-assessment submit-scanned routes (mounted on existing routes)

Auto-release (prep/quick/class test):

- `POST /v1/class-tests/:id/submit-scanned`
- `POST /v1/chapter-test/:id/submit-scanned` (prep tests)
- `POST /v1/quick-test/:id/submit-scanned`

Teacher-gated release (unchanged for assignment; same gate for formal exam):

- `POST /v1/student-assignments/:id/submit-scanned`
- `POST /v1/exams/:id/submit-scanned`

## Frontend routes

**Student portal** (`frontend/`):

- `/dashboard/handwritten-review/:runId` — polling + StudentReport view

**Teacher app** (`teacher-app/`):

- `/dashboard/check-papers` — list of copy-check exams
- `/dashboard/check-papers/:examId/upload` — batch upload + auto-detect + evaluate
- `/dashboard/check-papers/:examId/runs/:runId` — per-run review + release + reassign

**Parent app** (`parent-app/`):

- `/results/detail/:runId` — StudentReport + WhatsApp share (formal exam)

## End-to-end smoke tests

### 1. Teacher direct-check (Workflow B)

1. `POST /v1/copy-check/exam/generate` with a printed question paper PDF and `sourceType: 'direct_check'`.
2. Optionally `PATCH /v1/copy-check/exam/:id` to edit rubrics.
3. `POST /v1/copy-check/exam/:id/approve`.
4. Open teacher app → `/dashboard/check-papers` → upload 3 student PDFs.
5. Verify auto-detected students; correct any wrong ones.
6. Click Evaluate → per-run review pages load with `StudentReport`.
7. For assignment/formal-exam types, click "Release to student + parent".

### 2. Student assign-to-students (Workflow A)

1. Existing teacher class-test creation flow needs the AI-grading toggle wired (Step 20 — deferred). For now, manually create a class test, then `POST /v1/copy-check/exam/generate` with `sourceType: 'class_test'` + `sourceId: <class_test_id>` to link it.
2. Student takes the test → opens the "Upload handwritten answer" panel (`SubmitScannedPanel`, wire into `ClassTestTakePage` — the panel exists at `frontend/src/copy-check/SubmitScannedPanel.tsx`, needs 1 line of import + JSX in each test-take page).
3. Student captures/uploads pages → `POST /v1/class-tests/:id/submit-scanned` → runId returned.
4. Auto-release fires → parent FCM push + WhatsApp text sent.
5. Parent taps notification → `/results/detail/:runId` opens showing StudentReport.

### 3. Verify parent WhatsApp arm

Requires `WHATSAPP_API_KEY` set + parent has a `phoneNumber` on their `parent_profiles` row.

- Backend: `services/copy-check-notifications.service.ts` → `sendCopyCheckReleaseNotification(runId)` fires on release. Check console for `copy-check.notify WhatsApp send to <phone>` logs. FCM arm always fires; WhatsApp arm is best-effort.

## What's done vs deferred

| #     | Step                                      | Status                                                                                                                     |
| ----- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 1     | Backend library lift                      | ✅ done                                                                                                                    |
| 2     | Postgres schema                           | ✅ done                                                                                                                    |
| 3     | Core routes                               | ✅ done                                                                                                                    |
| 4     | S3 artifacts                              | ⏸ deferred (DB source of truth today)                                                                                      |
| 5     | Student auto-detect                       | ✅ done                                                                                                                    |
| 6     | grade-batch                               | ✅ done                                                                                                                    |
| 7     | Teacher Check Papers section              | ✅ done                                                                                                                    |
| 8     | POC teacher pages                         | ✅ done (subset)                                                                                                           |
| 9     | Student ScannedAnswerSubmit               | ✅ done                                                                                                                    |
| 10    | Student review/report pages               | ✅ done                                                                                                                    |
| 11-14 | Per-type submit-scanned backend           | ✅ done; frontend panel exists — wire into existing take pages by adding `<SubmitScannedPanel submitPath="..." />` in each |
| 15    | Auto-release for class/prep/quick         | ✅ done                                                                                                                    |
| 16    | Parent FCM + WhatsApp                     | ✅ done                                                                                                                    |
| 17    | Parent ResultsPage extension              | ✅ done — "AI-graded assessments" section under existing exam cards, taps into `/results/detail/:runId`                    |
| 18    | Parent ResultsDetailPage                  | ✅ done                                                                                                                    |
| 19    | Parent WhatsApp share                     | ✅ done                                                                                                                    |
| 20    | Teacher AI-grading toggle in create pages | ✅ done for **class test** (ClassTestReviewPage); ⏸ CreateAssignmentPage + ExamDetailsPage use the same pattern            |
| 21    | Teacher photo + manual create modes       | ⏸ deferred (existing PDF upload works today)                                                                               |
| 22    | Formal-exam certificate PDF               | ✅ done — `services/copy-check-certificate.service.ts` renders A4 PDF via pdfkit                                           |
| 23    | Exam-timetable ↔ copy-check link          | ✅ done — timetable card shows "Submit your answer sheet" CTA once exam date has passed                                    |
| 24    | Deprecate copy-check-poc/                 | ⏸ deferred until v1 in production                                                                                          |

## Commits (feat/copy-check-productization)

```
c6b67411 step 1 - lift backend services
830e315e step 2 - drizzle schema + ensureCopyCheck.ts
4338c9ff step 3 - /v1/copy-check routes + service + WhatsApp plan
10355926 steps 5+6+16 - auto-detect, grade-batch, FCM + WhatsApp
<pending> steps 9+10+11-14 - student scan submit + review page + per-type routes
<pending> steps 7-8 + 17-18 - teacher check-papers + parent results detail
<pending> list-exams endpoint + this test guide
```
