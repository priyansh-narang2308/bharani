import { ClaudeExtractor } from "@/extract/claude";
import { groundDraft } from "@/extract/ground";

const ctx = {
  kitchenName: "Meena",
  date: "2026-11-10",
  ingredients: [
    { name: "chilli powder", aliases: ["lal mirch", "mirchi powder"] },
    { name: "mustard oil", aliases: ["sarson tel", "sarson ka tel"] },
    { name: "salt", aliases: ["namak"] },
    { name: "raw mango", aliases: ["kairi", "kachha aam"] },
  ],
  products: ["Mango pickle", "Lemon pickle"],
  buyers: ["Sharma Kirana", "Girls hostel canteen"],
};
const note = "aaj mango pickle banaya, 40 dabbe. kairi 12 kilo, sarson tel 3 litre, namak dedh kilo, aur laal wala powder jo Raju bhaiya se aaya tha, 1 kilo";
const x = new ClaudeExtractor();
try {
  const { draft, meta } = await x.extract(note, ctx);
  const g = groundDraft(note, draft, ctx);
  console.log(JSON.stringify({ meta, draft: g.draft, issues: g.issues }, null, 2));
} catch (e) {
  const err = e as { status?: number; message?: string };
  console.log("LIVE CALL FAILED", err.status ?? "", String(err.message ?? e).slice(0, 300));
}
