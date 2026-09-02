// Forgot password. Light-only rebuild, sharing AuthShell with sign-in and
// reset so the three signed-out screens cannot drift apart (2026-09-02).
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { Mail, ArrowLeft, CheckCircle2, Loader2 } from "lucide-react";
import { AuthShell } from "@/components/auth-shell";

export default function ForgotPassword() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const { toast } = useToast();

  const mutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/auth/forgot-password", { email });
      return res.json();
    },
    // The endpoint always returns the same generic success (no account
    // enumeration), so a successful response just flips us to the confirmation.
    onSuccess: () => setSent(true),
    onError: (e: Error) =>
      toast({ title: "Something went wrong", description: e.message, variant: "destructive" }),
  });

  const backLink = (
    <a
      href="/admin/login"
      className="inline-flex items-center gap-1.5 text-[13px] text-muted-foreground hover:text-foreground transition-colors"
      data-testid="link-back-to-signin"
    >
      <ArrowLeft className="w-3.5 h-3.5" /> Back to sign in
    </a>
  );

  return (
    <AuthShell title="Reset your password">
      {sent ? (
        <div className="text-center space-y-4">
          <CheckCircle2 className="w-10 h-10 text-primary mx-auto" />
          <p className="text-[13px] text-muted-foreground leading-relaxed">
            If <span className="text-foreground font-medium">{email}</span> has a ClubOS
            account, a link to set a new password is on its way. It expires in 2 hours.
          </p>
          <p className="text-[12px] text-muted-foreground">
            Didn't get it? Check spam, or try again in a minute.
          </p>
          {backLink}
        </div>
      ) : (
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (email && !mutation.isPending) mutation.mutate();
          }}
        >
          <p className="text-[13px] text-muted-foreground leading-relaxed">
            Enter your email and we'll send you a secure link to choose a new password.
          </p>
          <div className="space-y-2">
            <Label htmlFor="forgot-email">Email</Label>
            <div className="relative">
              <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
              <Input
                id="forgot-email"
                type="email"
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@cufc.co.nz"
                className="pl-10 h-10"
                data-testid="input-forgot-email"
              />
            </div>
          </div>
          <Button
            type="submit"
            disabled={mutation.isPending || !email}
            className="w-full h-10"
            data-testid="button-send-reset"
          >
            {mutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
            {mutation.isPending ? "Sending…" : "Send reset link"}
          </Button>
          <div className="text-center pt-1">{backLink}</div>
        </form>
      )}
    </AuthShell>
  );
}
