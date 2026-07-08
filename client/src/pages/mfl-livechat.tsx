import { LiveChatAdmin } from "./cic-livechat";

// MFL Live Chat — same manager as CIC, org-scoped to the Mini Football Leagues
// workspace (only MFL conversations appear here).
export default function MflLiveChat() {
  return (
    <LiveChatAdmin
      apiBase="/api/admin/mfl/chat"
      title="Live Chat"
      subtitle="Real-time conversations from minifootball.co.nz — the visitor is emailed when you reply if they've stepped away."
    />
  );
}
