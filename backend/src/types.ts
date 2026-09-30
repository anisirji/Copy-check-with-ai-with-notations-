import { z } from "zod";

// ─── Geometry ────────────────────────────────────────────────────────────────

export const bboxSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  width: z.number().min(0).max(1),
  height: z.number().min(0).max(1),
});
export type BBox = z.infer<typeof bboxSchema>;

// ─── Stage 1: image quality gate ─────────────────────────────────────────────

export interface QualityReport {
  page: number;
  quality: number; // 0..1 aggregate
  blur: number;
  brightness: number;
  contrast: number;
  acceptable: boolean;
  reason?: string;
}

// ─── Stage 2: preprocess (page images with dimensions) ───────────────────────

export interface PageMeta {
  page: number;
  imagePath: string;
  width: number;
  height: number;
}

// ─── Stage 3: page-understanding blocks ──────────────────────────────────────

export const blockSchema = z.object({
  id: z.string(),
  page: z.number().int().min(1),
  type: z.enum([
    "question_number",
    "text",
    "equation",
    "diagram",
    "table",
    "crossed_out",
    "other",
  ]),
  text: z.string(),
  ocrAlternatives: z.array(z.string()).optional(),
  bbox: bboxSchema,
  /**
   * True for blocks emitted by normalization layers (e.g.
   * answer-marker-normalizer), not the vision extractor itself.
   */
  synthetic: z.boolean().optional(),
});
export type Block = z.infer<typeof blockSchema>;

// ─── Exam configuration (teacher input) ──────────────────────────────────────

export const rubricCriterionSchema = z.object({
  id: z.string().min(1),
  concept: z.string(),
  marks: z.number().finite().positive(),
  acceptable: z.array(z.string()).optional(),
  sourceQuestionId: z.string().optional(),
  sourceCriterionId: z.string().optional(),
});
export type RubricCriterion = z.infer<typeof rubricCriterionSchema>;

/**
 * Topic + difficulty tags the teacher must confirm on each question
 * BEFORE grading can start. Wrong tag here breaks reports and practice
 * assignments downstream — hence the confirmation step.
 */
export const questionTagsSchema = z.object({
  chapter: z.string().min(1),
  topics: z.array(z.string().min(1)).min(1),
  difficulty: z.enum(["easy", "medium", "hard"]),
  confirmedByTeacher: z.boolean().default(false),
});
export type QuestionTags = z.infer<typeof questionTagsSchema>;

export const questionSchema = z.object({
  id: z.string().min(1),
  prompt: z.string(),
  maxMarks: z.number().finite().positive(),
  /** Original paper labels retained when the teacher merges subparts. */
  sourceQuestionIds: z.array(z.string().min(1)).optional(),
  subject: z
    .enum(["math", "physics", "chemistry", "biology", "general"])
    .optional(),
  modelAnswer: z.string().optional(),
  schemeApproved: z.boolean().optional(),
  rubric: z.array(rubricCriterionSchema),
  tags: questionTagsSchema.optional(),
  /** flagged from vision extraction; teacher must review before confirm */
  flags: z.array(z.string()).optional(),
});
export type Question = z.infer<typeof questionSchema>;

export const schemeApprovalSchema = z.object({
  approvedAt: z.string().optional(), // ISO timestamp
  approvedBy: z.string().optional(), // teacher id/email
});
export type SchemeApproval = z.infer<typeof schemeApprovalSchema>;

export const evaluationRulesSchema = z
  .object({
    mode: z.enum(["assist", "review", "sample"]),
    partialCredit: z.boolean(),
    carryForward: z.boolean(),
    unitPenalty: z.enum(["ignore", "half", "full"]),
    flagUncertain: z.boolean(),
    confirmed: z.boolean(),
  })
  .strict();
export type EvaluationRules = z.infer<typeof evaluationRulesSchema>;

export const examConfigSchema = z.object({
  id: z.string().optional(), // set on persist
  title: z.string(),
  subject: z.string(),
  class: z.string(),
  totalMarks: z.number().finite().positive(),
  questions: z.array(questionSchema),
  paper: z.object({ fileName: z.string() }).optional(),
  evaluationRules: evaluationRulesSchema.optional(),
  marksNormalization: z
    .object({
      originalTotalMarks: z.number().finite().positive(),
      targetTotalMarks: z.number().finite().positive(),
      questions: z.array(
        z.object({
          id: z.string(),
          originalMaxMarks: z.number().finite().positive(),
          maxMarks: z.number().finite().positive(),
        }),
      ),
    })
    .optional(),
  approval: schemeApprovalSchema.optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});
