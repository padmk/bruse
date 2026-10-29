// Grading shared by the benchmark suites. Prompts ask for a bare answer, so a check passes only when
// every number in the answer is the expected one.

export const norm = (s) => String(s ?? "").toLowerCase().replace(/\s+/g, " ");
// Number tokens as written, after joining thousands written with a space ("1 022"): an optional
// version prefix (v), sign (-, +, −), digits with decimal or version parts, or a leading decimal point,
// and an exponent. A token starts and ends at a boundary with letters and digits, so "2024-04-24" holds no
// signed numbers and "v4" is the token "4". The version prefix is dropped and "−" becomes "-".
export const tokensIn = (s) =>
  (String(s ?? "").replace(/(\d)[\s\u00a0](?=\d{3}\b)/g, "$1").match(/(?<![\p{L}\d.])[vV]?[-+\u2212]?(?:\d+(?:[.,]\d+)*|[.,]\d+)(?:[eE][-+]?\d+)?(?![\p{L}\d])/gu) ?? []).map((token) =>
    token.replace(/^[vV]/, "").replace("\u2212", "-"),
  );
const numbersIn = (s) => tokensIn(s).map((token) => Number(token.replace(",", ".")));
// Every number in the answer is exactly the value, and there is at least one: "1022 km" and "Counter
// shows 2 ("2 items left")" pass; "1022 or 1047" and "2.01" do not. A repeated value is not a
// contradiction, and real answers repeat it.
// `tolerance` allows for a sum computed in floating point; numbers in `restated` (the ones the question
// names, such as the month in "revenue for 2026-09") may appear as well.
export const onlyNumber = (answer, value, { tolerance = 0, restated = "" } = {}) => {
  const named = new Set(numbersIn(restated));
  const numbers = numbersIn(answer).filter((n) => !named.has(n) || Math.abs(n - value) <= tolerance);
  return numbers.some((n) => Math.abs(n - value) <= tolerance) && numbers.every((n) => Math.abs(n - value) <= tolerance);
};

export const rules = "Używaj wyłącznie przeglądarki. Odpowiedz krótko, bez opisu kroków.";
