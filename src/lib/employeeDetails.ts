// Employee details that staff fill in themselves (owner request 2026-11-23). The owner reviews each
// submission, can correct it, and only an approved copy is applied to the employee record.
// Position is NOT asked: the owner assigns it. One flat object of strings keeps storage and review simple.
// Fields trimmed to the owner's checklist (2026-11-25): only what operations need, all of it required.
import { z } from "zod";

export type FieldType = "text" | "date" | "select" | "tel" | "email" | "textarea" | "checkbox";
export type Field = {
  key: string;
  label: string;
  type: FieldType;
  required?: boolean;
  options?: string[];
  hint?: string;
  /** Digits-only pattern check (after removing spaces and dashes). */
  digits?: [min: number, max: number];
  max?: number;
  /** Owner-only: government IDs and bank details. Staff still see their own. */
  sensitive?: boolean;
  /** "NONE" is accepted (no number yet). */
  none?: boolean;
  /** Shown only when the condition holds (key equals value). */
  when?: [key: string, value: string];
  half?: boolean;
};
export type Section = { id: string; title: string; note?: string; fields: Field[] };

const RELATIONSHIPS = ["Spouse", "Child", "Parent", "Sibling", "Partner", "Relative", "Friend", "Other"];
const person = (n: number, required: boolean): Field[] => [
  { key: `ec${n}_name`, label: "Full name", type: "text", required, max: 120, half: true },
  { key: `ec${n}_relationship`, label: "Relationship to you", type: "select", required, options: RELATIONSHIPS, half: true },
  { key: `ec${n}_mobile`, label: "Mobile number", type: "tel", required, digits: [10, 13], hint: "e.g. 0917 123 4567", half: true },
  { key: `ec${n}_address`, label: "Address (city is enough)", type: "text", max: 200, half: true },
];

export const SECTIONS: Section[] = [
  {
    id: "personal",
    title: "Personal details",
    fields: [
      { key: "last_name", label: "Last name", type: "text", required: true, max: 60, half: true },
      { key: "first_name", label: "First name", type: "text", required: true, max: 60, half: true },
      { key: "middle_name", label: "Middle name", type: "text", max: 60, hint: "Leave blank if none", half: true },
      { key: "suffix", label: "Suffix", type: "text", max: 10, hint: "Jr., III, etc.", half: true },
      { key: "nickname", label: "Nickname (what clients call you)", type: "text", required: true, max: 40, half: true },
      { key: "birth_date", label: "Birth date", type: "date", required: true, half: true },
      { key: "sex", label: "Sex", type: "select", required: true, options: ["Female", "Male"], half: true },
      { key: "civil_status", label: "Civil status", type: "select", required: true, options: ["Single", "Married", "Widowed", "Legally separated", "Annulled"], half: true },
      { key: "nationality", label: "Citizenship", type: "text", required: true, max: 40, half: true },
    ],
  },
  {
    id: "contact",
    title: "Contact and address",
    fields: [
      { key: "mobile", label: "Mobile number", type: "tel", required: true, digits: [10, 13], hint: "e.g. 0917 123 4567", half: true },
      { key: "personal_email", label: "Personal email", type: "email", required: true, max: 254, half: true },
      { key: "present_address", label: "Present address (house no., street, barangay, city, province)", type: "textarea", required: true, max: 300 },
    ],
  },
  {
    id: "government",
    title: "Government IDs",
    note: "Needed for SSS, PhilHealth, Pag-IBIG and BIR (tax) reports. Only you and the owners can see these. If you don't have a number yet, type NONE.",
    fields: [
      { key: "tin", required: true, none: true, label: "TIN (tax number)", type: "text", digits: [9, 12], sensitive: true, hint: "000-000-000 or 000-000-000-000", half: true },
      { key: "sss", required: true, none: true, label: "SSS number", type: "text", digits: [10, 10], sensitive: true, hint: "00-0000000-0", half: true },
      { key: "philhealth", required: true, none: true, label: "PhilHealth number (PIN)", type: "text", digits: [12, 12], sensitive: true, hint: "00-000000000-0", half: true },
      { key: "pagibig", required: true, none: true, label: "Pag-IBIG MID number", type: "text", digits: [12, 12], sensitive: true, hint: "0000-0000-0000", half: true },
    ],
  },
  {
    id: "tax",
    title: "Tax and previous employment",
    note: "The owner needs this for your year-end tax certificate (BIR Form 2316).",
    fields: [
      { key: "prev_employer_this_year", label: "Did you work for another employer earlier this calendar year?", type: "select", required: true, options: ["No", "Yes"] },
      { key: "prev_employer_name", label: "Previous employer's name", type: "text", max: 120, when: ["prev_employer_this_year", "Yes"], half: true },
      { key: "prev_employer_end", label: "Last day there", type: "date", when: ["prev_employer_this_year", "Yes"], half: true },
      { key: "prev_2316", label: "Can you give the owner a copy of their BIR Form 2316?", type: "select", options: ["Yes", "Not yet", "No"], when: ["prev_employer_this_year", "Yes"] },
    ],
  },
  {
    id: "payroll",
    title: "Salary payout",
    note: "All salaries are still paid out in cash by default. Bank account and GCash details are kept for records only. Only you and the owners can see this.",
    fields: [
      { key: "payout_method", label: "Preferred payout method (for records)", type: "select", required: true, options: ["Bank account", "GCash", "Cash"] },
      { key: "bank_name", label: "Bank", type: "text", max: 80, sensitive: true, when: ["payout_method", "Bank account"], half: true },
      { key: "bank_account_name", label: "Account name", type: "text", max: 120, sensitive: true, when: ["payout_method", "Bank account"], half: true },
      { key: "bank_account_number", label: "Account number", type: "text", digits: [6, 20], sensitive: true, when: ["payout_method", "Bank account"], half: true },
      { key: "gcash_number", label: "GCash number", type: "tel", digits: [10, 13], sensitive: true, when: ["payout_method", "GCash"], half: true },
      { key: "gcash_name", label: "GCash account name", type: "text", max: 120, sensitive: true, when: ["payout_method", "GCash"], half: true },
    ],
  },
  {
    id: "emergency",
    title: "Emergency contact",
    note: "Who we call if something happens to you at work.",
    fields: person(1, true),
  },
  {
    id: "work",
    title: "Work",
    fields: [
      { key: "hire_date", label: "First day working at Hermosa", type: "date", required: true, hint: "Your best guess is fine. The owner will check it.", half: true },
      { key: "uniform_size", label: "Uniform size", type: "select", required: true, options: ["XS", "S", "M", "L", "XL", "2XL", "3XL"], half: true },
    ],
  },
  {
    id: "education",
    title: "Education",
    fields: [
      { key: "education_level", label: "Highest education finished", type: "select", required: true, options: ["High school", "Senior high school", "Vocational / TESDA", "College undergraduate", "College graduate", "Post-graduate"], half: true },
      { key: "school", label: "School", type: "text", required: true, max: 120, half: true },
      { key: "course", label: "Course or strand", type: "text", max: 120, half: true },
      { key: "year_graduated", label: "Year finished", type: "text", digits: [4, 4], half: true },
    ],
  },
  {
    id: "consent",
    title: "Consent",
    fields: [
      { key: "consent", label: "I confirm these details are true, and I agree that Hermosa Aesthetics keeps and uses them for employment, payroll and government reports, under the Data Privacy Act.", type: "checkbox", required: true },
    ],
  },
];

