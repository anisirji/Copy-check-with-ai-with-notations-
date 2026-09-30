import { Link } from "react-router-dom";
export default function WorkflowNav({
  examId,
  active,
}: {
  examId?: string;
  active: "upload" | "questions" | "answers" | "rules" | "publish";
}) {
  const steps = [
    { id: "upload", name: "Upload", to: "/create-exam" },
    {
      id: "questions",
      name: "Check questions",
      to: `/exam/${examId}/questions`,
    },
    { id: "answers", name: "Answers", to: `/exam/${examId}/scheme` },
    { id: "rules", name: "Rules", to: `/exam/${examId}/scheme#rules` },
    { id: "publish", name: "Publish", to: `/exam/${examId}/grade` },
  ];
  return (
    <nav className="workflow-nav" aria-label="Assessment setup">
      {steps.map((step) =>
        !examId && step.id !== "upload" ? (
          <span key={step.id} className="workflow-step unavailable">
            {step.name}
          </span>
        ) : (
          <Link
            key={step.id}
            className={`workflow-step ${step.id === active ? "current" : ""}`}
            aria-current={step.id === active ? "step" : undefined}
            to={step.to}
          >
            {step.name}
          </Link>
        ),
      )}
    </nav>
  );
}
