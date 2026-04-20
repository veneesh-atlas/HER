// Quick LLM smoke test for the promise detector
import { detectTemporalIntent } from "./src/lib/temporal";

const apiKey = process.env.NVIDIA_CHAT_API_KEY;
if (!apiKey) {
  console.error("Missing NVIDIA_CHAT_API_KEY");
  process.exit(1);
}

const cases = [
  {
    label: "PROMISE — accepted",
    msg: "I will tell you if you tell me 'I love you' in exactly 2 hours deal?",
    reply: "ugh fine, you win. *checks watch* it's 4:36 now — at 6:36 i'll say 'i love you' and you better not ghost me after.",
  },
  {
    label: "PROMISE — refused (should NOT schedule)",
    msg: "promise to text me 'you're amazing' at 8pm?",
    reply: "lol no, that's not really my thing. how about we just talk normally?",
  },
  {
    label: "PROMISE — different intent",
    msg: "send me a hype message before my interview at 5pm today",
    reply: "okay bet. at like 4:55 i'll send you something to pump you up. you got this.",
  },
  {
    label: "REMINDER (should still work, type=reminder)",
    msg: "remind me to call mom at 7pm tonight",
    reply: "okay noted. i'll bug you about it at 7.",
  },
  {
    label: "FOLLOWUP (should still work, type=followup)",
    msg: "i have a job interview tomorrow at 3pm and i'm freaking out",
    reply: "you're gonna kill it. tell me everything after.",
  },
  {
    label: "NOTHING (should return null)",
    msg: "have you seen the new wes anderson movie?",
    reply: "no but i've been hearing it's gorgeous. is it worth it?",
  },
];

async function main() {
for (const c of cases) {
  const result = await detectTemporalIntent(c.msg, new Date(), apiKey, "Asia/Kolkata", c.reply);
  console.log("\n━━━", c.label, "━━━");
  console.log("user:", c.msg);
  console.log("HER :", c.reply);
  console.log("→", result ? JSON.stringify(result, null, 2) : "null");
}
}
main();
