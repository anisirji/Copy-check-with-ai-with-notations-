import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import App from "./App.tsx";
import Upload from "./pages/Upload.tsx";
import CreateExam from "./pages/CreateExam.tsx";
import ExamList from "./pages/ExamList.tsx";
import ConfirmQuestions from "./pages/ConfirmQuestions.tsx";
import ApproveScheme from "./pages/ApproveScheme.tsx";
import GradeSheet from "./pages/GradeSheet.tsx";
import StudentView from "./pages/StudentView.tsx";
import AnswerReview from "./pages/AnswerReview.tsx";
import TestAnalysis from "./pages/TestAnalysis.tsx";
import ClassMatrixPage from "./pages/ClassMatrix.tsx";
import StudentReportPage from "./pages/StudentReport.tsx";
import "./index.css";
import "./design-system.css";
import ParentGuide from "./pages/ParentGuide.tsx";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route element={<App />}>
          <Route index element={<ExamList />} />
          <Route path="/create-exam" element={<CreateExam />} />
          <Route path="/exam/:id/questions" element={<ConfirmQuestions />} />
          <Route path="/exam/:id/scheme" element={<ApproveScheme />} />
          <Route path="/exam/:id/grade" element={<GradeSheet />} />
          <Route path="/exam/:id/report" element={<TestAnalysis />} />
          <Route path="/exam/:id/matrix" element={<ClassMatrixPage />} />
          <Route
            path="/exam/:examId/students/:studentId/report"
            element={<StudentReportPage />}
          />
          <Route path="/review/:runId" element={<AnswerReview />} />
          <Route path="/review/:runId/student" element={<StudentView />} />
          <Route path="/review/:runId/parent" element={<ParentGuide />} />
          <Route path="/legacy-upload" element={<Upload />} />
        </Route>
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
