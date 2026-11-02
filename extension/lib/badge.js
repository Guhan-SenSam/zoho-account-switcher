// Toolbar badge: shows who is signed in (initials on the account colour),
// "+" while an account is being added, nothing otherwise.

export const PENDING_COLOR = '#6b7280';
export const DEFAULT_TITLE = 'Zoho Account Switcher';
const TEXT_COLOR = '#ffffff';

function fallbackInitials(name) {
  const words = String(name ?? '').trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return (words[0] ?? '').slice(0, 2).toUpperCase();
}

export function createBadge(action = globalThis.chrome?.action) {
  return {
    async show({ active = null, pending = false } = {}) {
      let text = '';
      let color = PENDING_COLOR;
      let title = DEFAULT_TITLE;
      if (pending) {
        text = '+';
        title = 'Zoho: adding an account…';
      } else if (active) {
        text = active.initials || fallbackInitials(active.name);
        color = active.color || PENDING_COLOR;
        title = `Zoho: ${active.name}`;
      }
      const calls = [
        action.setBadgeText({ text }),
        action.setBadgeBackgroundColor({ color }),
        action.setTitle({ title }),
      ];
      if (typeof action.setBadgeTextColor === 'function') {
        calls.push(action.setBadgeTextColor({ color: TEXT_COLOR }));
      }
      await Promise.all(calls);
    },
  };
}