export type ExamConfig = z.infer<typeof examConfigSchema>;

// ─── Stage 5: semantic answer representation ─────────────────────────────────

export interface SemanticAnswer {
  questionId: string;
  answerBlockIds: string[];
  conceptsDetected: string[];
  equations: { text: string; blockId?: string }[];
  steps: { text: string; blockId?: string }[]; // math step-by-step
  diagrams: { description: string; blockId?: string }[];
  uncertainText: string[];
  rawTranscript: string;
}

// ─── Stage 6/8: grading ──────────────────────────────────────────────────────

export const mistakeTagSchema = z
  .enum(["concept_gap", "careless", "incomplete", "left_blank"])
  .optional();
export type MistakeTag = z.infer<typeof mistakeTagSchema>;

/** Student registry per class — used to match uploaded sheets and label reports. */
export const studentSchema = z.object({
  id: z.string(),
  name: z.string(),
  class: z.string(),
  rollNumber: z.union([z.string(), z.number()]).optional(),
});
export type Student = z.infer<typeof studentSchema>;

/** Append-only per-student test history — feeds "vs last test" + "value added" deltas. */
export const testHistoryEntrySchema = z.object({
  runId: z.string(),
  examId: z.string(),
  examTitle: z.string(),
  subject: z.string(),
  class: z.string(),
  awardedMarks: z.number(),
  maxMarks: z.number(),
  percentage: z.number(),
  releasedAt: z.string(),
});
export type TestHistoryEntry = z.infer<typeof testHistoryEntrySchema>;

export const rubricEvalSchema = z.object({
  criterionId: z.string(),
  concept: z.string(),
  marksAvailable: z.number(),
  marksAwarded: z.number(),
  status: z.enum(["correct", "partial", "missing", "incorrect"]),
  /**
   * Classification of the mistake. Fed to reports + practice assignment
   * so we can distinguish "student doesn't understand the topic" from
   * "student rushed and dropped a step".
   */
  mistakeTag: mistakeTagSchema,
  evidenceBlockId: z.string().optional(),
  evidence: z.string().optional(),
  /** Short, actionable correction, not the rubric's concept heading. */
  feedback: z.string().optional(),
  /** Spatial evidence is separate from the cached transcription. */
  evidenceRegion: z
    .object({
      page: z.number().int().positive(),
      bbox: bboxSchema,
      source: z.enum(["local_ocr", "visual_review"]),
      mark: z.object({ x: z.number(), y: z.number() }).optional(),
    })
    .optional(),
  confidence: z.number().min(0).max(1),
  overriddenByTeacher: z.boolean().optional(),
});
export type RubricEval = z.infer<typeof rubricEvalSchema>;

export interface GraderResult {
  grader: "A" | "B";
  provider?: string; // which LLM produced this grading (for audit)
  model?: string;
  rubricEvaluation: RubricEval[];
  awardedMarks: number;
  gradingConfidence: number;
}

export interface ValidatorReport {
  issues: {
    criterionId: string;
    reason: string;
    severity: "low" | "medium" | "high";
  }[];
  overallSuspicion: number; // 0..1
}

export type ConfidenceRoute = "auto_accept" | "verify_ai" | "teacher_review";

export type ReviewVerdict =
  | "correct"
  | "partially_correct"
  | "incorrect"
  | "missing"
  | "needs_review";

/**
 * Human-friendly review payload built from the grading + question. Backend
 * assembles this so every UI reads the same wording. Frontend renders the
 * card in a fixed order: Question → Student answer → Expected answer →
 * Review → Mark, with the verdict driving the review section's color.
 */
export interface StudentAnswerPayload {
  /** Teacher-facing display text with pipeline prefixes stripped. */
  displayText: string;
  /** Raw semantic transcript for debug/audit only. */
  rawTranscript: string;
  equations: string[];
  diagrams: string[];
  crossedOut: string[];
}

/**
 * Per-rubric-criterion diff row shown in the "AI review" section.
 * The frontend uses this to render a two-column diff line instead of a
 * generic sentence.
 */
export interface ReviewDiffRow {
  criterionId: string;
  concept: string;
  status: RubricEval["status"];
  studentSaid: string;
  expected: string;
  awardedMarks: number;
  maxMarks: number;
}

export interface QuestionReview {
  studentAnswer: StudentAnswerPayload;
  expectedAnswer: string;
  diff: ReviewDiffRow[];
  differences: string[];
  verdict: ReviewVerdict;
  /**
   * Independent of verdict. A perfectly-correct answer can still carry
   * needsTeacher=true if the mapping was ambiguous or confidence low. The
   * UI shows a separate chip for this instead of overriding the verdict.
   */
  needsTeacher: boolean;
  needsTeacherReason?: string;
  explanation: string;
  awardedMarks: number;
  maxMarks: number;
  confidence: number;
}

