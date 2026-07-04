// USG Studio — dev/QA preview. Route: /studio-preview.
//
// Renders the sample MFL PageDoc fixture through the SAME pipeline the public
// page uses, so the whole block library + MFL theme can be verified without the
// server. Marked internal so the tracker never pollutes real analytics.
import { StudioDocument } from "@/pages/studio-public";
import { sampleMflPageDoc, SAMPLE_MFL_SOURCE_TAG } from "@/studio-blocks/sample-mfl";

export default function StudioPreviewPage() {
  return (
    <StudioDocument
      brandId="mfl"
      sourceTag={SAMPLE_MFL_SOURCE_TAG}
      doc={sampleMflPageDoc}
      token="preview-mfl"
      internal
    />
  );
}
