import type { MouseEvent } from "react";

/**
 * Buttons that choose a decision (Approve / Reject / ...). A button's own name/value doesn't always reach a
 * server action (seen live: Approve arrived as no decision), so the click writes it into a hidden field instead.
 */
export const pick = (value: string) => (e: MouseEvent<HTMLButtonElement>) => {
  const form = e.currentTarget.form;
  if (!form) return;
  let input = form.querySelector<HTMLInputElement>('input[type="hidden"][name="decision"]');
  if (!input) {
    input = document.createElement("input");
    input.type = "hidden";
    input.name = "decision";
    form.appendChild(input);
  }
  input.value = value;
};
