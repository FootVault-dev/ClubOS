// Match day / Fixture announcement — bold hero band + fixture details + tickets CTA.
import {
  brand,
  mjmlDoc,
  header,
  heading,
  paragraph,
  detailCard,
  button,
  footer,
  escText,
} from "./sections";
import type { StarterTemplate } from "./types";

function build(brandKey: string): string {
  const b = brand(brandKey);

  // Bold hero band on the ACCENT colour — the "match day" moment.
  const hero = `    <mj-section background-color="${b.accent}" padding="34px 30px 30px">
      <mj-column>
        <mj-text color="${b.onAccent}" font-family="${b.font}" font-size="13px" font-weight="700" letter-spacing="2px" text-transform="uppercase" align="center" padding="0 0 8px">Match Day</mj-text>
        <mj-text color="${b.onAccent}" font-family="${b.font}" font-size="34px" font-weight="800" line-height="1.1" letter-spacing="-0.8px" align="center" padding="0">${escText(
          b.name,
        )}</mj-text>
        <mj-text color="${b.onAccent}" font-family="${b.font}" font-size="18px" font-weight="700" line-height="1.3" align="center" padding="6px 0 0">vs Nelson Suburbs FC</mj-text>
      </mj-column>
    </mj-section>`;

  const sections = [
    header(b, "center"),
    hero,
    heading(b, "This one's at home. Be there.", {
      size: 24,
      align: "center",
      padding: "26px 30px 0",
    }),
    paragraph(
      b,
      "{{first_name}}, we need the ground loud on Saturday. Bring the family, get there early, and roar the team on for the full ninety.",
      { align: "center" },
    ),
    detailCard(b, [
      ["Date", "Saturday 12 July"],
      ["Kick-off", "2:30pm"],
      ["Venue", "United Sports Centre"],
      ["Gates open", "1:00pm"],
    ]),
    button(b, "Get your tickets", "https://", {
      align: "center",
      padding: "24px 30px 8px",
    }),
    paragraph(
      b,
      "Kids under 12 go free with a paying adult.",
      { align: "center", muted: true, size: 13, padding: "6px 30px 0" },
    ),
    footer(b),
  ].join("\n");

  return mjmlDoc(b, sections, `Home game Saturday 2:30pm — get your tickets for ${b.name}.`);
}

export const matchdayTemplate: StarterTemplate = {
  id: "matchday-fixture",
  name: "Match day",
  description: "Bold fixture hero with date, venue and a tickets CTA.",
  category: "matchday",
  brandKeys: ["cufc", "siu", "cic", "cic7s", "mfl", "usc", "usg"],
  build,
};
