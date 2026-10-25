// A device-scoped lease, written with server time; stale presence never mutes indefinitely.
export const CHAT_VISIBILITY_TTL = 12000;
export function chatPushMuted(subscription, conversationId, now = Date.now()) {
  const lease = subscription?.waseet_chat_visibility;
  return Boolean(conversationId && lease?.conversation_id === conversationId &&
    Number.isFinite(lease.expires_at) && lease.expires_at > now && lease.expires_at <= now + CHAT_VISIBILITY_TTL);
}