export interface QuestionGrading {
  questionId: string;
  answerBlockIds: string[];
  maxMarks: number;
  awardedMarks: number;
  rubricEvaluation: RubricEval[];
  graderA: GraderResult;
  graderB?: GraderResult;
  validator?: ValidatorReport;
  systemConfidence: number;
  route: ConfidenceRoute;
  needsTeacherReview: boolean;
  semantic: SemanticAnswer;
  teacherComment?: string;
  teacherReviewedAt?: string;
  reviewReason?: string;
  review?: QuestionReview;
}

// ─── Stage 9: annotation ─────────────────────────────────────────────────────

export const annotationSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("ink"),
    page: z.number().int().positive(),
    x: z.number(),
    y: z.number(),
    kind: z.enum(["correct", "partial", "incorrect"]),
  }),
  z.object({
    type: z.literal("check"),
    page: z.number().int().min(1),
    x: z.number(),
    y: z.number(),
  }),
  z.object({
    type: z.literal("cross"),
    page: z.number().int().min(1),
    x: z.number(),
    y: z.number(),
  }),
  z.object({
    type: z.literal("circle"),
    page: z.number().int().min(1),
    bbox: bboxSchema,
  }),
  z.object({
    type: z.literal("underline"),
    page: z.number().int().min(1),
    bbox: bboxSchema,
    color: z.string().optional(),
  }),
  z.object({
    type: z.literal("comment_box"),
    page: z.number().int().min(1),
    // top-left corner of the box in normalized coords
    x: z.number(),
    y: z.number(),
    // optional anchor point (arrow points from box to this coord on the answer)
    anchorX: z.number().optional(),
    anchorY: z.number().optional(),
    heading: z.string().optional(), // e.g. "Q2 - All 5 correct. Well done!"
    text: z.string(),
    kind: z.enum(["good", "improve", "wrong"]).default("wrong"),
  }),
  z.object({
    type: z.literal("question_score"),
    page: z.number().int().min(1),
    x: z.number(),
    y: z.number(),
    text: z.string(), // e.g. "1/3"
  }),
  z.object({
    // Big hand-drawn-style red-circled fraction next to a question's first
    // answer block — how a teacher actually marks "3/5" beside an answer.
    type: z.literal("circled_score"),
    page: z.number().int().min(1),
    x: z.number(),
    y: z.number(),
    text: z.string(), // e.g. "3/5"
    label: z.string().optional(),
  }),
  z.object({
    // Wavy red underline — used instead of a circle when the target region
    // spans most of the page (a full paragraph block).
    type: z.literal("wavy_underline"),
    page: z.number().int().min(1),
    bbox: bboxSchema,
  }),
  z.object({
    type: z.literal("page_total"),
    page: z.number().int().min(1),
    text: z.string(), // e.g. "16/20"
    /** e.g. "could improve to 18/20" — shown as a smaller sub-line */
    subline: z.string().optional(),
  }),
  z.object({
    type: z.literal("badge"),
    page: z.number().int().min(1),
    heading: z.string(), // "AI CHECKED"
    subtext: z.string().optional(), // e.g. "verified 5 answers"
  }),
]);
export type Annotation = z.infer<typeof annotationSchema>;

// ─── Stage 11: analytics ─────────────────────────────────────────────────────

export interface Analytics {
  perQuestion: {
    questionId: string;
    awarded: number;
    max: number;
    weakestCriteria: { criterionId: string; concept: string }[];
  }[];
  weakConcepts: { concept: string; missedCount: number }[];
  totalAwarded: number;
  totalMax: number;
  automationRate: number; // % of questions auto-accepted
  routeCounts: Record<ConfidenceRoute, number>;
}

// ─── Full pipeline output ────────────────────────────────────────────────────

/**
 * A single student's evaluation, incl. release gate. Nothing student- or
 * parent-facing is served until `releasedAt` is set by the teacher.
 */
export interface Release {
  releasedAt?: string;
  releasedBy?: string;
}

