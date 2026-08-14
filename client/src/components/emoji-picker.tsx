// The full emoji catalogue for reactions on the web.
//
// Mobile has had this since 2026-08-07 (EmojiPickerSheet); desktop only ever
// offered the six quick reactions, which Daniel spotted on 2026-08-15 — the two
// clients disagreed about what a reaction could be.
//
// 🔴 `unicode-emoji-json/data-by-group.json` is an ARRAY of
// `{ name, slug, emojis: [{ emoji, name }] }` — NOT an object keyed by group
// name. The first cut indexed it as a map, every lookup came back undefined and
// the grid rendered empty while the category tabs looked fine. Check the shape,
// don't assume it.
//
// The dataset is DATA only — a JSON dump from unicode.org with no runtime JS and
// no React dependency — so it carries none of the "does this still work on the
// current React" risk a picker COMPONENT library would. Deliberately the same
// dataset the mobile app uses, so the two clients cannot drift apart again.
import { useMemo, useState, useEffect } from "react";
import rawGroups from "unicode-emoji-json/data-by-group.json";
import { Search } from "lucide-react";

interface Emoji { emoji: string; name: string }
interface Group { name: string; slug: string; emojis: Emoji[] }

const GROUPS = rawGroups as unknown as Group[];

// A representative glyph per category, for the tab strip.
const TAB_GLYPH: Record<string, string> = {
  smileys_emotion: "😀",
  people_body: "👍",
  animals_nature: "🌿",
  food_drink: "🍕",
  travel_places: "✈️",
  activities: "⚽",
  objects: "💡",
  symbols: "❤️",
  flags: "🏳️",
};

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

export function EmojiPicker({ onPick }: { onPick: (emoji: string) => void }) {
  const [q, setQ] = useState("");
  const [slug, setSlug] = useState(GROUPS[0]?.slug ?? "smileys_emotion");
  const [recent, setRecent] = useState<string[]>([]);

  useEffect(() => { setRecent(readRecentEmoji()); }, []);

  const shown = useMemo<Emoji[]>(() => {
    const s = q.trim().toLowerCase();
    if (s) {
      // Search every category — nobody knows which one "rocket" lives in.
      const out: Emoji[] = [];
      for (const g of GROUPS) {
        for (const e of g.emojis) {
          if (e.name.toLowerCase().includes(s)) out.push(e);
          if (out.length >= 120) return out;
        }
      }
      return out;
    }
    return GROUPS.find((g) => g.slug === slug)?.emojis ?? [];
  }, [q, slug]);

  const pick = (emoji: string) => { rememberEmoji(emoji); onPick(emoji); };

  return (
    <div className="w-[304px]" data-testid="emoji-picker">
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
                      data-testid={`emoji-recent-${e}`}
                      className="w-8 h-8 text-[17px] rounded-lg hover:bg-white/[0.08]">{e}</button>
            ))}
          </div>
        </div>
      )}

      <div className="h-[196px] overflow-y-auto px-2 pb-1" data-testid="emoji-grid">
        {!q && (
          <div className="text-[10px] uppercase tracking-wider text-white/25 px-0.5 py-1 sticky top-0 bg-[#16171a]">
            {GROUPS.find((g) => g.slug === slug)?.name}
          </div>
        )}
        <div className="flex flex-wrap">
          {shown.map((e) => (
            <button
              key={e.emoji}
              onClick={() => pick(e.emoji)}
              title={e.name}
              data-testid="emoji-option"
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
              key={g.slug}
              onClick={() => setSlug(g.slug)}
              title={g.name}
              data-testid={`emoji-tab-${g.slug}`}
              className={`flex-1 h-8 text-[15px] rounded-lg ${slug === g.slug ? "bg-white/[0.1]" : "hover:bg-white/[0.06] opacity-55"}`}
            >
              {TAB_GLYPH[g.slug] ?? "•"}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The reaction bar: the quick six, then a "+" that opens the full catalogue —
 * WhatsApp's shape, which is what Daniel asked for. Keeping the catalogue behind
 * the "+" means the common case stays one click and the popover stays small.
 */
export function ReactionBar({ quick, onPick }: {
  quick: readonly string[];
  onPick: (emoji: string) => void;
}) {
  const [full, setFull] = useState(false);

  if (full) return <EmojiPicker onPick={onPick} />;

  return (
    <div className="flex items-center gap-1 p-1.5">
      {quick.map((e) => (
        <button
          key={e}
          onClick={() => { rememberEmoji(e); onPick(e); }}
          data-testid={`quick-emoji-${e}`}
          className="w-8 h-8 text-[17px] rounded-lg hover:bg-white/[0.08]"
        >
          {e}
        </button>
      ))}
      <button
        onClick={() => setFull(true)}
        title="More emoji"
        data-testid="button-more-emoji"
        className="w-8 h-8 rounded-lg hover:bg-white/[0.08] text-white/45 hover:text-white/85 text-[17px] leading-none border border-white/10"
      >
        +
      </button>
    </div>
  );
}
