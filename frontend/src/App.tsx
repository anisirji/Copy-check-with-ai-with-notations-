import { Link, Outlet, useLocation } from "react-router-dom";
export default function App() {
  const { pathname } = useLocation();
  const familyRun = pathname.match(
    /^\/review\/([^/]+)\/(?:student|parent)\/?$/,
  )?.[1];
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <header className="app-header">
        <Link
          className="brand-wordmark"
          to={familyRun ? `/review/${familyRun}/student` : "/"}
        >
          ScholiPhi
        </Link>
        <div id="page-header-slot" className="page-header-slot" />
        {!familyRun && (
          <Link className="all-assessments-link" to="/">
            Assessments
          </Link>
        )}
      </header>
      <main id="main-content">
        <Outlet />
      </main>
    </div>
  );
}
