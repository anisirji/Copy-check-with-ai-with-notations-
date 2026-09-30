# Copy-Check POC

Reference implementation of the architecture in
[../COPY_CHECKING_ARCHITECTURE.md](../COPY_CHECKING_ARCHITECTURE.md).
Reference for expected annotated output: [../../test123](../../test123).

## What it does

**Phase 1 — paper-in, exam-out.** Teacher uploads a question paper PDF.
The system extracts questions, generates a model answer per question, and
generates a rubric per question. Teacher reviews/edits in the UI and saves.

**Phase 2 — grade student sheets.** Upload a student PDF + the exam config.
The system runs the full 12-stage pipeline and produces an annotated PDF +
a rubric-level teacher review view.

## Multi-LLM cascade (with family diversity)

Every LLM call goes through a provider registry. On any 5xx/429/timeout the
cascade walks to the next configured provider. Grader B is enforced to come
from a **different family** than grader A (arch doc: prevents anchoring).

| Stage                             | Preferred cascade                                          |
| --------------------------------- | ---------------------------------------------------------- |
| Vision extraction (primary)       | Gemini → OpenAI → Anthropic → Groq                         |
| Vision second opinion (consensus) | Anthropic → OpenAI → Gemini → Groq                         |
| Grader A                          | Anthropic → Gemini → OpenAI → Groq                         |
| Grader B                          | OpenAI → Anthropic → Gemini → Groq _(family ≠ A enforced)_ |
| Validator                         | Anthropic → OpenAI → Gemini → Groq                         |
| Rubric / model-answer generation  | Anthropic → OpenAI → Gemini → Groq                         |
| Question extraction (paper-in)    | Anthropic → Gemini → OpenAI → Groq                         |

Specialised OCR (fire when relevant):

|                         | When it fires                                                              | Fallback if unavailable   |
| ----------------------- | -------------------------------------------------------------------------- | ------------------------- |
| **Mathpix**             | Any block classified as `equation` on a math/physics/chemistry question    | VLM's OCR of the equation |
| **Google Cloud Vision** | When two VLMs disagree on a specific crop (coordinate-precise word bboxes) | Primary VLM's bbox        |

## Setup

```bash
cd copy-check-poc
cp .env.example .env
# Fill in at least one LLM key (Anthropic recommended). See .env.example for details.

pnpm install
pnpm dev           # backend on :8090, frontend on :5190
# OR one-shot pipeline on the bundled chemistry sample:
pnpm example
```

- Backend → http://localhost:8090
- Frontend → http://localhost:5190

## API keys

Set **at least one** LLM key. All others are optional but each one you add
extends the cascade.

| Env var                                                           | Role                                              | Get key                              |
| ----------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------ |
| `ANTHROPIC_API_KEY`                                               | grader A, validator, rubric gen (highest quality) | https://console.anthropic.com        |
| `GEMINI_API_KEY`                                                  | vision extraction (bbox-native)                   | https://aistudio.google.com/apikey   |
| `OPENAI_API_KEY`                                                  | grader B, vision fallback                         | https://platform.openai.com/api-keys |
| `GROQ_API_KEY`                                                    | emergency fallback (Llama-4 Scout, very fast)     | https://console.groq.com/keys        |
| `MATHPIX_APP_ID` + `MATHPIX_APP_KEY`                              | STEM equation OCR (recommended)                   | https://accounts.mathpix.com/ocr-api |
| Google Cloud Vision — pick one:                                   | coordinate-precise fallback                       | https://console.cloud.google.com     |
| &nbsp;&nbsp;→ _(easiest)_ `gcloud auth application-default login` | _local dev only_                                  |                                      |
| &nbsp;&nbsp;→ `GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa.json`   |                                                   |                                      |
| &nbsp;&nbsp;→ `GOOGLE_CLOUD_VISION_CREDENTIALS={...sa json...}`   | _for hosts without filesystem_                    |                                      |

## Backend pipeline modules (backend/src/services/)

