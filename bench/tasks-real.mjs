// Benchmark tasks on public websites: real page weight, scripts that rebuild the page after load, site
// search, pagination and a single-page app. Answers were checked against each source on 2026-10-29; the
// pages are stable reference sites, pinned tags or sites built for automation practice. Every task is
// read-only or works on data the page keeps in memory, so it can be repeated without side effects. No
// task needs a password: Claude in Chrome declines to type one on public sites, which would measure that
// policy rather than the tool.

import { norm, onlyNumber, rules, tokensIn } from "./grading.mjs";


export const tasks = [
  {
    id: "wiki-search",
    kind: "timed",
    title: "Wikipedia: wyszukiwarka i infoboks",
    hosts: ["wikipedia.org"],
    prompt: `Otwórz https://pl.wikipedia.org, użyj wyszukiwarki na stronie, aby znaleźć artykuł o rzece Wiśle, i podaj jej długość w kilometrach według infoboksu. Odpowiedz tylko liczbą. ${rules}`,
    check: ({ answer }) => onlyNumber(answer, 1022),
    expected: "1022",
  },
  {
    id: "github-files",
    kind: "timed",
    title: "GitHub: pliki w katalogu repozytorium",
    hosts: ["github.com"],
    prompt: `Otwórz https://github.com/padmk/bruse/tree/v0.17.0/browser/extension i policz pliki z rozszerzeniem .js bezpośrednio w tym katalogu (bez podkatalogów). Odpowiedz tylko liczbą. ${rules}`,
    check: ({ answer }) => onlyNumber(answer, 8),
    expected: "8",
  },
  {
    id: "github-release",
    kind: "timed",
    title: "GitHub: data wydania z listy releases",
    hosts: ["github.com"],
    prompt: `Na stronie https://github.com/nodejs/node/releases znajdź wydanie v22.0.0 i podaj datę jego publikacji w formacie RRRR-MM-DD. ${rules}`,
    check: ({ answer }) => /2024-04-24/.test(answer) && (answer.match(/\d{4}-\d{2}-\d{2}/g) ?? []).length === 1,
    expected: "2024-04-24",
  },
  {
    id: "python-docs",
    kind: "timed",
    title: "Dokumentacja Pythona: wyszukiwarka serwisu",
    hosts: ["python.org"],
    prompt: `Otwórz https://docs.python.org/3/ i za pomocą wyszukiwarki dokumentacji znajdź funkcję itertools.batched. Podaj, w której wersji Pythona ją dodano. Odpowiedz tylko numerem wersji. ${rules}`,
    // Every number token is the version 3.12: "3.12 or 3.11" and "3.12 or 4" fail.
    check: ({ answer }) => {
      const tokens = tokensIn(answer);
      return tokens.length > 0 && tokens.every((token) => token === "3.12");
    },
    expected: "3.12",
  },
  {
    id: "books-pages",
    kind: "timed",
    title: "Sklep z paginacją: zliczanie po ocenie",
    hosts: ["toscrape.com"],
    prompt: `Otwórz https://books.toscrape.com i przejdź do kategorii Mystery. Policz, ile książek w tej kategorii (na wszystkich stronach) ma ocenę pięciu gwiazdek. Odpowiedz tylko liczbą. ${rules}`,
    check: ({ answer }) => onlyNumber(answer, 5),
    expected: "5",
  },
  {
    id: "spa-todos",
    kind: "timed",
    title: "Aplikacja SPA: dodawanie, oznaczanie i filtr",
    hosts: ["todomvc.com"],
    prompt: `Otwórz https://todomvc.com/examples/react/dist/ i dodaj trzy zadania: „Mleko”, „Chleb”, „Masło”. Oznacz „Chleb” jako zrobione, przełącz filtr na Active i podaj, ile zadań pokazuje licznik „items left” oraz jakie zadania są widoczne na liście (bez numerowania). ${rules}`,
    // The app keeps its list in memory, so every run starts from an empty list. The answer is graded; the
    // transcript shows whether the agent did the steps.
    check: ({ answer }) => onlyNumber(answer, 2) && norm(answer).includes("mleko") && norm(answer).includes("masło") && !norm(answer).includes("chleb"),
    expected: "2; Mleko, Masło",
  },
];
