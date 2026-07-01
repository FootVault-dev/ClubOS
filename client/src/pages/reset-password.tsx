import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { Lock, ArrowLeft, ShieldAlert } from "lucide-react";

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
          setState({ status: "invalid", message: data.message || "This reset link is invalid or has expired." });
        }
      } catch {
        if (!cancelled) setState({ status: "invalid", message: "This reset link is invalid or has expired." });
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
    <div className="min-h-screen flex items-center justify-center" style={{ background: "#02060E" }}>
      <div className="w-full max-w-sm mx-4 animate-fade-in-up" style={{ animationDelay: "0ms", opacity: 0 }}>
        <div className="text-center mb-8">
          <div className="w-14 h-14 rounded-2xl bg-white/[0.03] border border-white/10 flex items-center justify-center shadow-lg mx-auto mb-4 overflow-hidden">
            <img src="/logos/united-sports-group.png" alt="United Sports Group" className="w-10 h-10 object-contain" />
          </div>
          <h1 className="text-xl font-semibold text-white tracking-tight">Choose your password</h1>
        </div>

        {state.status === "checking" && (
          <div className="rounded-2xl glass-card p-6 text-center">
            <p className="text-[13px] text-white/50">Checking your link…</p>
          </div>
        )}

        {state.status === "invalid" && (
          <div className="rounded-2xl glass-card p-6 text-center space-y-4">
            <ShieldAlert className="w-10 h-10 text-amber-400 mx-auto" />
            <p className="text-[13px] text-white/70 leading-relaxed">{state.message}</p>
            <a href="/forgot-password" className="inline-block w-full">
              <Button className="w-full bg-gradient-to-r from-blue-500 to-blue-600 hover:from-blue-400 hover:to-blue-500 text-white border-0 rounded-xl h-10 text-[13px] font-medium glow-btn">
                Request a new link
              </Button>
            </a>
            <a href="/admin/login" className="inline-flex items-center gap-1.5 text-[13px] text-blue-300/70 hover:text-blue-300 transition-colors">
              <ArrowLeft className="w-3.5 h-3.5" /> Back to sign in
            </a>
          </div>
        )}

        {state.status === "valid" && (
          <div className="rounded-2xl glass-card p-6 space-y-4">
            <p className="text-[13px] text-white/55 leading-relaxed">
              Hi {state.firstName} — set a new password for <span className="text-white/80">{state.email}</span>.
            </p>
            <div className="space-y-1.5">
              <label className="text-[11px] text-blue-300/25 uppercase tracking-wider font-semibold">New password</label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/20" />
                <Input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="At least 8 characters"
                  className="pl-10 premium-input text-white/80 rounded-xl h-10"
                  data-testid="input-new-password"
                />
              </div>
              {tooShort && <p className="text-[11px] text-amber-400/80">Use at least 8 characters.</p>}
            </div>
            <div className="space-y-1.5">
              <label className="text-[11px] text-blue-300/25 uppercase tracking-wider font-semibold">Confirm password</label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/20" />
                <Input
                  type="password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  placeholder="Re-enter password"
                  className="pl-10 premium-input text-white/80 rounded-xl h-10"
                  data-testid="input-confirm-password"
                  onKeyDown={(e) => e.key === "Enter" && canSubmit && mutation.mutate()}
                />
              </div>
              {mismatch && <p className="text-[11px] text-amber-400/80">Passwords don't match.</p>}
            </div>
            <Button
              onClick={() => mutation.mutate()}
              disabled={!canSubmit}
              className="w-full bg-gradient-to-r from-blue-500 to-blue-600 hover:from-blue-400 hover:to-blue-500 text-white border-0 rounded-xl h-10 text-[13px] font-medium glow-btn"
              data-testid="button-set-password"
            >
              {mutation.isPending ? "Setting password..." : "Set password & sign in"}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
