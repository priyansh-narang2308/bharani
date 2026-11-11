import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { NoteDraftSchema, type ExtractContext, type Extractor } from "./schema";

export const DEFAULT_MODEL = process.env.BHARANI_MODEL ?? "claude-opus-5-5";

const SYSTEM = `You read short spoken notes from home kitchens that make pickles and other foods for a shared brand.
Notes are often Hindi, English or a mix, transcribed by speech recognition, so spelling varies.
Fill the form from the note only.
Rules:
- Copy words exactly as they appear in the note into every *_words field and into inputs[].words.
- Choose ingredient, product and buyer only from the lists given. If none clearly fits, use null.
- ingredient_confidence: "stated" if the note names it plainly, "likely" if it is a local or vague name you can map, "unsure" otherwise.
- Never invent quantities, codes, suppliers or buyers. Leave a field null when the note does not say it.
- Put anything the coordinator should ask about into unclear, as a short question.`;

/** Model-backed extraction. Its output is a proposal that the grounding check and a person still review. */
export class ClaudeExtractor implements Extractor {
  readonly name: string;
  private client: Anthropic;
  constructor(private model = DEFAULT_MODEL, client?: Anthropic) {
    this.client = client ?? new Anthropic();
    this.name = `claude:${model}`;
  }
  async extract(transcript: string, ctx: ExtractContext) {
    const started = performance.now();
    const lists = [
      `Kitchen: ${ctx.kitchenName}. Date: ${ctx.date}.`,
      `Ingredients: ${ctx.ingredients.map((i) => (i.aliases.length ? `${i.name} (also called ${i.aliases.join(", ")})` : i.name)).join("; ")}`,
      `Products: ${ctx.products.join("; ")}`,
      `Buyers: ${ctx.buyers.join("; ")}`,
    ].join("\n");
    const response = await this.client.messages.parse({
      model: this.model,
      max_tokens: 4000,
      system: SYSTEM,
      output_config: { format: zodOutputFormat(NoteDraftSchema), effort: "low" },
      messages: [{ role: "user", content: `${lists}\n\nNote:\n"""${transcript}"""` }],
    });
    if (response.stop_reason === "refusal") throw new Error("Model declined to read this note");
    if (!response.parsed_output) throw new Error("Model output did not match the form");
    return {
      draft: response.parsed_output,
      meta: {
        source: "model" as const,
        model: response.model,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        ms: performance.now() - started,
      },
    };
  }
}

/** Plays back outputs recorded from a real model run, so tests are repeatable. Labelled as replay everywhere. */
export class ReplayExtractor implements Extractor {
  readonly name = "replay";
  constructor(private recorded: Record<string, unknown>) {}
  async extract(transcript: string) {
    const hit = this.recorded[transcript];
    if (!hit) throw new Error("No recorded output for this note");
    return { draft: NoteDraftSchema.parse(hit), meta: { source: "replay" as const, ms: 0 } };
  }
}
