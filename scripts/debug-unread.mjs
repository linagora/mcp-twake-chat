// Debug: unread computation on the 20 most recently active rooms (no message content printed).
import { loadConfig } from '../build/config.js';
import { discover } from '../build/discovery.js';
import { MatrixChat } from '../build/matrix.js';
import { CommandTokenProvider } from '../build/token.js';

console.log = console.info = console.debug = console.warn = () => {};
const out = (s) => process.stderr.write(`${s}\n`);
const config = loadConfig();
const tokens = new CommandTokenProvider(config.auth.command);
const endpoints = await discover(config.userId, {});
const chat = await MatrixChat.open({ config, endpoints, tokens, log: () => {} });
const client = chat['client'];
const me = config.userId;
const MSG = new Set(['m.room.message', 'm.room.encrypted', 'm.sticker']);
const rooms = client.getRooms().sort((a, b) => b.getLastActiveTimestamp() - a.getLastActiveTimestamp()).slice(0, 20);
for (const r of rooms) {
  const evs = r.getLiveTimeline().getEvents();
  const lastMsg = [...evs].reverse().find((e) => MSG.has(e.getWireType?.() ?? e.getType()));
  const upTo = r.getEventReadUpTo(me);
  const fully = r.getAccountData('m.fully_read')?.getContent()?.event_id;
  const rcpt = r.getReadReceiptForUserId(me);
  out(
    `${r.name.slice(0, 30).padEnd(30)} evs=${evs.length} lastMsg=${lastMsg ? (lastMsg.getSender() === me ? 'me' : 'other') : '-'} ` +
      `read(lastMsg)=${lastMsg ? r.hasUserReadEvent(me, lastMsg.getId()) : '-'} upTo=last?${upTo === lastMsg?.getId()} fully=last?${fully === lastMsg?.getId()} ` +
      `rcptType=${rcpt?.type ?? '-'} rcptAge=${rcpt ? Math.round((Date.now() - rcpt.data.ts) / 3600000) + 'h' : '-'} lastAge=${Math.round((Date.now() - r.getLastActiveTimestamp()) / 3600000)}h`,
  );
}
await chat.close();
process.exit(0);
