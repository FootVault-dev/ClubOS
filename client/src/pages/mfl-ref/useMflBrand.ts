// Tiny MFL branding hook for the referee pages ONLY (/mfl-ref, /mfl-ref/signup,
// /mfl-ref/game/:id). Twin of client/src/pages/ref/useCicBrand.ts. These
// routes are a standalone mobile experience — not the ClubOS admin shell —
// so they get their own tab title + favicon: "MFL Referees" and the Mini
// Football Leagues logo. Sets it on mount and leaves it; nothing restores
// app.usg.co.nz's branding because a referee never navigates from these
// pages into the admin app in the same tab.
import { useEffect } from "react";

const MFL_TITLE = "MFL Referees";
const MFL_FAVICON = "/logos/mini-football-leagues.png";

export function useMflBrand() {
  useEffect(() => {
    document.title = MFL_TITLE;

    let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!link) {
      link = document.createElement("link");
      link.rel = "icon";
      document.head.appendChild(link);
    }
    link.type = "image/png";
    link.href = MFL_FAVICON;
  }, []);
}
