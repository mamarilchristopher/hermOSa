import { Fragment } from "react";
import { SECTIONS, visible, type Details } from "@/lib/employeeDetails";

/** Read-only approved details (owners, or the person themself). */
export function DetailsView({ data }: { data: Details }) {
  return (
    <div className="details-view">
      {SECTIONS.filter((s) => s.id !== "consent").map((s) => {
        const rows = s.fields.filter((f) => f.type !== "checkbox" && visible(f, data) && data[f.key]);
        if (rows.length === 0) return null;
        return (
          <section key={s.id}>
            <h3>{s.title}</h3>
            <dl className="kv" style={{ borderTop: 0, paddingTop: 0, marginTop: 4 }}>
              {rows.map((f) => (<Fragment key={f.key}><dt>{f.label}</dt><dd>{data[f.key]}</dd></Fragment>))}
            </dl>
          </section>
        );
      })}
    </div>
  );
}
