// Choose a new password. Light-only rebuild sharing AuthShell (2026-09-02).
import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { Lock, ArrowLeft, ShieldAlert, Loader2 } from "lucide-react";
import { AuthShell } from "@/components/auth-shell";

type ValidState =
  | { status: "checking" }
  | { status: "valid"; firstName: string; email: string }
  | { status: "invalid"; message: string };

export default function ResetPassword() {
  const token =
    typeof window !== "undefined"
      ? new URLSearchParams(window.location.search).get("token") || ""
      : "";

  const [state, setState] = useState<ValidState>({ status: "checking" });
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const { toast } = useToast();

  // Validate the token up front so we can greet the user or show an
  // expired-link message instead of a dead form.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!token) {
        setState({ status: "invalid", message: "This reset link is missing its token." });
        return;
      }
      try {
        const res = await fetch(`/api/auth/reset-password/${encodeURIComponent(token)}`, {
          credentials: "include",
        });
        const data = await res.json();
        if (cancelled) return;
        if (res.ok && data.valid) {
          setState({ status: "valid", firstName: data.firstName, email: data.email });
        } else {
          setState({
            status: "invalid",
            message: data.message || "This reset link is invalid or has expired.",
          });
        }
      } catch {
        if (!cancelled)
          setState({ status: "invalid", message: "This reset link is invalid or has expired." });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const mutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/auth/reset-password", { token, password });
      return res.json();
    },
    onSuccess: () => {
      // Server logs us straight in on success — head to the app.
      queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
      toast({ title: "Password set", description: "You're signed in." });
      window.location.href = "/admin";
    },
    onError: (e: Error) =>
      toast({ title: "Couldn't set password", description: e.message, variant: "destructive" }),
  });

  const tooShort = password.length > 0 && password.length < 8;
  const mismatch = confirm.length > 0 && password !== confirm;
  const canSubmit = password.length >= 8 && password === confirm && !mutation.isPending;

  return (
    <AuthShell title="Choose your password">
      {state.status === "checking" && (
        <p className="text-[13px] text-muted-foreground text-center py-2">Checking your link…</p>
      )}

      {state.status === "invalid" && (
        <div className="text-center space-y-4">
          <ShieldAlert className="w-10 h-10 text-amber-500 mx-auto" />
          <p className="text-[13px] text-muted-foreground leading-relaxed">{state.message}</p>
          <a href="/forgot-password" className="block">
            <Button className="w-full h-10">Request a new link</Button>
          </a>
          <a
            href="/admin/login"
            className="inline-flex items-center gap-1.5 text-[13px] text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowLeft className="w-3.5 h-3.5" /> Back to sign in
          </a>
        </div>
      )}

      {state.status === "valid" && (
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (canSubmit) mutation.mutate();
          }}
        >
          <p className="text-[13px] text-muted-foreground leading-relaxed">
            Hi {state.firstName} — set a new password for{" "}
            <span className="text-foreground font-medium">{state.email}</span>.
          </p>
          <div className="space-y-2">
            <Label htmlFor="new-password">New password</Label>
            <div className="relative">
              <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
              <Input
                id="new-password"
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="At least 8 characters"
                className="pl-10 h-10"
                data-testid="input-new-password"
              />
            </div>
            {tooShort && <p className="text-[12px] text-amber-600">Use at least 8 characters.</p>}
          </div>
          <div className="space-y-2">
            <Label htmlFor="confirm-password">Confirm password</Label>
            <div className="relative">
              <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
              <Input
                id="confirm-password"
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder="Re-enter password"
                className="pl-10 h-10"
                data-testid="input-confirm-password"
              />
            </div>
            {mismatch && <p className="text-[12px] text-amber-600">Passwords don't match.</p>}
          </div>
          <Button
            type="submit"
            disabled={!canSubmit}
            className="w-full h-10"
            data-testid="button-set-password"
          >
            {mutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
            {mutation.isPending ? "Setting password…" : "Set password & sign in"}
          </Button>
        </form>
      )}
    </AuthShell>
  );
}
