// Tiny CIC branding hook for the referee pages ONLY (/login, /signup,
// /game/:id — old /ref* paths redirect here). These routes are a standalone
// mobile experience — not the ClubOS admin shell — so they get their own
// tab title + favicon: "CIC
// Referees" and the CIC black-and-white roundel. Sets it on mount and leaves
// it; nothing restores app.usg.co.nz's branding because a referee never
// navigates from these pages into the admin app in the same tab.
import { useEffect } from "react";

const CIC_TITLE = "CIC Referees";
const CIC_FAVICON = "/cic/favicon.png";

export function useCicBrand() {
  useEffect(() => {
    document.title = CIC_TITLE;

    let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!link) {
      link = document.createElement("link");
      link.rel = "icon";
      document.head.appendChild(link);
    }
    link.type = "image/png";
    link.href = CIC_FAVICON;
  }, []);
}
