"use client";
// Expense report buttons (v0.102.4): Download PDF opens the phone's / browser's print sheet (Save as PDF) with only the
// report on the page; Download Excel saves the same figures as a CSV file Excel opens.
export function ReportActions({ csv, file }: { csv: string; file: string }) {
  const excel = () => {
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url; a.download = `${file}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  };
  const pdf = () => {
    const was = document.title;
    document.title = file; // the saved PDF takes the page title as its name
    window.print();
    setTimeout(() => { document.title = was; }, 1000);
  };
  return (
    <div className="xr-actions no-print">
      <button type="button" onClick={pdf}>Download PDF</button>
      <button type="button" className="secondary" onClick={excel}>Download Excel</button>
    </div>
  );
}
