// Product / Merch launch — product hero + a 2-up product grid + shop CTA.
import {
  brand,
  mjmlDoc,
  header,
  eyebrow,
  heading,
  paragraph,
  button,
  footer,
  escText,
  type Brand,
} from "./sections";
import type { StarterTemplate } from "./types";

/** One product card: a colour-blocked "photo" band (product name on it) + price.
 *  Swap the band for an <mj-image> of the real product photo in the builder. */
function productColumn(b: Brand, name: string, price: string): string {
  return `        <mj-column background-color="${b.bg}" border="1px solid ${b.border}" border-radius="12px" padding="0">
          <mj-text container-background-color="${b.accent}" color="${b.onAccent}" font-family="${b.font}" font-size="15px" font-weight="700" line-height="1.3" align="center" padding="34px 14px">${escText(
            name,
          )}</mj-text>
          <mj-text color="${b.accent}" font-family="${b.font}" font-size="16px" font-weight="800" align="center" padding="14px 0 16px">${escText(
            price,
          )}</mj-text>
        </mj-column>`;
}

function productRow(b: Brand, left: [string, string], right: [string, string]): string {
  return `    <mj-section background-color="${b.surface}" padding="12px 22px 0">
${productColumn(b, left[0], left[1])}
${productColumn(b, right[0], right[1])}
    </mj-section>`;
}

function build(brandKey: string): string {
  const b = brand(brandKey);
  const sections = [
    header(b),
    eyebrow(b, "New in the shop"),
    heading(b, "The 25/26 collection has landed", { size: 29 }),
    paragraph(
      b,
      `{{first_name}}, the new range is live — kit, training wear and the bits that sell out first. Wear your colours with pride.`,
    ),
    productRow(b, ["Home Kit 25/26", "$89.99"], ["Training Jacket", "$74.99"]),
    productRow(b, ["Club Cap", "$29.99"], ["Kit Bag", "$54.99"]),
    button(b, "Shop the collection", "https://", { align: "center", padding: "26px 30px 8px" }),
    paragraph(
      b,
      "Free pickup at the club shop · Fast NZ-wide delivery.",
      { align: "center", muted: true, size: 13, padding: "4px 30px 0" },
    ),
    footer(b),
  ].join("\n");

  return mjmlDoc(b, sections, `The new ${b.name} 25/26 collection is here — shop it now.`);
}

export const productTemplate: StarterTemplate = {
  id: "product-launch",
  name: "Merch launch",
  description: "Product hero with a 2-up grid and a shop-the-collection CTA.",
  category: "product",
  brandKeys: ["cufc", "siu", "mfl", "cic", "usg", "prints"],
  build,
};
