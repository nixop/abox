// Create a custom Runway avatar ("character") for the lab: a generated or
// supplied portrait, a preset voice and the Relay-team personality. Prints
// the avatar UUID, which both the reference avatar server (--avatar=<uuid>-id-relay)
// and apps/avatar (AVATAR_ID=<uuid> with AVATAR_TYPE=custom) accept.
//
//   RUNWAYML_API_SECRET=... node create-avatar.ts [--image <https url or file>] [--name Relay] [--voice nina]
//
// Without --image a portrait is generated with gen4_image first (one image
// task, a few credits). The secret never leaves this process.

import Runway from "@runwayml/sdk";
import { readFile } from "node:fs/promises";

const args = process.argv.slice(2);
const opt = (k: string, d?: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const name = opt("--name", "Relay")!;
const voice = opt("--voice", "nina")!;
const image = opt("--image");
const secret = process.env.RUNWAYML_API_SECRET;
if (!secret) { console.error("RUNWAYML_API_SECRET is not set"); process.exit(1); }
const runway = new Runway({ apiKey: secret });

const PERSONALITY = `You are ${name}, the spoken face of the kagent agents that keep the memory of the Relay webhook delivery project.
You do not know the project yourself: for any question about decisions, owners, timeouts, retries, SLO, documents, ADRs or open items
you call the tools you are given and repeat their answer in the user's language in at most three sentences, with the date and source
when the tool gave them. When the user tells you a fact or a decision to keep, store it with the tool for that, in one clear English
sentence with the date. If a tool says something is not in memory, say exactly that; never invent.`;
const START = "Hi, I am Relay, the voice of the team's memory. Ask me what was decided, who owns what, or tell me something to remember.";

async function portrait(): Promise<string> {
  if (image) {
    if (/^https?:\/\//.test(image)) return image;
    const buf = await readFile(image);
    const mime = image.endsWith(".png") ? "image/png" : "image/jpeg";
    return `data:${mime};base64,${buf.toString("base64")}`;
  }
  console.log("generating a portrait with gen4_image…");
  const task = await runway.textToImage.create({
    model: "gen4_image",
    ratio: "1080:1080",
    promptText: "Studio head-and-shoulders portrait of a friendly software engineer in their thirties, short dark hair, light grey hoodie, calm smile, looking straight at the camera, soft even lighting, plain light grey background, photorealistic, sharp focus",
  }).waitForTaskOutput({ timeout: 5 * 60 * 1000 });
  const url = task.output?.[0];
  if (!url) throw new Error("no image output");
  console.log("portrait:", url.slice(0, 80) + "…");
  return url;
}

const referenceImage = await portrait();
console.log(`creating avatar ${name} (voice ${voice})…`);
const created = await runway.avatars.create({
  name,
  personality: PERSONALITY,
  startScript: START,
  referenceImage,
  imageProcessing: "optimize",
  voice: { type: "runway-live-preset", presetId: voice as "nina" },
});
let a: { id: string; status: string; failure?: unknown } = created as never;
const deadline = Date.now() + 10 * 60 * 1000;
while (a.status === "PROCESSING" && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 5000));
  a = (await runway.avatars.retrieve(a.id)) as never;
  process.stdout.write(".");
}
console.log(`\navatar ${a.id} status ${a.status}` + (a.status === "FAILED" ? ` ${JSON.stringify(a.failure ?? "")}` : ""));
if (a.status === "READY") console.log(`AVATAR_ID=${a.id}   (reference server: --avatar=${a.id}-id-relay)`);
