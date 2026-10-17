// Writes the texts for one video with OpenAI, renders the HyperFrames template and uploads
// the MP4 to the autoposter worker, where it waits for human review in the dashboard.
// Env: OPENAI_API_KEY, AUTOPOSTER_URL, AUTOPOSTER_SECRET. Optional: TOPIC, OPENAI_MODEL, DRY_RUN=1.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, statSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const templateDir = path.join(here, "..", "template");
const out = path.join(here, "out.mp4");
const varsFile = path.join(here, "vars.json");

function need(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Umgebungsvariable fehlt: ${name}`);
  return v;
}

// Field -> max characters. Mirrors maxLength in template/index.html; longer text breaks the layout.
const LIMITS = {
  label: 28, hook_a: 24, hook_b: 24, hook_accent: 24, list_title: 26,
  tip1: 42, tip2: 42, tip3: 42, take_a: 26, take_accent: 26,
};

function pickTopic() {
  if (process.env.TOPIC) return process.env.TOPIC;
  const topics = JSON.parse(readFileSync(path.join(here, "topics.json"), "utf8"));
  const day = Math.floor(Date.now() / 86400e3);
  return topics[day % topics.length];
}

async function writeTexts(topic, feedback = "") {
  // No maxLength in the schema: constrained decoding enforces it by cutting words mid-way ("haltn").
  // Lengths are checked in texts() instead, with a retry that asks for shorter wording.
  const props = Object.fromEntries(Object.keys(LIMITS).map((k) => [k, { type: "string" }]));
  props.caption = { type: "string" };
  const prompt = `Du schreibst Texte für ein 15-Sekunden-TikTok von Vienna Webdesigns, einer Webdesign-Agentur in Wien.
Zielgruppe: kleine Betriebe in Wien. Thema: "${topic}".
Ton: direkt, freundlich, du-Form, österreichisches Deutsch, keine Übertreibung.
Regeln:
- Nur allgemein gültige, sachlich richtige Tipps. Keine erfundenen Zahlen, Statistiken, Studien, Preise oder Kundenstimmen.
- hook_a + hook_b bilden zusammen eine Frage oder Aussage, die neugierig macht. hook_accent ist die kurze Antwort-Ankündigung.
- list_title kündigt die drei Tipps an, z. B. "3 schnelle Fixes".
- tip1-tip3: je ein konkreter, umsetzbarer Tipp, kein Satzpunkt am Ende.
- take_a + take_accent: Fazit in zwei Teilen, take_accent endet mit Punkt.
- label: kurzes Thema in 2-3 Wörtern.
- Strikte Zeichenlimits (inklusive Leerzeichen): ${JSON.stringify(LIMITS)}. Lieber kürzer und vollständig als abgeschnitten: jedes Wort ganz ausschreiben, keine Abkürzungen.
- Rechtschreibung: korrektes Deutsch mit ß (z. B. "regelmäßig"), "du" klein. Fragen enden mit Fragezeichen.
- caption: TikTok-Beschreibung, 1 Satz plus 3-5 Hashtags (z. B. #webdesign #wien), maximal 150 Zeichen.
${feedback}`;

  const r = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { authorization: `Bearer ${need("OPENAI_API_KEY")}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || "gpt-5.4",
      input: prompt,
      text: {
        format: {
          type: "json_schema",
          name: "tiktok_texts",
          strict: true,
          schema: { type: "object", additionalProperties: false, required: Object.keys(props), properties: props },
        },
      },
    }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`OpenAI ${r.status}: ${JSON.stringify(j.error || j)}`);
  const text = j.output_text ?? j.output?.flatMap((o) => o.content || []).find((c) => c.type === "output_text")?.text;
  return JSON.parse(text);
}

async function texts(topic) {
  let feedback = "";
  for (let attempt = 1; attempt <= 5; attempt++) {
    const t = await writeTexts(topic, feedback);
    const problems = Object.entries(LIMITS)
      .filter(([k, n]) => !t[k] || t[k].length > n)
      .map(([k, n]) => `${k}: "${t[k] ?? ""}" hat ${(t[k] ?? "").length} Zeichen, erlaubt sind ${n}`);
    if (t.caption.length > 150) problems.push(`caption hat ${t.caption.length} Zeichen, erlaubt sind 150`);
    if (!problems.length) return t;
    // Name each offending field with its length so the model can fix exactly those.
    feedback = `Dein vorheriger Versuch war in diesen Feldern zu lang. Formuliere genau diese Felder kürzer (andere Wörter, nicht abschneiden), alle anderen dürfen gleich bleiben:
- ${problems.join("
- ")}`;
    console.log(`Versuch ${attempt}: ${problems.join(" | ")}`);
  }
  throw new Error("OpenAI hält die Zeichenlimits nicht ein");
}

const topic = pickTopic();
console.log(`Thema: ${topic}`);
const t = await texts(topic);
const { caption, ...vars } = t;
console.log(JSON.stringify(t, null, 2));
writeFileSync(varsFile, JSON.stringify(vars));

execFileSync("npx", ["--yes", "hyperframes@0.8.134", "render", "--strict-variables", "--variables-file", varsFile, "-o", out], {
  cwd: templateDir,
  stdio: "inherit",
  shell: process.platform === "win32",
});
const size = statSync(out).size;
console.log(`Gerendert: ${(size / 1e6).toFixed(1)} MB`);

if (process.env.DRY_RUN === "1") {
  console.log("DRY_RUN: kein Upload");
} else {
  const r = await fetch(`${need("AUTOPOSTER_URL").replace(/\/$/, "")}/api/ingest`, {
    method: "POST",
    headers: {
      "content-type": "video/mp4",
      "x-autoposter-secret": need("AUTOPOSTER_SECRET"),
      "x-meta": encodeURIComponent(JSON.stringify({ topic, caption, vars, duration: 15 })),
    },
    body: readFileSync(out),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Upload ${r.status}: ${JSON.stringify(j)}`);
  console.log(`Hochgeladen, wartet auf Freigabe: ${j.id}`);
}