export interface PipelineResult {
  runId: string;
  createdAt: string;
  examId?: string;
  studentId?: string;
  release?: Release;
  acknowledgment?: { acknowledgedAt: string };
  teacherRemark?: string;
  annotationGrounding?: {
    version: 1;
    updatedAt: string;
    placed: number;
    unlocated: { questionId: string; criterionId: string }[];
  };
  correction?: {
    correctedAt: string;
    reason: string;
    sourceRunId: string;
    previousTotalAwarded: number;
    previousTotalMax: number;
    backupDirectory: string;
  };
  overrideHistory?: {
    updatedAt: string;
    questionId: string;
    previous: QuestionGrading;
    updated: QuestionGrading;
  }[];
  exam: ExamConfig;
  quality: QualityReport[];
  pages: PageMeta[];
  blocks: Block[];
  mapping: Record<string, string[]>;
  grading: QuestionGrading[];
  annotations: Annotation[];
  analytics: Analytics;
  outputs: {
    originalPdf: string;
    evaluationJson: string;
    evaluatedPdf: string;
    annotatedPagePaths: string[];
  };
}

// ─── Reports ─────────────────────────────────────────────────────────────────

/**
 * Class-level aggregate — computed on demand across every released run for
 * a given exam. Drives the teacher test-analysis screen.
 */
export interface ClassReport {
  examId: string;
  exam: {
    title: string;
    subject: string;
    class: string;
    totalMarks: number;
    questionCount: number;
    conductedAt?: string;
  };
  studentsAppeared: number;
  studentsTotal: number;
  average: number;
  averagePct: number;
  highest: number;
  lowest: number;
  spread: number;
  aboveAverageCount: number;
  syllabusCoveredPct: number | null;
  bandCounts: { band: string; count: number }[];
  markLossReasons: { reason: MistakeTag | "correct"; percentage: number }[];
  difficultyBreakdown: {
    difficulty: "easy" | "medium" | "hard";
    marksAvailable: number;
    marksEarnedPct: number;
  }[];
  topicCoverage: {
    topic: string;
    chapter: string;
    marksAvailable: number;
    marksEarnedPct: number;
    read: "secure" | "shaky" | "re-teach";
  }[];
  questionSummary: {
    questionId: string;
    concept: string;
    difficulty: "easy" | "medium" | "hard";
    maxMarks: number;
    fullMarksCount: number; // students at full marks
    classCorrectPct: number; // percentage of students earning full marks
    marksEarnedPct: number; // fraction of possible marks earned
    read: "secure" | "shaky" | "re-teach";
  }[];
  studentsToLookAtFirst: {
    studentId: string;
    name: string;
    score: number;
    maxMarks: number;
    deltaVsLast: number | null; // in marks; null = no prior test
    weakestConcept: string;
  }[];
}

/**
 * Every student × every question — the matrix view + derived groups.
 */
export interface ClassMatrix {
  examId: string;
  questions: { id: string; maxMarks: number; concept: string }[];
  rows: {
    studentId: string;
    name: string;
    perQuestion: {
      questionId: string;
      awarded: number;
      max: number;
      kind: "full" | "partial" | "none";
    }[];
    total: number;
    vsLast: number | null;
  }[];
  classPctByQuestion: { questionId: string; pct: number }[];
  groups: {
    rebuild: { studentId: string; name: string }[];
    consolidate: { studentId: string; name: string }[];
    extend: { studentId: string; name: string }[];
  };
}

/**
 * Individual student report — the parent-shareable page.
 */
export interface StudentReport {
  runId: string;
  acknowledgment?: { acknowledgedAt: string };
  student: Student;
  exam: {
    id: string;
    title: string;
    subject: string;
    class: string;
    conductedAt?: string;
    maxMarks: number;
  };
  awardedMarks: number;
  percentage: number;
  classAverage: number;
  classAveragePct: number;
  positionInClass: number;
  classSize: number;
  highestInClass: number;
  aboveAverageBy: number;
  averageBeforePct: number | null;
  averageNowPct: number | null;
  valueAdded: boolean | null;
  lastThreeTests: {
    label: string;
    awarded: number;
    max: number;
    pct: number;
  }[];
  sinceLastTestMarks: number | null;
  sinceLastTestPct: number | null;
  sinceTwoTestsAgoMarks: number | null;
  sinceTwoTestsAgoPct: number | null;
  classPositionMovedFrom: number | null;
  topicPerformance: {
    topic: string;
    awarded: number;
    max: number;
    read: "strong" | "on-track" | "needs-focus";
  }[];
  lostMarks: {
    questionId: string;
    concept: string;
    studentMarks: number;
    classAverageMarks: number;
    maxMarks: number;
    whatWentWrong: string;
  }[];
  nextActions: {
    priority: "first" | "then" | "keep-going";
    title: string;
    detail: string;
    assignment?: string;
  }[];
  teacherRemark?: string;
}
