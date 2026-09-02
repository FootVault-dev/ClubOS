// Sign in.
//
// Rebuilt light-only (Daniel, 2026-09-02). It used to hard-code a near-black
// page (#02060E) and a blue gradient button regardless of theme — the one
// screen every staff member sees, and the one that looked least like the app
// behind it. Now: a light page, a white card, one flat button.
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Lock, Mail } from "lucide-react";
import { AuthShell } from "@/components/auth-shell";

export default function AdminLogin() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const { toast } = useToast();

  const loginMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/auth/login", { email, password });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
      window.location.href = "/admin";
    },
    onError: (e: Error) => {
      toast({ title: "Login failed", description: e.message, variant: "destructive" });
    },
  });

  const canSubmit = !!email && !!password && !loginMutation.isPending;
  const submit = () => {
    if (canSubmit) loginMutation.mutate();
  };

  return (
    <AuthShell title="United Sports Group" subtitle="Sign in to ClubOS">
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="space-y-2">
          <Label htmlFor="email">Email</Label>
          <div className="relative">
            <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
            <Input
              id="email"
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@cufc.co.nz"
              className="pl-10 h-10"
              data-testid="input-email"
            />
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="password">Password</Label>
          <div className="relative">
            <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              className="pl-10 h-10"
              data-testid="input-password"
            />
          </div>
        </div>

        <Button
          type="submit"
          disabled={!canSubmit}
          className="w-full h-10"
          data-testid="button-login"
        >
          {loginMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
          {loginMutation.isPending ? "Signing in…" : "Sign in"}
        </Button>

        <div className="text-center pt-1">
          <a
            href="/forgot-password"
            className="text-[13px] text-muted-foreground hover:text-foreground transition-colors"
            data-testid="link-forgot-password"
          >
            Forgot password?
          </a>
        </div>
      </form>
    </AuthShell>
  );
}
