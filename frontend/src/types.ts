// Mirrors backend/src/types.ts shape. Kept minimal — we only need what the UI reads.

export interface BBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

// ─── Exam configuration (mirrors backend/src/types.ts) ───────────────────────

export type QuestionSubject =
  | "math"
  | "physics"
  | "chemistry"
  | "biology"
  | "general";

export type QuestionDifficulty = "easy" | "medium" | "hard";

export interface QuestionTags {
  chapter: string;
  topics: string[];
  difficulty: QuestionDifficulty;
  confirmedByTeacher: boolean;
}

export interface SchemeApproval {
  approvedAt?: string;
  approvedBy?: string;
}

export interface Release {
  releasedAt?: string;
  releasedBy?: string;
}

export type MistakeTag =
  | "concept_gap"
  | "careless"
  | "incomplete"
  | "left_blank"
  | undefined;

export interface RubricCriterion {
  id: string;
  concept: string;
  marks: number;
  acceptable?: string[];
  sourceQuestionId?: string;
  sourceCriterionId?: string;
}

export interface EvaluationRules {
  mode: "assist" | "review" | "sample";
  partialCredit: boolean;
  carryForward: boolean;
  unitPenalty: "ignore" | "half" | "full";
  flagUncertain: boolean;
  confirmed: boolean;
}

export interface Question {
  schemeApproved?: boolean;
  id: string;
  prompt: string;
  maxMarks: number;
  subject?: QuestionSubject;
  modelAnswer?: string;
  rubric: RubricCriterion[];
  tags?: QuestionTags;
  flags?: string[];
  sourceQuestionIds?: string[];
}

export interface ExamConfig {
  paper?: { fileName: string };
  evaluationRules?: EvaluationRules;
  id?: string;
  title: string;
  subject: string;
  class: string;
  totalMarks: number;
  questions: Question[];
  approval?: SchemeApproval;
  createdAt?: string;
  updatedAt?: string;
  marksNormalization?: {
    originalTotalMarks: number;
    targetTotalMarks: number;
    questions: { id: string; originalMaxMarks: number; maxMarks: number }[];
  };
}

export interface ExamSummary {
  id: string;
  title: string;
  class: string;
  subject: string;
  approved: boolean;
  updatedAt?: string;
}

export interface Block {
  id: string;
  page: number;
  type: string;
  text: string;
  bbox: BBox;
}

export type Annotation = import("../../backend/src/types").Annotation;

export interface RubricEval {
  criterionId: string;
  concept: string;
  marksAvailable: number;
  marksAwarded: number;
  status: "correct" | "partial" | "missing" | "incorrect";
  evidenceBlockId?: string;
  evidence?: string;
  feedback?: string;
  evidenceRegion?: {
    page: number;
    bbox: BBox;
    source: "local_ocr" | "visual_review";
    mark?: { x: number; y: number };
  };
  confidence: number;
  overriddenByTeacher?: boolean;
  mistakeTag?: MistakeTag;
}

export type ConfidenceRoute = "auto_accept" | "verify_ai" | "teacher_review";

export interface SemanticAnswer {
  questionId: string;
  answerBlockIds: string[];
  conceptsDetected: string[];
  equations: { text: string; blockId?: string }[];
  steps: { text: string; blockId?: string }[];
  diagrams: { description: string; blockId?: string }[];
  uncertainText: string[];
  rawTranscript: string;
}

export type ReviewVerdict =
  | "correct"
  | "partially_correct"
  | "incorrect"
  | "missing"
  | "needs_review";

export interface StudentAnswerPayload {
  displayText: string;
  rawTranscript: string;
  equations: string[];
  diagrams: string[];
  crossedOut: string[];
}

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
  needsTeacher: boolean;
  needsTeacherReason?: string;
  explanation: string;
  awardedMarks: number;
  maxMarks: number;
  confidence: number;
}

export interface QuestionGrading {
  teacherComment?: string;
  reviewReason?: string;
  questionId: string;
  answerBlockIds: string[];
  maxMarks: number;
  awardedMarks: number;
  rubricEvaluation: RubricEval[];
  systemConfidence: number;
  route: ConfidenceRoute;
  needsTeacherReview: boolean;
  semantic: SemanticAnswer;
  review?: QuestionReview;
}

export interface PageMeta {
  page: number;
  imagePath: string;
  width: number;
  height: number;
}

export interface Analytics {
  totalAwarded: number;
  totalMax: number;
  automationRate: number;
  routeCounts: Record<ConfidenceRoute, number>;
  weakConcepts: { concept: string; missedCount: number }[];
}

export interface EvaluationDoc {
  runId: string;
  annotationGrounding?: {
    version: 1;
    updatedAt: string;
    placed: number;
    unlocated: { questionId: string; criterionId: string }[];
  };
  correction?: {
    correctedAt: string;
    reason: string;
    previousTotalAwarded: number;
    previousTotalMax: number;
  };
  examId?: string;
  studentId?: string;
  exam?: ExamConfig;
  pages: PageMeta[];
  blocks: Block[];
  grading: QuestionGrading[];
  annotations: Annotation[];
  analytics: Analytics;
  release?: Release;
  outputs: {
    originalPdf: string;
    evaluationJson: string;
    evaluatedPdf: string;
    annotatedPagePaths: string[];
  };
}

export interface StudentEvaluation {
  totalAwarded: number;
  totalMax: number;
  perQuestion: {
    questionId: string;
    awardedMarks: number;
    maxMarks: number;
  }[];
  weakConcepts: { concept: string; missedCount: number }[];
  releasedAt: string;
}

// ─── Reports ─────────────────────────────────────────────────────────────────

export interface Student {
  id: string;
  name: string;
  class: string;
  rollNumber?: string | number;
}

export interface TestHistoryEntry {
  runId: string;
  examId: string;
  examTitle: string;
  subject: string;
  class: string;
  awardedMarks: number;
  maxMarks: number;
  percentage: number;
  releasedAt: string;
}

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
    fullMarksCount: number;
    classCorrectPct: number;
    read: "secure" | "shaky" | "re-teach";
  }[];
  studentsToLookAtFirst: {
    studentId: string;
    name: string;
    score: number;
    maxMarks: number;
    deltaVsLast: number | null;
    weakestConcept: string;
  }[];
}

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

export interface StudentReport {
  acknowledgment?: { acknowledgedAt: string };
  runId: string;
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
