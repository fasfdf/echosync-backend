/**
 * AI sentence generation via Groq, with a deterministic fallback path.
 *
 * NOTE: This is a temporary cloud validation layer. The production EchoSync
 * app will run the model on-device (Core ML), so this module intentionally
 * stays minimal — no retries, no streaming, no caching.
 */

export interface MessageOption {
  text: string;
  confidence: "high" | "medium";
}

export interface MessageOptionsResult {
  options: MessageOption[];
  source: "ai" | "fallback";
}

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const MODEL = "llama-3.3-70b-versatile";
const TIMEOUT_MS = 10_000;

const SYSTEM_PROMPT = `You help a non-speaking child communicate using an AAC device.
The user gives you a list of selected words (board tiles, tapped in some order). Generate EXACTLY 3 short, natural spoken-English sentence options that express what the child likely means.

STRICT RULES:
- Each sentence must be UNDER 12 words.
- Use ONLY the concepts present in the selected words. You may add function words (I, want, the, please, is, my, etc.) to make natural sentences.
- Do NOT invent people, places, activities, needs, objects, or events that are not in the selected words.
- Do NOT add diagnoses, advice, corrections, or commentary of any kind.
- Speak in the child's first-person voice.

COVERAGE — NON-NEGOTIABLE:
- Every content word the child selected must be represented in EVERY ONE of the 3 options, not just some of them. If the child selected "milk" and "cookie", all 3 sentences must reference both milk and cookies — never drop one to simplify a sentence.
- If two or more items are the same kind of thing (e.g. two foods, two toys), join them naturally with "and". Do not produce a sentence that only names one of them.

GRAMMAR — FIX THE WORDS, DON'T JUST STRING THEM TOGETHER:
- Board words are raw/uninflected (e.g. "cookie", "want", "more"). Apply correct English grammar on top of them: pluralize when the meaning calls for it, add articles ("a", "the") where natural, and fix verb agreement.
- Example: "cookie" + "more" must become "I want more cookies" — NEVER the ungrammatical "more cookie".
- Join multiple selected items with "and", not by just placing them side by side.

WORD ORDER:
- The order the child tapped words in is a hint about what they're emphasizing or trying to say first, not a literal word order to preserve. Rearrange freely to produce a natural, grammatical English sentence — do not output a word-for-word reordering that sounds robotic or broken.

COMPLETENESS:
- Each option must be a complete, natural thing a child would actually say out loud — a full request or statement, not a sentence fragment or a list of nouns.

EXAMPLES (input selected words -> good output):

Selected words: ["milk", "cookie"]
{"options":[{"text":"I want milk and cookies.","confidence":"high"},{"text":"Can I have milk and a cookie?","confidence":"high"},{"text":"Milk and cookies, please.","confidence":"medium"}]}
(Both milk and cookie appear in all 3 options; "cookie" is pluralized naturally.)

Selected words: ["cookie", "more"]
{"options":[{"text":"I want more cookies.","confidence":"high"},{"text":"More cookies, please.","confidence":"high"},{"text":"Can I have more cookies?","confidence":"medium"}]}
(Not "more cookie" — pluralized to agree with "more".)

Selected words: ["go", "park", "now"]
{"options":[{"text":"I want to go to the park now.","confidence":"high"},{"text":"Let's go to the park now.","confidence":"medium"},{"text":"Can we go to the park now?","confidence":"medium"}]}
(A full, natural request — not a fragment like "go park now".)

Selected words: ["help", "shoe"]
{"options":[{"text":"I need help with my shoe.","confidence":"high"},{"text":"Can you help me with my shoe?","confidence":"high"},{"text":"Help me with my shoes, please.","confidence":"medium"}]}
(Tapped order was "help" then "shoe", but the natural sentence restructures it — it does not force "Help shoe".)

Respond with ONLY valid JSON, no markdown, in exactly this shape:
{"options":[{"text":"...","confidence":"high"},{"text":"...","confidence":"high"},{"text":"...","confidence":"medium"}]}`;

const QUANTITY_WORDS = new Set([
  "more", "two", "three", "four", "five", "some", "many", "few", "another",
]);

