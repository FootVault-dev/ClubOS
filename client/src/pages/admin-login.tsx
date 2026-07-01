import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { Lock, Mail } from "lucide-react";

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

  return (
    <div className="min-h-screen flex items-center justify-center" style={{ background: '#02060E' }}>
      <div className="w-full max-w-sm mx-4 animate-fade-in-up" style={{ animationDelay: '0ms', opacity: 0 }}>
        <div className="text-center mb-8">
          <div className="w-14 h-14 rounded-2xl bg-white/[0.03] border border-white/10 flex items-center justify-center shadow-lg mx-auto mb-4 overflow-hidden">
            <img src="/logos/united-sports-group.png" alt="United Sports Group" className="w-10 h-10 object-contain" />
          </div>
          <h1 className="text-xl font-semibold text-white tracking-tight" data-testid="text-login-title">United Sports Group</h1>
        </div>

        <div className="rounded-2xl glass-card p-6 space-y-4">
          <div className="space-y-1.5">
            <label className="text-[11px] text-blue-300/25 uppercase tracking-wider font-semibold">Email</label>
            <div className="relative">
              <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/20" />
              <Input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="admin@cufc.co.nz"
                className="pl-10 premium-input text-white/80 rounded-xl h-10"
                data-testid="input-email"
                onKeyDown={(e) => e.key === "Enter" && loginMutation.mutate()}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <label className="text-[11px] text-blue-300/25 uppercase tracking-wider font-semibold">Password</label>
            <div className="relative">
              <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/20" />
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                className="pl-10 premium-input text-white/80 rounded-xl h-10"
                data-testid="input-password"
                onKeyDown={(e) => e.key === "Enter" && loginMutation.mutate()}
              />
            </div>
          </div>
          <Button
            onClick={() => loginMutation.mutate()}
            disabled={loginMutation.isPending || !email || !password}
            className="w-full bg-gradient-to-r from-blue-500 to-blue-600 hover:from-blue-400 hover:to-blue-500 text-white border-0 rounded-xl h-10 text-[13px] font-medium glow-btn"
            data-testid="button-login"
          >
            {loginMutation.isPending ? "Signing in..." : "Sign In"}
          </Button>
          <div className="text-center pt-1">
            <a
              href="/forgot-password"
              className="text-[12px] text-blue-300/50 hover:text-blue-300 transition-colors"
              data-testid="link-forgot-password"
            >
              Forgot password?
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
