import { useParams } from "react-router-dom";
import {
  ReportState,
  StudentReportContent,
  useStudentReport,
} from "./StudentReport";

export default function StudentView() {
  const { runId } = useParams<{ runId: string }>();
  const state = useStudentReport(runId, undefined, undefined, true);
  if (!state.report) return <ReportState {...state} />;
  return <StudentReportContent report={state.report} audience="family" />;
}
