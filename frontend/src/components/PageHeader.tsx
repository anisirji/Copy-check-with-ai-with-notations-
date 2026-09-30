import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

export default function PageHeader({
  breadcrumb,
  actions,
}: {
  breadcrumb: ReactNode;
  actions?: ReactNode;
}) {
  const [target, setTarget] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setTarget(document.getElementById("page-header-slot"));
  }, []);
  return target
    ? createPortal(
        <>
          <div className="page-breadcrumb">{breadcrumb}</div>
          <div className="page-header-actions">{actions}</div>
        </>,
        target,
      )
    : null;
}
