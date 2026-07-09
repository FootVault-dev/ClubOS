// Newsletter / Roundup — hero + three story blocks + a wrap-up CTA.
import {
  brand,
  mjmlDoc,
  header,
  eyebrow,
  heading,
  paragraph,
  divider,
  button,
  footer,
  escText,
  type Brand,
} from "./sections";
import type { StarterTemplate } from "./types";

/** One story block: small accent category label, bold sub-heading, two lines, link. */
function story(b: Brand, category: string, title: string, body: string): string {
  return `    <mj-section background-color="${b.surface}" padding="4px 30px 0">
      <mj-column>
        <mj-text color="${b.accent}" font-family="${b.font}" font-size="11px" font-weight="700" letter-spacing="1.2px" text-transform="uppercase" padding="0 0 4px">${escText(
          category,
        )}</mj-text>
        <mj-text color="${b.heading}" font-family="${b.font}" font-size="20px" font-weight="800" line-height="1.3" letter-spacing="-0.3px" padding="0 0 6px">${escText(
          title,
        )}</mj-text>
        <mj-text color="${b.text}" font-family="${b.font}" font-size="15px" line-height="1.65" padding="0 0 8px">${escText(
          body,
        )}</mj-text>
        <mj-text color="${b.accent}" font-family="${b.font}" font-size="14px" font-weight="700" padding="0"><a href="https://" style="color:${b.accent};text-decoration:none;">Read more →</a></mj-text>
      </mj-column>
    </mj-section>`;
}

function build(brandKey: string): string {
  const b = brand(brandKey);
  const sections = [
    header(b),
    eyebrow(b, "The weekly roundup"),
    heading(b, "Everything happening this week", { size: 29 }),
    paragraph(
      b,
      `Hi {{first_name}}, here's your quick catch-up on ${escText(
        b.name,
      )} — the results, what's coming up, and a few things you won't want to miss.`,
    ),
    divider(b),
    story(
      b,
      "On the pitch",
      "A statement win to open the campaign",
      "Two goals in the first half and a clean sheet to back it up. The full match report, player ratings and the best photos from the day are up now.",
    ),
    divider(b),
    story(
      b,
      "Coming up",
      "Three home games in the next fortnight",
      "The busiest stretch of the season starts this weekend. Get the dates in your calendar and grab your spot before they go.",
    ),
    divider(b),
    story(
      b,
      "Off the pitch",
      "New faces in the community programme",
      "We welcomed 40 new players across our junior sessions this month. Here's how to get involved if your family hasn't yet.",
    ),
    button(b, "See the full calendar", "https://", { padding: "26px 30px 8px" }),
    footer(b),
  ].join("\n");

  return mjmlDoc(
    b,
    sections,
    `Results, fixtures and what's on at ${b.name} this week.`,
  );
}

export const newsletterTemplate: StarterTemplate = {
  id: "newsletter-roundup",
  name: "Weekly roundup",
  description: "A multi-story newsletter — results, what's coming up, and a CTA.",
  category: "newsletter",
  brandKeys: "all",
  build,
};
