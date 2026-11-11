import { z } from "zod";

/**
 * What a model may return for one spoken note. Every text field that names
 * something must be copied from the note itself; the grounding check removes
 * anything that is not. The model never sees or returns lot ids.
 */
export const QtySchema = z.object({
  value: z.number(),
  unit: z.enum(["g", "kg", "ml", "l", "jar", "piece"]),
});
export const NoteDraftSchema = z.object({
  kind: z.enum(["batch", "dispatch", "receipt", "unclear"]),
  product_words: z.string().nullable().describe("Words in the note that name the product, copied exactly, or null"),
  product: z.string().nullable().describe("One of the product names provided, or null if none clearly fits"),
  made: QtySchema.nullable(),
  batch_code: z.string().nullable(),
  inputs: z.array(
    z.object({
      words: z.string().describe("The exact words in the note for this ingredient"),
      ingredient: z.string().nullable().describe("One of the ingredient names provided, or null if unsure"),
      ingredient_confidence: z.enum(["stated", "likely", "unsure"]),
      qty: QtySchema.nullable(),
      supplier_words: z.string().nullable(),
      lot_code_words: z.string().nullable(),
      batch_words: z.string().nullable().describe("If this input is an earlier batch, such as a masala mix, the words used"),
    }),
  ),
  dispatches: z.array(
    z.object({
      buyer_words: z.string(),
      buyer: z.string().nullable().describe("One of the buyer names provided, or null"),
      qty: QtySchema.nullable(),
    }),
  ),
  unclear: z.array(z.string()).describe("Things the note leaves unclear, as short questions"),
});
export type NoteDraft = z.infer<typeof NoteDraftSchema>;

export interface ExtractContext {
  kitchenName: string;
  date: string;
  ingredients: { name: string; aliases: string[] }[];
  products: string[];
  buyers: string[];
}
export interface ExtractMeta {
  source: "model" | "rules" | "replay";
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  ms: number;
}
export interface Extractor {
  readonly name: string;
  extract(transcript: string, ctx: ExtractContext): Promise<{ draft: NoteDraft; meta: ExtractMeta }>;
}
