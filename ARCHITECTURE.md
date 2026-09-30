# Architecture — Copy-Check Reader + Grader

> **Status**: plan. This document is the constitution of the rewrite.
> Implementation follows this doc; when they disagree, the doc wins until
> amended here. Nothing in the current `backend/src/services/` tree matches
> this yet — it's the target, not the starting point.

## 0. What we are building

An engine that reads any K-12 paper (question paper, answer script,
marksheet, report card, attendance sheet — printed or handwritten, in
English, Hindi, Sanskrit, or mixed script) and turns it into typed JSON.
On top of that engine, a grading pipeline that evaluates a student's
handwritten answers against a teacher-approved rubric, produces an
annotated PDF, and generates reports for student, parent, and teacher.

Optimized for CBSE / Indian K-12. Anything global is a bonus, not a
constraint.

## 0.1 What we are NOT building

- A general-purpose document parser for RAG (Docling, LlamaParse, Reducto
  already exist and are excellent — we don't ship their format).
- A tutoring system (Khanmigo's territory). Grading only.
- A proctoring / anti-cheat system.
- A question bank.
- A replacement for teachers. The system escalates; the teacher decides.

---

## 1. The three-engine model

```
                        ┌──────────────────────────────────────────┐
                        │           PAPER READER (Engine A)         │
                        │                                           │
   pixels  ───────────► │  Stage 1: universal read                  │
                        │  Stage 2: paper-type detection            │
                        │  Stage 3: metadata extraction             │
                        │  Stage 4: fill type-specific schema       │
                        └──────────────────┬────────────────────────┘
                                           │
                                           ▼
                        typed Document { paperType, metadata, structured, raw }
                                           │
                        ┌──────────────────┼──────────────────┐
                        ▼                  ▼                  ▼
                ┌────────────────┐ ┌────────────────┐  (other consumers:
                │   ENGINE B     │ │   ENGINE C     │   marksheet loader,
                │   Question     │ │   Answer       │   report-card
                │   Extractor    │ │   Extractor    │   ingest, etc.)
                │                │ │                │
                │ Document →     │ │ Document +     │
                │ ExamConfig     │ │ ExamConfig →   │
                │                │ │ AnswerBlocks   │
                └───────┬────────┘ └───────┬────────┘
                        │                  │
                        │                  ▼
                        │          ┌────────────────┐
                        │          │   ENGINE D     │
                        │          │   Grader       │
                        └──────────┤                │
                                   │ per-criterion  │
                                   │ micro-grading  │
                                   │ + consensus    │
                                   │ + step-check   │
                                   │ + RAG          │
                                   └────────┬───────┘
                                            │
                                            ▼
                                    QuestionGrading[]
                                            │
                     ┌──────────────────────┼──────────────────────┐
                     ▼                      ▼                      ▼
             cross-script           ┌────────────────┐    ┌────────────────┐
             grouping               │   ENGINE E     │    │   ENGINE F     │
             (batch stage)          │   Annotator    │    │   Reporter     │
                                    │ (SVG overlay,  │    │ (student /     │
                                    │  deterministic)│    │  parent /      │
                                    └────────────────┘    │  teacher /     │
                                                          │  class views)  │
                                                          └────────────────┘
```

**Invariant**: pixels only touch Engine A. Every other engine consumes
typed JSON and is testable without images.

---

## 2. Engine A — Paper Reader

### 2.1 Contract

```ts
reader.read(pdf: Buffer, options?: {
  paperType?: 'auto' | KnownPaperType,   // skip detection if known
  hints?: {
    schoolBoard?: 'CBSE' | 'ICSE' | 'IB' | 'STATE',
    class?: number,
    subject?: string,
    expectedLanguage?: Array<'en' | 'hi' | 'sa'>,
    roster?: Array<{ rollNumber, name, class, section }>,
  },
}): Promise<ReaderOutput>

type ReaderOutput = {
  paperType: KnownPaperType,
  paperTypeConfidence: number,
  metadata: PaperMetadata,          // per-type shape, see §4
  structured: TypedStructuredView,  // per-type shape, see §3
  raw: Document,                    // universal element list (always present)
  warnings: Warning[],
}
```

Two call styles:

- **Auto mode** — reader detects paper type. Costs one small detection
  call + one extraction call. Default.
- **Directed mode** — caller passes `paperType`. Reader skips detection.
  Cheaper, faster, no misclassification risk. Use whenever the caller
  knows (teacher uploads from "Create exam" screen → `question_paper`;
  student answer submission → `answer_script`).

### 2.2 Internal pipeline (8 stages)

| # | Stage | What | Model / tech |
|---|---|---|---|
| 1 | **Normalise** | dewarp, deskew, denoise, split staples, 300+ dpi | `opencv` + `unpaper` |
| 2 | **Layout detection** | typed regions + bboxes + reading order | Docling RT-DETR (OSS) OR GCP Document AI Layout Parser v3.1 Flash Lite |
| 3 | **Paper-type detection** | classify into one of §3 types | Gemini 3 Pro Flash → **Jev Choice** (see §6) |
| 4 | **Metadata extraction** | fill the per-type metadata schema | Gemini 3 Pro (free-text) + **Jev** (bounded fields) |
| 5 | **Region routing** | tag each region: printed / handwritten / math / table / diagram / mcq_grid / roll_grid | small VLM classifier → **Jev Choice** |
| 6 | **Per-region typed extraction** | fill the type-specific structured schema | Gemini 3 Pro with `responseSchema` for free text + **Jev** for enum/scale/bool fields |
| 7 | **Math fallback** | re-OCR low-confidence MathBlocks | Mathpix (clean printed) — kept only if higher confidence than VLM |
| 8 | **Structural stitching + validate** | deterministic post-processor: question-number regex, column-aware reading order, container linking; then Zod validate | pure TypeScript, no model |

Cross-page continuation (long answers spanning multiple pages) runs
between stages 6 and 8 as a small VLM pass over the last block of page N
and the first block of page N+1.

### 2.3 The VLM + Jev split for structured output

**Rule**: fields with infinite value space go to the VLM; fields drawn
from a closed set (enum, ordered scale, boolean) go to Jev.

| Field type | Who emits | Example |
|---|---|---|
| Free text | VLM (Gemini 3 Pro) | `studentName`, `question.stemText`, `answer.transcription` |
| LaTeX | VLM / Mathpix | `math.latex` |
| Bboxes / coords | VLM (layout) | `element.bbox` |
| Enum | **Jev Choice** | `paperType`, `board`, `examType`, `question.kind` |
| Integer range | **Jev Choice** / **Jev Score** | `class` (1-12), `scanQuality` (1-5) |
| Boolean | **Jev Noul** | `hasHandwriting`, `hasDiagram` |
| Date | VLM raw → deterministic normalizer | `"03/06/2026"` → `"2026-06-03"` |
| Class numeral | VLM raw → deterministic normalizer | `"VIII"`, `"८"`, `"8th"` → `8` |

Why this matters: Jev is non-autoregressive, ~70-500 ms flat, and cannot
physically emit outside the enum. It also returns real calibrated
probabilities. That collapses two failure modes that plague pure-VLM
structured output: enum drift (`"answer sheet"` instead of `"answer_script"`)
and miscalibrated confidence.

Two prompts per page, not one. One for the VLM (narrow to free text).
One for Jev (bounded fields). Merged deterministically into the final
Document.

### 2.4 Multi-language handling

Only Gemini 3 Pro and Mistral OCR 4 have credible Devanagari **handwriting**
support in 2026. We default to Gemini 3 Pro.

- Store `langs: []` **per element**, not per document. Indian scripts
  routinely have English question + Hindi answer + Sanskrit śloka + math
  on one page.
- Reading order: never trust the model's bbox order for Devanagari — run
  a deterministic column-aware pass over bboxes so the shirorekha
  (baseline-hanging matra) doesn't confuse line grouping.
- Names: if only Devanagari is present, keep the original AND emit a
  transliteration. Both stored; never coerce.
- When the VLM disagrees with itself on script tag, keep both crops and
  mark `script: 'mixed'`. Do not force one.

---

## 3. Paper types & their schemas

The reader knows every type. Each type has its own `structured` schema.

### 3.1 The union

```ts
type KnownPaperType =
  | 'question_paper'
  | 'answer_script'
  | 'marksheet'
  | 'report_card'
  | 'rubric_document'
  | 'attendance_sheet'
  | 'worksheet'
  | 'other';
```

`'other'` never has `structured` — only `raw`.

### 3.2 `question_paper`

```ts
{
  meta: {
    title, board, class, subject,
    examName, examType, session,
    totalMarks, duration,
    instructions: string[],
    layoutSectionCount, hasChoice,
    languageMedium: 'en' | 'hi' | 'bilingual',
  },
  sections: Array<{
    label: 'A' | 'B' | ...,
    instructions?: string,
    marksPerQuestion?: number,
    questions: Question[],
  }>,
}

type Question =
  | { kind: 'mcq',              number, marks, stem, options: Array<{label, text|math}> }
  | { kind: 'true_false',       number, marks, statement }
  | { kind: 'fill_blank',       number, marks, stemWithBlanks[], expectedBlanks }
  | { kind: 'assertion_reason', number, marks, assertion, reason, options }
  | { kind: 'short_answer',     number, marks, stem, expectedWords? }
  | { kind: 'long_answer',      number, marks, stem, subParts?: Question[] }
  | { kind: 'match_columns',    number, marks, left[], right[] }
  | { kind: 'comprehension',    number, marks, passage, subQuestions: Question[] }
  | { kind: 'diagram_based',    number, marks, stem, diagramRef: FigureId };
```

### 3.3 `answer_script`

```ts
{
  meta: {
    student: { name, rollNumber, class, section, admissionNo? },
    exam:    { name, type, subject, date, startTime?, duration?, maxMarks? },
    school:  { name, board, logo? },
    bookletMeta: { totalPages, handwritingLang, invigilatorSig? },
  },
  perQuestionAnswers: Array<{
    questionNumber: '1' | '1(a)' | '3(b)(ii)',
    kind: 'mcq' | 'fill_blank' | 'short' | 'long' | 'diagram' | 'unattempted',
    content: AnswerContent,     // see below
    pageSpan: { start, end },
    evidenceBboxes: BBox[],
    confidence: number,
  }>,
  unmatchedInk: HandwritingBlock[],  // student wrote outside a numbered region
}

type AnswerContent =
  | { kind: 'mcq_choice',    selected: 'A'|'B'|'C'|'D', multipleMarked?: [] }
  | { kind: 'blank_filled',  values: string[] }
  | { kind: 'written',       text, mathBlocks[], diagrams[], corrections[] }
  | { kind: 'diagram',       crop, labels[], vlmDescription }
  | { kind: 'match_answered', pairs: Array<[leftIdx, rightIdx]> }
  | { kind: 'unattempted' };
```

### 3.4 `marksheet` / `report_card`

```ts
{
  meta: {
    student:     { name, rollNumber, class, section, admissionNo?, dob?, parentName? },
    school:      { name, board, address?, affiliationNumber?, logo? },
    period:      { term, session, dateIssued },
    authorities: {
      classTeacher: Field<{ name, signatureCrop }>?,
      principal:    Field<{ name, signatureCrop }>?,
      parent:       Field<{ name?, signatureCrop }>?,
    },
  },
  results: SubjectRow[],
  totals:  { obtained, max, percentage, grade, rank? },
  attendance?: { present, total, percentage },
}
```

### 3.5 `rubric_document`

```ts
{
  meta: { subject, class, forExam? },
  perQuestionRubric: Array<{
    questionNumber, maxMarks,
    criteria: Array<{ description, marks, acceptableAnswers? }>,
  }>,
}
```

### 3.6 `attendance_sheet`

```ts
{
  meta: { class, section, date, subject?, period?, teacher: Field<string> },
  entries: Array<{ rollNo, name, status: 'P' | 'A' | 'L' }>,
}
```

---

## 4. Metadata — auto-extract everything

Every field is `Field<T>`:

```ts
type Field<T> = {
  value: T | null,
  confidence: number,           // 0..1
  source: 'printed' | 'handwritten' | 'stamp' | 'mixed',
  bbox: BBox,
  rawText: string,              // the exact string the VLM saw
  variants?: Record<Lang, string>,   // for names in mixed scripts
  alternatives?: Array<{ value: T, confidence: number }>,
  missing?: true,               // field expected but not on the paper
  expectedLocation?: BBox,      // if missing, where the reader looked
};
```

### 4.1 Deterministic normalizers

The VLM emits the raw string; code turns it into a canonical value. Both
stored, never lose what was written.

| Raw | Normalized |
|---|---|
| `VIII`, `8th`, `Class 8`, `Grade 8`, `८` | `class: 8` |
| `03/06/2026`, `June 3, 2026`, `३ जून २०२६` | `date: '2026-06-03'` |
| `2 Hrs 30 Min`, `2:30`, `150 min` | `duration: 150` |
| `Half Yearly Exam`, `HY 2025-26` | `examType: 'half_yearly'` |
| `Roll No: 12`, `०१२` | `rollNumber: '12'` (string — leading zeros matter) |
| `AARAV GUPTA`, `आरव गुप्ता` | `name: 'Aarav Gupta'` + `variants: { en, hi }` |

Normalizers are pure functions, unit-tested against real CBSE variance.

### 4.2 Handwritten fields

Most CBSE answer scripts have a printed box the student fills in by
hand. The reader must:

- Recognize `field label (printed)` + `field value (handwritten)` as a pair.
- Return `source: 'handwritten'` so the UI knows to prioritize review.
- Preserve the raw crop URI for visual verification.

### 4.3 OMR-style roll-number grids

Digits are shaded, not written:

- Detect the grid layout (rows = digit position, cols = 0-9).
- Read shaded cell per column → assemble digit.
- Ambiguous shading → low confidence + preserve grid crop.
- Cross-check against printed digit above the grid if visible.

### 4.4 Roster cross-reference

If caller passes `hints.roster`:

- Fuzzy-match extracted `name + rollNumber` against roster (Levenshtein
  on name, exact on roll).
- If unique match: add `student.resolvedId`.
- If disagreement: emit `warnings: [{ code: 'name_roll_mismatch', ... }]`.
  **Never overwrite the raw extraction.** Roster match is layered
  metadata.

### 4.5 Confidence-driven UX

| Confidence | UI treatment |
|---|---|
| ≥ 0.9 | Show as extracted, no prompt |
| 0.6–0.9 | Show + "verify" chip; one-click confirm |
| < 0.6 | Show extracted + alternatives + raw crop; teacher picks or types |
| Missing | "Not found on paper" + point to `expectedLocation` crop |

**Nothing auto-fills invisibly.** A wrong name silently propagated is
the worst failure mode of an auto-reader.

---

## 5. Engine B — Question Extractor

**Contract**: `Document(question_paper) → ExamConfig(draft)`

**Pure function.** The reader already parsed. This just transforms:

1. Walk `structured.sections[].questions[]`.
2. For each `Question`, produce an `ExamQuestion` with `id`, `text`,
   `marks`, `type`, `subject`.
3. Validate: `sum(question marks) === totalMarks`. Fail loudly if not.

**Then two feeder LLM calls (cached, replayable):**

- **Rubric Generator** — per question, LLM produces a rubric (criteria +
  marks summing to question total), RAG-grounded against the NCERT
  chapter for the topic.
- **Model Answer Generator** — per question, LLM produces the ideal
  answer, RAG-grounded.

Both stored on the ExamConfig. Both regeneratable at teacher's request.

**HITL gate #1**: teacher reviews the ExamConfig — question text, marks,
model answer, rubric. Nothing grades until this passes.

---

## 6. Engine C — Answer Extractor

**Contract**: `Document(answer_script) + ExamConfig → AnswerBlocks[]`

```ts
type AnswerBlock = {
  questionId: string,
  elements: Element[],              // from Document
  transcript: string,               // concatenated text
  mathBlocks: MathBlock[],
  diagrams: Figure[],
  evidence: BBox[],
  confidence: number,
};
```

**Pure function.** Uses `QuestionMarker` and `AnswerMarker` elements
from the Document to bucket content per question:

1. Every `QuestionMarker` and `AnswerMarker` in the Document points to
   a question number.
2. Walk elements in reading order; the current marker's
   `refersToQuestion` decides the bucket.
3. `unmatchedInk` gets bucketed by nearest-neighbor question (with a
   warning flag).

Cross-page continuation is already handled by Engine A, so C never has
to "guess the answer keeps going."

---

## 7. Engine D — Grader

**Contract**: `AnswerBlock + ExamQuestion → QuestionGrading`

```ts
type QuestionGrading = {
  questionId: string,
  awardedMarks: number,
  maxMarks: number,
  rubricEvaluation: Array<{
    criterionId: string,
    marksAwarded: number,
    marksAvailable: number,
    verdict: 'correct' | 'partial' | 'incorrect' | 'missing',
    evidenceSpan: string,          // MUST be a substring of student's answer
    confidence: number,
  }>,
  stepEvaluation?: StepEval[],     // STEM only, see §7.3
  systemConfidence: number,
  route: 'auto_release' | 'teacher_review',
  needsTeacherReview: boolean,
  reviewReason?: NamedEscalation,  // never a bare 'low_confidence'
  auditTrail: LLMCall[],
};

type NamedEscalation =
  | 'grader_ab_disagreement'
  | 'empty_evidence_span'
  | 'step_check_unlabelled'
  | 'cluster_singleton'
  | 'validator_disagrees_with_both'
  | 'ocr_low_confidence'
  | 'unmatched_ink_present';
```

### 7.1 Per-criterion micro-grading (not holistic)

Each criterion is a separate LLM call — or one call with structured
output covering all criteria for one question. Each verdict requires:

- A `verdict` from `{correct, partial, incorrect, missing}`.
- An `evidenceSpan` — a substring of the student's answer that justifies
  the verdict. **Empty span → automatic escalation.**
- A `confidence` (0..1).

Forcing quoted evidence collapses the run-to-run variance that
"Rating Roulette" (EMNLP 2025 findings) documents in holistic scoring.

### 7.2 Family-diverse consensus (hard invariant)

- **Grader A**: Claude Opus 4.7 (best rubric reasoner).
- **Confidence gate**: skip Grader B iff every criterion of A has (a)
  non-empty evidence span AND (b) Jev Score of 4+ on evidence quality.
- **Grader B**: enforced non-Anthropic family — Gemini 3 Pro OR GPT-5.
  Build fails if the caller's config would allow same-family B.
- **Validator on disagreement**: third family reads only A's + B's
  evidence spans and picks. Cannot invent new evidence.

"Nine judges, two effective votes" shows same-family judges collapse to
one vote. Enforce diversity as a build-time invariant, not a runtime
preference.

### 7.3 Step-level process supervision (STEM)

For `math`, `physics`, `chemistry` questions:

- Separate LLM pass labels each derivation step:
  `correct | plausible-error | wrong`.
- Marks derived from step labels, not from the final answer.
- Catches "right answer, wrong reasoning" AND "wrong answer, right
  reasoning."

This is the pattern from Lightman et al., *Let's Verify Step by Step*
(OpenAI PRM800K) — the technique that made o1 work.

### 7.4 RAG grounding against NCERT

Every grader call receives:

- The teacher-approved model answer.
- The NCERT chapter snippet for the question's topic (retrieved by
  hybrid dense + BM25).

Grades against curriculum, not against LLM world knowledge. Kills the
"confidently wrong on curriculum-specific answers" failure.

### 7.5 Named escalation

`reviewReason` is always a named enum, never free text. This lets the
teacher UI say "A and B disagreed on criterion 2b" instead of "low
confidence."

---

## 8. Cross-script grouping (batch stage between D and E)

After D runs on all N students' answers to the same question:

1. Cluster near-identical answers per question (embedding cosine +
   evidence-span match).
2. Present clusters to the teacher in a Gradescope-style UI.
3. Teacher approves one grading per cluster; grading auto-applies to
   every script in the cluster.
4. Singleton clusters (an answer no-one else gave) go to individual
   review — a singleton is by definition unusual and needs a human.

This is Gradescope's actual moat and the single biggest accuracy
multiplier for a fixed exam. It also mechanically enforces within-batch
consistency.

---

## 9. Engine E — Annotator

**Contract**: `QuestionGrading + Document → SVG overlay per page + annotated PDF`

**Pure function, deterministic drawing.** LLM decided WHAT to annotate
(in D); this decides WHERE and HOW to draw.

Element types:

- Circled fraction / underline / wavy underline
- Margin comment box (anchored via leader line to `evidence.bbox`)
- Tick / cross / part-mark ("2/3")
- Redlines on incorrect steps (STEM)

All positions computed from `evidence: BBox[]` on `RubricEvaluation`.
**Never let an LLM output SVG coordinates.**

---

## 10. Engine F — Reporter

**Contract**: `QuestionGrading[] + ExamConfig → reports`

Multiple report types, all pure functions:

- **Student view** — annotated PDF + rubric-level explanation + weakest
  concepts.
- **Parent view** — same but softer language + "what to help with at
  home."
- **Teacher class view** — matrix of students × questions, weakest-
  concept heatmap.
- **Test analysis** — question difficulty, discrimination index, teach-
  again recommendations.

Same data, different projections. Reports are cheap: no LLM calls.

---

## 11. Cross-cutting layers

### 11.1 Provider registry

Every LLM / OCR / Jev call goes through:

```ts
registry.call({
  role: 'grader_a' | 'grader_b' | 'validator' | 'vision_primary'
      | 'vision_second_opinion' | 'metadata_extraction' | 'paper_type_detection'
      | 'step_supervision' | 'rubric_generation' | 'model_answer'
      | 'jev_classify' | 'jev_score' | 'jev_noul',
  avoidFamily?: 'anthropic' | 'openai' | 'google',
  familyMustBe?: string,          // hard requirement, throws if not available
  budget: { maxTokens, maxLatencyMs, maxCostCents },
  cache: { key, ttl },
})
```

Registry knows: each provider's family, its cascade order for that
role, its price, its p95 latency, its recent error rate. Cascade walks
on 5xx / 429 / timeout.

Every call logged with
`{ provider, family, model, promptHash, responseHash, tokens, cost, latency, role, runId }`
to an audit table. "Why did it grade this way" must be answerable
months later.

### 11.2 Jev decision layer

Jev (TypeSafe AI, https://docs.typesafe.ai/) is a non-autoregressive
decision model. Text-in, typed-value-out only. Three primitives:

- `Choice` — pick from enum
- `Score` — 1-5 ordered scale
- `Noul` — 0-1 yes/no with real probability

Used at every decision point where the answer is bounded:

| Decision | Primitive |
|---|---|
| Paper-type detection | `Choice` |
| Region type routing | `Choice` |
| Metadata field validation (e.g., is "12A" a plausible roll for class 8?) | `Noul` |
| Evidence-quality gate (skip Grader B?) | `Score` |
| Grader A/B disagreement resolution | `Choice` |
| Mistake type tagging | `Choice` |
| Cluster merge decision | `Noul` |
| Release-gate auto-approval | `Noul` |

Every Jev call ~200 ms, ~$0. Cannot physically emit outside the
declared set. Returns real calibrated probabilities.

### 11.3 Storage / cache

Two tiers:

- **Immutable** — original PDFs, page PNGs, reader `Document`s
  (canonical source of truth), raw grading outputs. Content-addressed
  by hash. Never mutated.
- **Mutable** — `ExamConfig` (teacher edits), `Grading` (teacher
  overrides), `Release` state. Versioned with actor + timestamp.

Regrade = fresh Grading run against the same immutable `Document`.
Cheap because reading is skipped.

### 11.4 HITL gates

Two explicit gates, both required:

1. **After Engine B + rubric generation** — teacher confirms questions,
   model answers, rubrics. Nothing grades until this passes.
2. **After Engine D + grouping** — teacher reviews:
   - Every cluster's grading.
   - Every named escalation.
   - A fixed % sample of the auto-approved rest.

Nothing releases until this passes. Teacher overrides feed a training
set — this is how the system improves.

---

## 12. Model & provider choices

| Role | Choice | Why |
|---|---|---|
| Layout pre-pass | Docling RT-DETR (OSS, self-host) OR GCP Document AI Layout Parser | Deterministic bboxes; cheaper than sending whole pages to a VLM |
| Vision primary | **Gemini 3 Pro** (Vertex AI) | Top OmniDocBench on exam papers + handwriting; native LaTeX + Devanagari + tables |
| Vision second opinion (consensus) | **Claude Opus 4.7 vision** — NOT another Gemini | Family diversity — same-family = one judge with two hats |
| Math specialist | Mathpix | Best on clean printed equations only; VLM wins on handwritten (Pensieve: 88% vs 55%) |
| Word-level bbox fallback | GCP Cloud Vision `DOCUMENT_TEXT_DETECTION` | Cheap word polygons when two VLMs disagree on a crop |
| Low-quality scan fallback | TrOCR (fine-tuned) or PaddleOCR | VLMs hallucinate on smudged scans; HTR degrades gracefully |
| Grader A | **Claude Opus 4.7** | Best rubric reasoner |
| Grader B | **Gemini 3 Pro** or **GPT-5** — enforced non-Anthropic | Family diversity |
| Validator | Third family (whichever A and B aren't) | Same reason |
| Step supervision (STEM) | Claude Opus 4.7 or GPT-5 (whichever isn't Grader A on that question) | PRM-style pass |
| Rubric / model answer | Claude Opus 4.7 | Cached, replayable, RAG-grounded |
| Emergency fallback | Groq (Llama-4 Scout) | Fast, cheap, last resort |
| Decision layer | **Jev** (TypeSafe AI) via Requesty | Non-autoregressive, calibrated, bounded outputs only |

### 12.1 What NOT to use as the reader

| Engine | Why not |
|---|---|
| Docling / LlamaParse / Reducto as output format | Excellent for RAG-over-PDF, but schemas are RAG-shaped (`Title / NarrativeText / Table`). No `McqOptionGroup`, no `QuestionMarker`, no `AnswerMarker`. Wrapping them means writing a lossy translator forever. Steal ideas, don't ship their format. |
| AWS Textract / Azure Document Intelligence | Wrong ontology (`KEY_VALUE_SET`, `LINE`, `WORD`), weak on Devanagari handwriting. |
| Pure end-to-end VLM (no layout pre-pass) | Fails on 15-page answer scripts (context + cost + bbox drift). Loses deterministic anchors for the annotator UI. |

---

## 13. Design principles

| Principle | Reason |
|---|---|
| **Content-first schema** | One reader interface handles any format because every format is just a different mix of the same elements |
| **Pixels only touch Engine A** | Everything else consumes typed JSON — grading pipeline is testable without images |
| **LLM never does structural or numeric work** | Rubric marks must sum to question max, SVG coords must land on pixels, question numbering must parse — code owns these, LLM owns judgment |
| **Family diversity is a build-time invariant** | Enforce, don't prefer |
| **Escalation reasons must be named** | Named reasons let the UI say "A and B disagreed here" instead of "low confidence" |
| **Cross-script grouping before release** | Same answer must get the same grade in the same batch — mechanically, not by hope |
| **Process supervision for STEM** | Grade steps, derive answer marks — catches right-answer-wrong-reasoning AND vice versa |
| **RAG-grounded against NCERT** | Grading against curriculum, not against LLM world knowledge |
| **Every stage cached, every stage replayable** | Regrade is cheap; LLM change doesn't invalidate reader output |
| **Every LLM call audited** | "Why did this get 3/5" must be answerable, months later, by a human |
| **Nothing auto-fills invisibly** | A wrong name silently propagated is the worst failure mode |
| **Jev for bounded, VLM for open-ended** | Two-model split kills enum drift and gives calibrated confidence |

---

## 14. Anti-patterns to avoid

- **Trusting LLM self-reported confidence** — miscalibrated (Rating
  Roulette EMNLP 2025). Use Jev Score or A/B disagreement instead.
- **Multiple prompt variants of the same model as an "ensemble"** —
  91% agreement drops to 64% the moment you add a different family.
  Same-family judges are one judge with three hats.
- **Holistic scoring at the answer level** — bakes in variance you
  can't debug. Every 2024-2026 rubric-grading paper moved to
  per-criterion verdicts.
- **Chain-of-thought as an accuracy improver in judges** — increases
  inter-judge correlation (worse ensemble diversity). Use CoT for
  transparency to the teacher, not for accuracy.
- **Auto-closing on singleton answer groups** — a singleton is by
  definition unusual; that's exactly the case that needs a human.
- **Letting the LLM output SVG coordinates** — will drift. Code owns
  layout; LLM owns judgment.
- **Making family diversity a soft preference** — must be a build-time
  invariant.

---

## 15. Refactor path from the current repo

The code in this repo today mixes Engine A + B + C in a single
pipeline. This is the ordered refactor.

### Phase 1 — carve out Engine A

1. Create `backend/src/reader/` module.
2. Define `Document`, `Element` union, per-type structured schemas as
   Zod files.
3. Define per-type metadata schemas with `Field<T>` shape.
4. Move `preprocess.ts` into `reader/normalise/`.
5. Move `vision.ts` into `reader/extraction/vlm.ts`.
6. Add `reader/detect-paper-type.ts` (VLM + Jev).
7. Add `reader/extract-metadata.ts` (VLM + Jev + normalizers).
8. Add `reader/structural-stitching.ts` (pure).
9. Expose `reader.read(pdf, options)` — the only public entry.

### Phase 2 — split B and C from the current pipeline

10. Rewrite `paper-extractor.ts` as
    `questionPaperToExamConfig(structured: QuestionPaperSchema)` — pure,
    testable, no LLM.
11. Rewrite `mapper.ts` + `semantic.ts` as
    `answerScriptToAnswerBlocks(structured: AnswerScriptSchema, exam)` —
    pure.
12. Grading pipeline consumes `AnswerBlocks`, never `blocks[]`, never
    pixels.

### Phase 3 — grader upgrades

13. Enforce family diversity as build-time invariant (fail on
    misconfigured registry).
14. Rewrite `grader.ts` for per-criterion micro-grading with quoted
    evidence spans.
15. Replace LLM-self-reported confidence gates with Jev Score /
    disagreement signals.
16. Add step-supervision pass for STEM questions.
17. Add RAG-grounding stage against NCERT chapter store.
18. Add named-escalation enum.

### Phase 4 — batch stages

19. Add cross-script grouping stage between grader and annotator.
20. Add cluster-approval UI in teacher app.

### Phase 5 — annotator + reports

21. Rewrite `annotator.ts` to derive SVG coords deterministically from
    `evidence.bbox` — no LLM SVG output.
22. Split reports into 4 pure functions (student / parent / teacher /
    class).

### Phase 6 — cross-cutting

23. Provider registry with role-based routing, family invariants, and
    audit log.
24. Jev integration at every decision point in §11.2.
25. Immutable Document store (content-addressed).

Each phase is shippable independently. Phase 1 alone unlocks a clean
reader interface; every later phase compounds.

---

## 16. Open questions

- **NCERT chapter store**: build our own from public NCERT PDFs (per
  class × subject × chapter), or license one? Content is public
  domain; embeddings + hosting are the actual work.
- **Cross-script grouping algorithm**: embedding cosine on evidence
  spans, or richer (LSH on transcripts + math AST equality)?
- **Handwriting-recognition low-quality fallback**: fine-tune TrOCR on
  our own scan corpus, or use PaddleOCR out-of-the-box first?
- **Jev availability in India**: latency and residency for Vertex vs
  Requesty vs direct API? Needs measurement.
- **Reader-training data**: teacher overrides at HITL gate #2 → training
  set. What's the ingestion path? Probably a labelled-review-events
  table + a nightly export.

---

## 17. References

- Lightman et al., *Let's Verify Step by Step* — https://cdn.openai.com/improving-mathematical-reasoning-with-process-supervision/Lets_Verify_Step_by_Step.pdf
- *Pensieve Grader* (arXiv 2507.01431) — closest published match to
  this pipeline, with concrete VLM-vs-Mathpix numbers —
  https://arxiv.org/pdf/2507.01431
- *Nine Judges, Two Effective Votes* — https://arxiv.org/html/2605.29800
- *Rating Roulette: Self-Inconsistency in LLM-As-A-Judge* (EMNLP 2025
  findings) — https://aclanthology.org/2025.findings-emnlp.1361.pdf
- *Self-Preference Bias in LLM-as-a-Judge* — https://arxiv.org/html/2410.21819v2
- Gradescope AI-assisted grading + answer groups — https://guides.gradescope.com/hc/en-us/articles/24838908062093-AI-assisted-grading-and-answer-groups
- *Towards Fully Automated Exam Grading: Fairness-Aware Recognition of
  Handwritten Answers with Foundation Models* (arXiv 2606.11477) —
  https://arxiv.org/pdf/2606.11477
- NCERT-RAG-Eval — https://github.com/amanverma-765/ncert-rag-evals
- Jev docs (TypeSafe AI) — https://docs.typesafe.ai/
- Jev JSON Schema bridge — https://github.com/Kiln-AI/jev_jsonschema
- IBM Granite Docling + DocTags — https://www.ibm.com/granite/docs/models/docling
- Docling pipeline options — https://docling-project.github.io/docling/reference/pipeline_options/
- Mistral OCR — https://mistral.ai/news/mistral-ocr/
- Google Document AI Layout Parser — https://docs.cloud.google.com/document-ai/docs/layout-parse-chunk
- OmniDocBench (CVPR 2025) — https://github.com/opendatalab/OmniDocBench
- *Can OCR-VLMs Read Devanagari?* (arXiv 2606.29213) — https://arxiv.org/pdf/2606.29213
- Claude Opus 4.7 vision — https://blog.roboflow.com/claude-opus-4-7/

---

*Amended by: pull request. Every change to this document is a design
decision worth reviewing.*
