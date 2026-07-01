import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { Mail, ArrowLeft, CheckCircle2 } from "lucide-react";

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

  return (
    <div className="min-h-screen flex items-center justify-center" style={{ background: "#02060E" }}>
      <div className="w-full max-w-sm mx-4 animate-fade-in-up" style={{ animationDelay: "0ms", opacity: 0 }}>
        <div className="text-center mb-8">
          <div className="w-14 h-14 rounded-2xl bg-white/[0.03] border border-white/10 flex items-center justify-center shadow-lg mx-auto mb-4 overflow-hidden">
            <img src="/logos/united-sports-group.png" alt="United Sports Group" className="w-10 h-10 object-contain" />
          </div>
          <h1 className="text-xl font-semibold text-white tracking-tight">Reset your password</h1>
        </div>

        {sent ? (
          <div className="rounded-2xl glass-card p-6 text-center space-y-4">
            <CheckCircle2 className="w-10 h-10 text-blue-400 mx-auto" />
            <p className="text-[13px] text-white/70 leading-relaxed">
              If <span className="text-white/90">{email}</span> has a ClubOS account, a link to set a new password is on its way. It expires in 2 hours.
            </p>
            <p className="text-[12px] text-white/40">Didn't get it? Check spam, or try again in a minute.</p>
            <a href="/admin/login" className="inline-flex items-center gap-1.5 text-[13px] text-blue-300/70 hover:text-blue-300 transition-colors">
              <ArrowLeft className="w-3.5 h-3.5" /> Back to sign in
            </a>
          </div>
        ) : (
          <div className="rounded-2xl glass-card p-6 space-y-4">
            <p className="text-[13px] text-white/55 leading-relaxed">
              Enter your email and we'll send you a secure link to choose a new password.
            </p>
            <div className="space-y-1.5">
              <label className="text-[11px] text-blue-300/25 uppercase tracking-wider font-semibold">Email</label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/20" />
                <Input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@cufc.co.nz"
                  className="pl-10 premium-input text-white/80 rounded-xl h-10"
                  data-testid="input-forgot-email"
                  onKeyDown={(e) => e.key === "Enter" && email && mutation.mutate()}
                />
              </div>
            </div>
            <Button
              onClick={() => mutation.mutate()}
              disabled={mutation.isPending || !email}
              className="w-full bg-gradient-to-r from-blue-500 to-blue-600 hover:from-blue-400 hover:to-blue-500 text-white border-0 rounded-xl h-10 text-[13px] font-medium glow-btn"
              data-testid="button-send-reset"
            >
              {mutation.isPending ? "Sending..." : "Send reset link"}
            </Button>
            <div className="text-center pt-1">
              <a href="/admin/login" className="inline-flex items-center gap-1.5 text-[13px] text-blue-300/70 hover:text-blue-300 transition-colors">
                <ArrowLeft className="w-3.5 h-3.5" /> Back to sign in
              </a>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
