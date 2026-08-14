// The full emoji catalogue for reactions on the web.
//
// Mobile has had this since 2026-08-07 (EmojiPickerSheet); desktop only ever
// offered the six quick reactions, which Daniel spotted on 2026-08-15 — the two
// clients disagreed about what a reaction could be.
//
// `unicode-emoji-json` is DATA only — a JSON dump from unicode.org with zero
// runtime JS and no React dependency — so it carries none of the "does this
// still work on the current React" risk a picker COMPONENT library would. Same
// reasoning as the mobile app, and deliberately the same dataset so the two
// clients can't drift.
import { useMemo, useState, useEffect } from "react";
import dataByGroup from "unicode-emoji-json/data-by-group.json";
import { Search } from "lucide-react";

interface Entry { emoji: string; name: string }

// Recent picks live in localStorage so the emoji someone actually uses is one
// tap away — the quick row is a guess, this is their real habit.
const RECENT_KEY = "clubos_chat_recent_emoji";
const RECENT_MAX = 24;

export function readRecentEmoji(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    return raw ? (JSON.parse(raw) as string[]).slice(0, RECENT_MAX) : [];
  } catch { return []; }
}
export function rememberEmoji(emoji: string): void {
  try {
    const next = [emoji, ...readRecentEmoji().filter((e) => e !== emoji)].slice(0, RECENT_MAX);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch { /* private mode — a lost history must never break reacting */ }
}

const GROUPS: { key: string; label: string; glyph: string }[] = [
  { key: "Smileys & Emotion", label: "Smileys", glyph: "😀" },
  { key: "People & Body", label: "People", glyph: "👍" },
  { key: "Animals & Nature", label: "Nature", glyph: "🌿" },
  { key: "Food & Drink", label: "Food", glyph: "🍕" },
  { key: "Activities", label: "Activity", glyph: "⚽" },
  { key: "Travel & Places", label: "Travel", glyph: "✈️" },
  { key: "Objects", label: "Objects", glyph: "💡" },
  { key: "Symbols", label: "Symbols", glyph: "❤️" },
  { key: "Flags", label: "Flags", glyph: "🏳️" },
];

export function EmojiPicker({ onPick }: { onPick: (emoji: string) => void }) {
  const [q, setQ] = useState("");
  const [group, setGroup] = useState(GROUPS[0].key);
  const [recent, setRecent] = useState<string[]>([]);

  useEffect(() => { setRecent(readRecentEmoji()); }, []);

  const byGroup = dataByGroup as unknown as Record<string, Entry[]>;

  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (s) {
      // Search every group, not just the open one — nobody knows which
      // category "rocket" lives in.
      const out: Entry[] = [];
      for (const g of GROUPS) {
        for (const e of byGroup[g.key] ?? []) {
          if (e.name.toLowerCase().includes(s)) out.push(e);
          if (out.length >= 90) break;
        }
        if (out.length >= 90) break;
      }
      return out;
    }
    return (byGroup[group] ?? []).slice(0, 240);
  }, [q, group, byGroup]);

  const pick = (emoji: string) => { rememberEmoji(emoji); onPick(emoji); };

  return (
    <div className="w-[302px]" data-testid="emoji-picker">
      <div className="relative p-2 pb-1.5">
        <Search className="w-3.5 h-3.5 text-white/25 absolute left-4 top-1/2 -translate-y-1/2" />
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search emoji"
          data-testid="input-emoji-search"
          className="w-full bg-white/[0.05] border border-white/10 rounded-lg pl-8 pr-2.5 py-1.5 text-[12.5px] text-white/90 placeholder:text-white/25 outline-none focus:border-white/25"
        />
      </div>

      {!q && recent.length > 0 && (
        <div className="px-2 pb-1">
          <div className="text-[10px] uppercase tracking-wider text-white/25 px-0.5 pb-1">Recent</div>
          <div className="flex flex-wrap">
            {recent.slice(0, 16).map((e) => (
              <button key={`r-${e}`} onClick={() => pick(e)}
                      className="w-8 h-8 text-[17px] rounded-lg hover:bg-white/[0.08]">{e}</button>
            ))}
          </div>
        </div>
      )}

      <div className="max-h-[190px] overflow-y-auto px-2 pb-1">
        <div className="flex flex-wrap">
          {shown.map((e) => (
            <button
              key={e.emoji}
              onClick={() => pick(e.emoji)}
              title={e.name}
              data-testid={`emoji-${e.emoji}`}
              className="w-8 h-8 text-[17px] rounded-lg hover:bg-white/[0.08]"
            >
              {e.emoji}
            </button>
          ))}
          {shown.length === 0 && (
            <p className="text-[12px] text-white/30 px-1 py-3">No emoji match that.</p>
          )}
        </div>
      </div>

      {!q && (
        <div className="flex border-t border-white/[0.07] px-1">
          {GROUPS.map((g) => (
            <button
              key={g.key}
              onClick={() => setGroup(g.key)}
              title={g.label}
              className={`flex-1 h-8 text-[15px] rounded-lg ${group === g.key ? "bg-white/[0.1]" : "hover:bg-white/[0.06] opacity-60"}`}
            >
              {g.glyph}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