| Module          | Input                     | Output                                                               |
| --------------- | ------------------------- | -------------------------------------------------------------------- |
| `preprocess.ts` | PDF                       | page PNGs + dimensions (via `pdftoppm`)                              |
| `quality.ts`    | page PNG                  | `{ blur, brightness, contrast, acceptable }`                         |
| `vision.ts`     | page PNG                  | blocks `[{ type, text, bbox: 0..1 }]` (cascade + optional consensus) |
| `mathpix.ts`    | equation-typed blocks     | LaTeX replaces raw text                                              |
| `mapper.ts`     | blocks + exam             | `Q# → blockIds`                                                      |
| `semantic.ts`   | blocks + question         | `{ concepts, equations, steps, diagrams }`                           |
| `grader.ts`     | question + rubric + image | `RubricEval[]` per grader (A or B)                                   |
| `consensus.ts`  | grader A + B + validator  | merged `QuestionGrading` + confidence route                          |
| `annotator.ts`  | grading result            | annotations `[{ type, bbox/xy, text }]`                              |
| `renderer.ts`   | page + annotations        | annotated PNG (SVG overlay) + final PDF                              |
| `analytics.ts`  | grading result            | weakest concepts, automation rate                                    |

Phase 1 orchestration:

| Module                | Input                     | Output                              |
| --------------------- | ------------------------- | ----------------------------------- |
| `paper-extractor.ts`  | question paper PDF        | `ExtractedQuestion[]`               |
| `model-answer.ts`     | question                  | ideal model answer string           |
| `rubric-generator.ts` | question (+ model answer) | rubric criteria with sum-validation |
| `exam-builder.ts`     | paper PDF + meta          | full `ExamConfig`                   |

## Routes

```
GET  /health                     → { ok: true }
GET  /exam/providers             → { configured: [{ name, family }] }
POST /exam/generate              → paper-in exam-out
POST /exam/:id/merge-questions   → merge sibling subparts into their parent
POST /exam/:id/normalize-marks   → proportionally scale question and rubric marks
POST /exam/:id/approve          → validate marks and teacher-confirmed tags
POST /dev/regrade/:runId         → fresh unreleased result using cached OCR blocks
POST /grade                      → student sheet in, evaluation.json + evaluated.pdf out
GET  /run/:runId                 → fetch a run's evaluation.json
PATCH /run/:runId/grading        → teacher overrides
GET  /output/:runId/...          → static access to page PNGs + PDFs
```

## Reviewing extracted questions

If a teacher supplies a total, it remains the exam total while extracted question
allocations remain visible for comparison with the paper. A mismatch blocks
approval and grading. Correct extraction errors in **Confirm questions**;
proportional normalization is available as an explicit action, not applied
automatically. Normalization uses hundredths with rounding distributed so the
total stays exact. Model answers and rubrics receive the class context, and the
rubric is generated after its model answer so their accepted representations agree.

In **Confirm questions**, select sibling subparts and choose **Merge selected**.
The merged question keeps labelled prompts, model answers, rubric criteria,
and original question IDs for answer mapping. Review its tags again. Its marks
default to the sum of the selected parts and can be adjusted before merging.

Existing drafts with mismatched totals can be repaired with **Normalize marks**
or individual mark edits. Question marks must add up to the exam total, and
each rubric must add up to its question maximum before approval or grading.
Changes to an approved scheme require approval again.

Cached regrading requires an approved, consistent scheme and valid
`blocks.json`. It creates a separate result and preserves the original run.
It skips vision extraction and Mathpix, but still makes grading API calls.

```bash
pnpm --dir backend test
pnpm --dir backend type-check
pnpm --dir frontend build
```

## Pipeline outputs (per run)

```
output/{runId}/
  pages/                   raw page PNGs from PDF
  blocks.json              vision extraction (cached — re-runs skip vision)
  mapping.json             question → block ids
  page-N-annotated.png     SVG overlay composited onto original
  original.pdf             the student's uploaded PDF
  evaluation.json          full result: grading, analytics, annotations, provider audit
  evaluated.pdf            all annotated pages combined
```

### File storage and review-media access

The backend serializes mutations per record within one Node process and atomically replaces persisted JSON. Do not run multiple backend workers against these file stores; use shared transactional storage for that deployment.

`/output` serves an explicit set of review PNG/PDF assets. Evaluation JSON, OCR blocks, audit logs and other output files are not static assets. The existing teacher APIs remain for a trusted local POC; the release workflow is not a teacher authentication system.

See [REVIEW_FIXES.md](REVIEW_FIXES.md) for the deep-review resolutions and regression coverage.
