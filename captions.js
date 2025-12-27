import { nanoid } from "nanoid";

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const CAPTIONS = [
  "That icy hit when you least expect it 🧊",
  "One pouch and suddenly it’s a new personality.",
  "This is your sign to switch the vibe.",
  "Minty? Or *menace*? 😈",
  "Clean look, questionable decisions.",
  "POV: you’re “just chilling” but your pulse says otherwise.",
  "If it’s too quiet… you know what to do.",
  "The tiny habit that starts big energy.",
  "Low effort. High effect.",
  "Mood: ice-cold focus.",
  "Not a phase. It’s a flavor profile.",
  "When the vibe is crisp, everything else follows.",
  "IYKYK… the pouch people get it.",
  "A little pick-me-up, but make it subtle.",
  "This isn’t a routine, it’s a ritual.",
  "The quiet flex no one talks about.",
  "One of those “don’t ask” habits.",
  "Soft launch of bad influence.",
  "Crisp taste, chaotic plans.",
  "If you know, you *know*."
];

const HASHTAGS = [
  "#fyp", "#foryou", "#viral", "#europe", "#eu",
  "#snooze", "#snoozetok",
  "#iceberg", "#maggie", "#pablo",
  "#mint", "#ice", "#chillvibes", "#nightdrive", "#dailyvibes",
  "#focusmode", "#energycheck", "#lowkey", "#aesthetic", "#cleanedit",
  "#pouch", "#nic", "#prilla", "#icy"
];

export function makeBatchCaptions({ count, noCaptionMode, theme }) {
  if (noCaptionMode) {
    return {
      id: `caps_${nanoid(6)}`,
      items: Array.from({ length: count }).map(() => ({
        caption: "",
        hashtags: []
      }))
    };
  }

  // Ensure unique captions per batch
  const caps = shuffle(CAPTIONS);
  const tags = shuffle(HASHTAGS);

  const items = [];
  for (let i = 0; i < count; i++) {
    const caption = caps[i % caps.length];

    // 6–9 hashtags, no repeats inside the same item
    const itemTags = [];
    const needed = 8;

    // rotate the pool so we don’t repeat patterns too much
    const start = (i * 3) % tags.length;
    const pool = [...tags.slice(start), ...tags.slice(0, start)];

    for (const t of pool) {
      if (!itemTags.includes(t)) itemTags.push(t);
      if (itemTags.length >= needed) break;
    }

    items.push({ caption, hashtags: itemTags });
  }

  return { id: `caps_${nanoid(6)}`, items };
}