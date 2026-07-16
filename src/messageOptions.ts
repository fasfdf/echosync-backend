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
The user gives you a list of selected words. Generate EXACTLY 3 short, natural spoken-English sentence options that express what the child likely means.

STRICT RULES:
- Each sentence must be UNDER 12 words.
- Use ONLY the concepts present in the selected words. You may add function words (I, want, the, please, is, my, etc.) to make natural sentences.
- Do NOT invent people, places, activities, needs, objects, or events that are not in the selected words.
- Do NOT add diagnoses, advice, corrections, or commentary of any kind.
- Speak in the child's first-person voice.

Respond with ONLY valid JSON, no markdown, in exactly this shape:
{"options":[{"text":"...","confidence":"high"},{"text":"...","confidence":"high"},{"text":"...","confidence":"medium"}]}`;

/** Deterministic fallback: built only from the selected words themselves. */
export function buildFallbackOptions(selectedWords: string[]): MessageOptionsResult {
  // Keep each option under 12 words even with long selections.
  const words = selectedWords.slice(0, 9);
  const joined = words.join(" ");
  const capitalized = joined.charAt(0).toUpperCase() + joined.slice(1);
  return {
    options: [
      { text: `${capitalized}.`, confidence: "medium" },
      { text: `I want ${joined}.`, confidence: "medium" },
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
