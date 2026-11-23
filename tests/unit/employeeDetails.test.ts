import { describe, expect, it } from "vitest";
import { legalName, parseDetails } from "../../src/lib/employeeDetails";

const base = {
  first_name: "Demo", last_name: "Staff", birth_date: "1999-01-02", sex: "Female", civil_status: "Single", nationality: "Filipino",
  mobile: "0917 123 4567", present_address: "Demo St, Demo City", prev_employer_this_year: "No", payout_method: "Cash",
  ec1_name: "Demo Parent", ec1_relationship: "Parent", ec1_mobile: "09171234567", hire_date: "2024-01-01", consent: "on",
};

describe("employee details form", () => {
  it("accepts a complete form and drops hidden fields", () => {
    const r = parseDetails({ ...base, bank_account_number: "123456789" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.consent).toBe("yes");
      expect(r.data.bank_account_number).toBeUndefined(); // payout is Cash, so bank fields are not kept
    }
  });
  it("flags missing required fields and bad ID numbers", () => {
    const r = parseDetails({ ...base, first_name: "", sss: "12-345", consent: "" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.errors).sort()).toEqual(["consent", "first_name", "sss"]);
  });
  it("accepts IDs typed with dashes and spaces", () => {
    expect(parseDetails({ ...base, sss: "34-1234567-8", philhealth: "12-345678901-2", pagibig: "1234 5678 9012", tin: "123-456-789-000" }).ok).toBe(true);
  });
  it("asks for bank details only when paid by bank", () => {
    const r = parseDetails({ ...base, payout_method: "Bank account", bank_account_number: "12" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.bank_account_number).toBeTruthy();
  });
  it("builds the record name", () => {
    expect(legalName({ first_name: "Juana", middle_name: "Santos", last_name: "Dela Cruz", suffix: "" })).toBe("Juana S. Dela Cruz");
  });
});
