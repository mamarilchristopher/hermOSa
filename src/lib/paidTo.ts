// update-0103 (CHRIS Nov 28): the account a client's payment went TO (where the money landed), in CHRIS's order.
export const PAID_TO = [
  { v: "CARD", label: "Credit Card" }, { v: "CASH", label: "Cash" }, { v: "GCASH", label: "GCash" }, { v: "BPI", label: "BPI" },
  { v: "MAYA", label: "Maya" }, { v: "MARIBANK", label: "MariBank" }, { v: "UNIONBANK", label: "UnionBank" }, { v: "PSBANK", label: "PSBank" },
] as const;
export type PaidTo = (typeof PAID_TO)[number]["v"];
export const PAID_TO_VALUES = PAID_TO.map((p) => p.v) as [PaidTo, ...PaidTo[]];
export const paidToLabel = (v: string | null | undefined) => PAID_TO.find((p) => p.v === v)?.label ?? null;
/** CHRIS's warning, shown wherever the account is picked. */
export const PAID_TO_WARNING = "Select the account the payment was SENT TO, not the app the client used to send it.";
