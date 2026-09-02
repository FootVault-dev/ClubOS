// The parent lands here when they back out of a camp checkout.
//
// It painted a full-page near-black (#02060E) while the rest of that flow —
// /{slug}/book, /checkout, /success — is light, so a parent who abandoned a
// booking dropped into a black screen mid-journey. The old theme code even
// forced this route light, which left the hardcoded dark background with
// light-mapped text on top of it. Rebuilt light, to match the flow it is in.
import { Link, useRoute } from "wouter";
import { Button } from "@/components/ui/button";
import { XCircle } from "lucide-react";

export default function BookingCancel() {
  const [, params] = useRoute("/:slug/cancel");
  const slug = params?.slug || "";

  return (
    <div className="min-h-screen bg-muted/40 flex items-center justify-center px-4 py-10">
      <div className="max-w-md w-full text-center">
        <div className="w-16 h-16 rounded-full bg-destructive/10 flex items-center justify-center mx-auto mb-5">
          <XCircle className="w-8 h-8 text-destructive" />
        </div>
        <h1
          className="text-2xl font-semibold tracking-tight text-foreground mb-2"
          data-testid="text-cancel-title"
        >
          Booking cancelled
        </h1>
        <p className="text-sm text-muted-foreground mb-6">
          Your booking wasn't completed, and you haven't been charged.
        </p>
        <div className="flex flex-wrap gap-3 justify-center">
          <Link href={`/${slug}/book`}>
            <Button className="h-10" data-testid="button-try-again">
              Try again
            </Button>
          </Link>
          <Link href="/">
            <Button variant="outline" className="h-10" data-testid="button-back-home">
              Back to camps
            </Button>
          </Link>
        </div>
      </div>
    </div>
  );
}
