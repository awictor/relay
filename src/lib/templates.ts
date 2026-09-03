// Starter template library (starter-template-library): the proactive retention flywheel (recipes ->
// digests -> schedules -> alerts) only pays off once a user HAS a few, but most never discover the
// "save X:" syntax — auto-suggest only fires on a REPEAT. This is a curated catalog a cold user
// installs in one tap ("/templates morning"), seeding that first saved recipe. Pure static data +
// lookup; the handler wires install into the existing RecipeStore. No infra.

export interface Template {
  id: string;          // install key ("/templates <id>")
  title: string;       // one-line human label for the catalog
  button: string;      // short tap-button label (starter-automation-gallery) — fits a phone keyboard row
  recipeName: string;  // the name it's saved under (so /run <recipeName> works after)
  task: string;        // the recipe task (may include {slots} or ">>" chain steps)
}

// Kept small + broadly useful; each maps to a real capability the bot already has (weather, HN, price
// watch, feed-watch, chain). {slots} + ">>" work because they install as ordinary recipes.
export const TEMPLATES: Template[] = [
  { id: "morning", title: "Morning briefing — weather + top HN story", button: "☀️ Morning briefing", recipeName: "morning", task: "the weather where I am >> the top Hacker News story right now >> combine both into a short good-morning briefing" },
  { id: "price", title: "Price check — track any product's price", button: "💲 Price check", recipeName: "price", task: "the current price of {item}" },
  { id: "news", title: "Top news — the day's top headlines", button: "📰 Top news", recipeName: "news", task: "the top 3 news headlines right now, one line each" },
  { id: "hn", title: "Hacker News — the current top story", recipeName: "hn", button: "🔶 Hacker News", task: "the top story on Hacker News right now with its points and link" },
  { id: "jobs", title: "Job watch — new remote roles (pair with /run)", button: "💼 Job watch", recipeName: "jobs", task: "the newest remote {role} job listings" },
  { id: "commute", title: "Commute — travel time home", button: "🚗 Commute", recipeName: "commute", task: "how long to drive to {destination} right now" },
];

/** A template by id (case-insensitive), or null. Exported for tests. */
export function getTemplate(id: string): Template | null {
  const k = id.trim().toLowerCase();
  return TEMPLATES.find((t) => t.id === k) ?? null;
}

/** The catalog as a human list for /templates with no argument. Exported for tests. */
export function templateCatalog(): string {
  const lines = TEMPLATES.map((t) => `• ${t.id} — ${t.title}`);
  return `Ready-made automations — tap one to install (or "/templates <name>"), then /run ${TEMPLATES[0]!.recipeName}:\n${lines.join("\n")}`;
}

/** {id,label} pairs for the tap-to-install gallery buttons (starter-automation-gallery). Exported. */
export function templateButtons(): Array<{ id: string; label: string }> {
  return TEMPLATES.map((t) => ({ id: t.id, label: t.button }));
}
