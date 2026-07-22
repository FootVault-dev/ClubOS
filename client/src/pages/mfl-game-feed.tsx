// ─────────────────────────────────────────────────────────────────────────────
// MFL GAME FEED — page wrapper for the "Game Feed" tab, /admin/mfl-game-feed
// (Mini Football Leagues workspace). The feed itself lives in
// client/src/components/mfl-game-feed.tsx (cloned from cic-game-feed.tsx) —
// this page just gives it the standard admin page chrome (title + intro),
// same pattern as how CIC's game feed is embedded as a tab elsewhere. Kept
// as its own route/tab (rather than embedded in another page) per the
// leagueTabs entry in shared/tabs.ts.
// ─────────────────────────────────────────────────────────────────────────────
import { Radio } from "lucide-react";
import { MflGameFeed as MflGameFeedBoard } from "@/components/mfl-game-feed";

export default function MflGameFeedPage() {
  return (
    <div className="p-4 md:p-6 max-w-7xl mx-auto text-white/90">
      <div className="mb-5">
        <h1 className="text-xl font-semibold flex items-center gap-2">
          <Radio className="w-5 h-5 text-blue-400" /> Game Feed
        </h1>
        <p className="text-[13px] text-white/40 mt-1 max-w-xl">
          Every Mini Football Leagues game, live — scores, referee assignments and status roll in from
          referees' phones as they score each league night.
        </p>
      </div>
      <MflGameFeedBoard />
    </div>
  );
}
