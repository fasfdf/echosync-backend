import { z } from "zod";

export const TONES = ["neutral", "excited", "asking", "upset"] as const;
export const SOURCES = ["ai", "literal", "fallback"] as const;

/** A single selected word: non-empty, sane length, no control chars. */
const word = z
  .string()
  .trim()
  .min(1, "words must be non-empty strings")
  .max(40, "words must be 40 characters or fewer");

export const messageOptionsSchema = z
  .object({
    selectedWords: z
      .array(word)
      .min(1, "selectedWords must contain at least 1 word")
      .max(12, "selectedWords must contain at most 12 words"),
    forceFail: z.boolean().optional(),
  })
  .strict();

const isoDate = z
  .string()
  .refine((s) => !Number.isNaN(Date.parse(s)), "must be a valid ISO-8601 timestamp");

export const eventSchema = z
  .object({
    selected_words: z.array(word).min(1).max(12),
    selected_message: z.string().trim().min(1).max(500),
    selected_tone: z.enum(TONES),
    source: z.enum(SOURCES),
    message_started_at: isoDate,
    spoken_at: isoDate,
  })
  .strict()
  .refine(
    (e) => Date.parse(e.spoken_at) >= Date.parse(e.message_started_at),
    { message: "spoken_at must not be earlier than message_started_at" }
  );

export type MessageOptionsInput = z.infer<typeof messageOptionsSchema>;
export type EventInput = z.infer<typeof eventSchema>;
