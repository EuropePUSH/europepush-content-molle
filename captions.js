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
  "If you know, you *know*.",
  // EXPANDED pool (40+ total to reduce repetition over months)
  "That fresh feeling hits different at 2am",
  "When the mint is stronger than your self control",
  "Main character energy in a small tin",
  "Cool down, level up",
  "Zero effort maximum vibe shift",
  "The upgrade nobody asked about but everyone noticed",
  "Underrated but never underestimated",
  "Ice cold mentality starts here",
  "Just a little something to switch the mood",
  "That crisp focus when you need it most",
  "Subtle chaos in your pocket",
  "The vibe check nobody saw coming",
  "When minty fresh becomes a lifestyle",
  "This one hits at the right time every time",
  "Energy shift loading",
  "Small moves big changes",
  "The comeback starts with the comeback flavor",
  "Quiet confidence loud results",
  "Chill mode activated",
  "That one thing that just makes sense"
];

const HASHTAGS = [
  "#fyp", "#foryou", "#viral", "#europe", "#eu",
  "#snooze", "#snoozetok",
  "#iceberg", "#maggie", "#pablo",
  "#mint", "#ice", "#chillvibes", "#nightdrive", "#dailyvibes",
  "#focusmode", "#energycheck", "#lowkey", "#aesthetic", "#cleanedit",
  "#pouch", "#nic", "#prilla", "#icy",
  // EXPANDED pool (50+ total to avoid repetition)
  "#vibes", "#mood", "#energy", "#fresh", "#crisp",
  "#coldvibes", "#frosty", "#chill", "#relax", "#focus",
  "#nightlife", "#latenight", "#midnightvibes", "#afterhours",
  "#minimal", "#clean", "#smooth", "#pure", "#simple",
  "#upgrade", "#levelup", "#nextlevel", "#newera", "#switch",
  "#dailyroutine", "#habit", "#lifestyle", "#vibe", "#shift"
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

  // ANTI-SHADOWBAN: Vary caption presentation styles
  const captionStyles = [
    (c) => c,                           // Original
    (c) => c.toLowerCase(),             // all lowercase
    (c) => `${c} 👀`,                   // Add emoji
    (c) => c.replace(/\./g, ''),        // Remove periods
    (c) => `${c.split('.')[0]}...`,     // Ellipsis
  ];

  const items = [];
  for (let i = 0; i < count; i++) {
    const rawCaption = caps[i % caps.length];
    const style = captionStyles[i % captionStyles.length];
    const caption = style(rawCaption);

    // ANTI-SHADOWBAN: Vary hashtag count per clip (6-10)
    const needed = 6 + Math.floor(Math.random() * 5); // 6–10 hashtags
    const itemTags = [];

    // rotate the pool so we don’t repeat patterns too much
    const start = (i * 3) % tags.length;
    const pool = [...tags.slice(start), ...tags.slice(0, start)];

    for (const t of pool) {
      if (!itemTags.includes(t)) itemTags.push(t);
      if (itemTags.length >= needed) break;
    }

    // ANTI-SHADOWBAN: Shuffle hashtag order per video
    const shuffledTags = shuffle(itemTags);

    items.push({ caption, hashtags: shuffledTags });
  }

  return { id: `caps_${nanoid(6)}`, items };
}