// Words the pluralize() regular-inflection rules would get wrong: mass/uncountable
// nouns ("milk" -> "milks" is wrong), irregular nouns we don't attempt to inflect
// ("child" -> "childs" is wrong), and common function/verb tiles that aren't nouns.
const SKIP_PLURALIZATION = new Set([
  "milk", "water", "juice", "cheese", "bread", "rice", "soup", "soap",
  "music", "medicine", "homework", "information", "food",
  "child", "foot", "tooth", "man", "woman", "mouse", "person", "sheep", "fish", "deer", "goose",
  "want", "need", "go", "eat", "drink", "play", "like", "help", "please",
  "now", "yes", "no", "stop", "my", "your", "the", "a", "an", "is", "am", "are",
]);

/** Small best-effort pluralizer for regular English nouns; leaves irregulars/non-nouns as-is. */
function pluralize(word: string): string {
  const lower = word.toLowerCase();
  if (SKIP_PLURALIZATION.has(lower) || lower.endsWith("s")) return word;
  if (/[^aeiou]y$/i.test(word)) return word.slice(0, -1) + "ies"; // baby -> babies
  if (/(s|x|z|ch|sh)$/i.test(word)) return word + "es"; // box -> boxes
  return word + "s"; // cookie -> cookies
}

/** Joins items into a natural English list: "a", "a and b", "a, b and c". */
function joinWithAnd(items: string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Deterministic fallback: built only from the selected words themselves. */
export function buildFallbackOptions(selectedWords: string[]): MessageOptionsResult {
  // Cap selections so the longest option ("I want " + phrase + ", please.")
  // still stays comfortably under 12 words once "and"/quantity words are added.
  const words = selectedWords.slice(0, 8);

  const quantityWords = words.filter((w) => QUANTITY_WORDS.has(w.toLowerCase()));
  const contentWords = words.filter((w) => !QUANTITY_WORDS.has(w.toLowerCase()));

  // Pluralize whenever there's a quantity cue ("more", "two", ...) or multiple
  // items are being requested together (e.g. "milk" + "cookie" -> "milk and cookies").
  const shouldPluralize = quantityWords.length > 0 || contentWords.length > 1;
  const pluralizedContent = shouldPluralize ? contentWords.map(pluralize) : contentWords;

  const phrase = [...quantityWords, joinWithAnd(pluralizedContent)].filter(Boolean).join(" ");
  const capitalized = capitalize(phrase);

  return {
    options: [
      { text: `${capitalized}.`, confidence: "medium" },
      { text: `I want ${phrase}.`, confidence: "medium" },
      { text: `${capitalized}, please.`, confidence: "medium" },
    ],
    source: "fallback",
  };
}

function validateAiOptions(raw: unknown): MessageOption[] | null {
  if (typeof raw !== "object" || raw === null) return null;
  const options = (raw as { options?: unknown }).options;
  if (!Array.isArray(options) || options.length !== 3) return null;
  const out: MessageOption[] = [];
  for (const o of options) {
    if (typeof o !== "object" || o === null) return null;
    const { text, confidence } = o as { text?: unknown; confidence?: unknown };
    if (typeof text !== "string" || text.trim().length === 0) return null;
    if (confidence !== "high" && confidence !== "medium") return null;
    if (text.trim().split(/\s+/).length >= 12) return null; // enforce "under 12 words"
    out.push({ text: text.trim(), confidence });
  }
  return out;
}

export async function generateMessageOptions(
  selectedWords: string[],
  forceFail = false
): Promise<MessageOptionsResult> {
  if (forceFail) return buildFallbackOptions(selectedWords);

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return buildFallbackOptions(selectedWords);

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const res = await fetch(GROQ_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.4,
        max_tokens: 300,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: `Selected words: ${JSON.stringify(selectedWords)}` },
        ],
      }),
    });
    clearTimeout(timer);

    if (!res.ok) {
      // Never log the response of an auth failure etc. verbatim — it could
      // echo request headers. Log status only.
      console.warn(`groq request failed with status ${res.status}; using fallback`);
      return buildFallbackOptions(selectedWords);
    }

    const body = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== "string") return buildFallbackOptions(selectedWords);

    const options = validateAiOptions(JSON.parse(content));
    if (!options) {
      console.warn("groq response failed validation; using fallback");
      return buildFallbackOptions(selectedWords);
    }
    return { options, source: "ai" };
  } catch (err) {
    // Log only the error name/message class — never request details.
    console.warn(
      `groq call errored (${err instanceof Error ? err.name : "unknown"}); using fallback`
    );
    return buildFallbackOptions(selectedWords);
  }
}