export const FIELDS: Field[] = SECTIONS.flatMap((s) => s.fields);
export const FIELD_BY_KEY = Object.fromEntries(FIELDS.map((f) => [f.key, f]));
export type Details = Record<string, string>;

const isDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
const onlyDigits = (v: string) => v.replace(/[\s\-+().]/g, "");
export const visible = (f: Field, d: Details) => !f.when || (d[f.when[0]] ?? "") === f.when[1];

/** Read the form, drop hidden fields, and check every value. Returns field-level errors. */
export function parseDetails(input: Record<string, unknown>): { ok: true; data: Details } | { ok: false; errors: Record<string, string>; data: Details } {
  const raw: Details = {};
  for (const f of FIELDS) {
    const v = input[f.key];
    raw[f.key] = f.type === "checkbox" ? (v === "on" || v === "yes" ? "yes" : "") : typeof v === "string" ? v.trim().replace(/\s+/g, " ") : "";
  }
  const data: Details = {};
  const errors: Record<string, string> = {};
  for (const f of FIELDS) {
    if (!visible(f, raw)) continue;
    const v = raw[f.key];
    if (!v) {
      if (f.required) errors[f.key] = f.type === "checkbox" ? "Please tick this to continue." : "Required.";
      continue;
    }
    if (f.max && v.length > f.max) errors[f.key] = `Too long (max ${f.max} characters).`;
    else if (f.type === "date" && !isDate(v)) errors[f.key] = "Pick a date.";
    else if (f.type === "select" && f.options && !f.options.includes(v)) errors[f.key] = "Choose from the list.";
    else if (f.type === "email" && !z.email().safeParse(v).success) errors[f.key] = "Check the email address.";
    else if (f.none && /^none$/i.test(v)) { data[f.key] = "NONE"; continue; }
    else if (f.digits) {
      const d = onlyDigits(v);
      if (!/^\d+$/.test(d) || d.length < f.digits[0] || d.length > f.digits[1]) {
        errors[f.key] = f.digits[0] === f.digits[1] ? `Should be ${f.digits[0]} digits.` : `Should be ${f.digits[0]} to ${f.digits[1]} digits.`;
      }
    }
    data[f.key] = v;
  }
  if (data.birth_date && data.birth_date > new Date().toISOString().slice(0, 10)) errors.birth_date = "Birth date can't be in the future.";
  return Object.keys(errors).length ? { ok: false, errors, data: raw } : { ok: true, data };
}

/** "Dela Cruz, Juana M." style name for the employee record. */
export function legalName(d: Details): string {
  return [d.first_name, d.middle_name ? `${d.middle_name[0]}.` : "", d.last_name, d.suffix].filter(Boolean).join(" ");
}

/** Required fields missing from saved details (e.g. fields added after someone sent theirs). */
export function missingRequired(d: Details): Field[] {
  return FIELDS.filter((f) => f.required && visible(f, d) && !d[f.key]);
}
