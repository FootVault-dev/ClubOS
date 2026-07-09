// Event / Camp promo — hero + a details card (dates/times/ages/price) + book CTA.
import {
  brand,
  mjmlDoc,
  header,
  eyebrow,
  heading,
  paragraph,
  detailCard,
  button,
  footer,
} from "./sections";
import type { StarterTemplate } from "./types";

function build(brandKey: string): string {
  const b = brand(brandKey);
  const sections = [
    header(b),
    eyebrow(b, "School holidays"),
    heading(b, "The July Holiday Camp is back", { size: 30 }),
    paragraph(
      b,
      `{{first_name}}, give the kids four days of football, games and new mates these holidays. All abilities welcome — from first kicks to future stars.`,
    ),
    detailCard(b, [
      ["Dates", "Mon 7 – Thu 10 July"],
      ["Times", "9:00am – 3:00pm"],
      ["Ages", "5 – 13 years"],
      ["Venue", "United Sports Centre"],
      ["Price", "$180 for the week"],
    ]),
    paragraph(
      b,
      "Includes a camp ball, daily prizes and a proper lunch. Sibling discount at checkout.",
      { muted: true, size: 14, padding: "14px 30px 0" },
    ),
    button(b, "Book a spot", "https://", { padding: "22px 30px 8px" }),
    footer(b),
  ].join("\n");

  return mjmlDoc(
    b,
    sections,
    `July Holiday Camp — 7–10 July, ages 5–13. Book your child's spot.`,
  );
}

export const eventTemplate: StarterTemplate = {
  id: "event-camp",
  name: "Event & camp",
  description: "Camp or event promo with a clean details card and a booking CTA.",
  category: "event",
  brandKeys: "all",
  build,
};
