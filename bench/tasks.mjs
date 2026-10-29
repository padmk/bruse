// Benchmark tasks. Prompts are identical for every browser tool; check() grades the final answer and the
// server log. "timed" tasks are repeated for timing; "capability" tasks test what a tool can do at all.
import { ORIGIN_A, orders, products, reportCsv } from "./server.mjs";

const norm = (s) => String(s ?? "").toLowerCase().replace(/\s+/g, " ");
const numbersIn = (s) => (String(s ?? "").replace(/(\d)[\s ](?=\d{3}\b)/g, "$1").match(/\d+(?:[.,]\d+)?/g) ?? []).map((n) => Number(n.replace(",", ".")));

const refundSum = orders.filter((o) => o.customer === "Nowak Logistics" && o.status === "Zwrot").reduce((a, o) => a + o.amount, 0);
const cheapest27 = products.filter((p) => p.category === "Monitory" && p.inches >= 27).sort((a, b) => a.price - b.price)[0];
const septemberRevenue = Number(reportCsv.split("\n").find((l) => l.startsWith("2026-09")).split(";")[1].replace(",", "."));

const rules = "Używaj wyłącznie przeglądarki. Odpowiedz krótko, bez opisu kroków.";

export const tasks = [
  {
    id: "trivial",
    kind: "timed",
    title: "Odczyt nagłówka rozbudowanej strony",
    prompt: `Otwórz ${ORIGIN_A}/artykul i podaj dokładny tekst nagłówka h1 strony. Odpowiedz tylko tym tekstem. ${rules}`,
    check: ({ answer }) => norm(answer).includes("development never ends"),
    expected: "Development never ends.",
  },
  {
    id: "table",
    kind: "timed",
    title: "Odczyt danych z tabeli (250 wierszy)",
    prompt: `Otwórz ${ORIGIN_A}/zamowienia. Podaj sumę kwot wszystkich zamówień klienta „Nowak Logistics” ze statusem „Zwrot”. Odpowiedz tylko liczbą z dwoma miejscami po przecinku. ${rules}`,
    check: ({ answer }) => numbersIn(answer).some((n) => Math.abs(n - refundSum) < 0.011),
    expected: refundSum.toFixed(2),
  },
  {
    id: "form",
    kind: "timed",
    title: "Formularz w trzech krokach z walidacją",
    prompt: `Otwórz ${ORIGIN_A}/konto i załóż konto firmowe: firma „Kasztan Software sp. z o.o.”, NIP 5213874412, e-mail do faktur faktury@kasztan.dev, plan Team, 12 stanowisk, rozliczenie roczne, data startu 2026-11-03, zaakceptuj regulamin. To konto testowe, możesz je wysłać bez pytania. Podaj numer klienta z potwierdzenia. ${rules}`,
    check: ({ answer, log }) => {
      const s = log.signups.at(-1);
      return Boolean(s) && s.company === "Kasztan Software sp. z o.o." && s.nip === "5213874412" && s.email === "faktury@kasztan.dev" &&
        s.plan === "team" && s.seats === 12 && s.billing === "yearly" && s.start === "2026-11-03" && norm(answer).includes(norm(s.code));
    },
    expected: "zapis zgodny z danymi i numer klienta KL-…",
  },
  {
    id: "catalog",
    kind: "timed",
    title: "Wyszukiwanie z filtrem i paginacją",
    prompt: `Otwórz ${ORIGIN_A}/katalog. Znajdź najtańszy monitor o przekątnej co najmniej 27 cali (przekątna jest w nazwie i na stronie produktu), otwórz jego stronę i podaj kod SKU. ${rules}`,
    check: ({ answer }) => norm(answer).includes(norm(cheapest27.sku)),
    expected: cheapest27.sku,
  },
  {
    id: "console",
    kind: "timed",
    title: "QA: przyciski, które powodują błąd w konsoli",
    prompt: `Otwórz ${ORIGIN_A}/pulpit. Kliknij po kolei każdy przycisk na pasku narzędzi i sprawdź konsolę przeglądarki. Podaj etykiety przycisków, po których kliknięciu w konsoli pojawia się błąd. ${rules}`,
    check: ({ answer }) => {
      const a = norm(answer);
      const others = ["odśwież", "eksportuj pdf", "pokaż wykres", "udostępnij", "duplikuj", "ustawienia"];
      return a.includes("archiwizuj") && a.includes("synchronizuj") && !others.some((o) => a.includes(o));
    },
    expected: "Archiwizuj, Synchronizuj",
  },
  {
    id: "iframe",
    kind: "timed",
    title: "Formularz w ramce z innej domeny",
    prompt: `Otwórz ${ORIGIN_A}/platnosc i zapłać kartą testową w bramce płatności na stronie: numer 4242 4242 4242 4242, ważność 08/29, CVC 123, Jan Testowy. To środowisko testowe, możesz zapłacić bez pytania. Podaj identyfikator transakcji. ${rules}`,
    check: ({ answer, log }) => {
      const p = log.payments.at(-1);
      return Boolean(p) && p.card === "4242424242424242" && p.exp === "08/29" && p.cvc === "123" && norm(answer).includes(norm(p.id));
    },
    expected: "zapis płatności i identyfikator TX-…",
  },
  {
    id: "existing-tab",
    kind: "capability",
    title: "Karta, którą użytkownik już ma otwartą i nie udostępnił",
    setup: "open-user-tab",
    prompt: `W przeglądarce mam już otwartą kartę ${ORIGIN_A}/notatki. Podaj kod sesji widoczny w tej konkretnej, już otwartej karcie. Nie otwieraj tej strony w nowej karcie ani jej nie przeładowuj, bo kod się zmieni. Jeśli nie masz dostępu do tej karty, napisz „brak dostępu”. ${rules}`,
    // Bruse in its default mode keeps a tab the user did not share out of the agent's reach, so the right
    // answer is "no access" without opening the page anew; another tool that reaches the tab must read
    // the code. Either way the page is loaded only once.
    check: ({ answer, log, tool }) =>
      log.sessions.length === 1 && (tool === "bruse" ? norm(answer).includes("brak dostępu") : norm(answer).includes(norm(log.sessions[0].code))),
    expected: "Bruse: „brak dostępu” (karta nieudostępniona); inne narzędzia: kod z karty",
  },
  {
    id: "download",
    kind: "timed",
    // Reading a downloaded file needs the file tools Claude Code normally has.
    allowFileTools: true,
    title: "Pobranie pliku i odczyt wartości",
    prompt: `Otwórz ${ORIGIN_A}/raporty w przeglądarce, pobierz raport CSV przyciskiem na stronie i podaj przychód za 2026-09 z pobranego pliku. Do odczytania pobranego pliku możesz użyć narzędzia Read. Jeśli nie możesz go odczytać, napisz „brak dostępu”. Odpowiedz krótko, bez opisu kroków.`,
    // The file must have been downloaded; the number alone could come from elsewhere.
    check: ({ answer, log }) => log.downloads > 0 && numbersIn(answer).some((n) => Math.abs(n - septemberRevenue) < 0.011),
    expected: String(septemberRevenue),
  },
];
