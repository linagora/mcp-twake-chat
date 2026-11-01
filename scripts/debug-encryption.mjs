// Debug: compare the SDK's view of room encryption with the server state.
import { loadConfig } from '../build/config.js';
import { discover } from '../build/discovery.js';
import { MatrixChat } from '../build/matrix.js';
import { CommandTokenProvider } from '../build/token.js';
import { TomClient } from '../build/tom.js';

console.log = console.info = console.debug = () => {};
const config = loadConfig();
const tokens = new CommandTokenProvider(config.auth.command);
const endpoints = await discover(config.userId, {});
const chat = await MatrixChat.open({ config, endpoints, tokens, tom: new TomClient(endpoints.tomUrl, tokens), log: () => {} });
const rooms = chat.rooms();
const client = chat['client'];
const all = client.getRooms();
const byMembership = {};
for (const r of all) byMembership[r.getMyMembership()] = (byMembership[r.getMyMembership()] ?? 0) + 1;
process.stderr.write(`getRooms ${all.length} ${JSON.stringify(byMembership)}; joined views ${rooms.length}, encrypted ${rooms.filter((r) => r.encrypted).length}\n`);
const token = await tokens.getToken();
let serverEnc = 0;
let mismatch = 0;
for (const r of rooms) {
  const res = await fetch(`${endpoints.homeserverUrl}/_matrix/client/v3/rooms/${encodeURIComponent(r.id)}/state/m.room.encryption/`, { headers: { authorization: `Bearer ${token}` } });
  const enc = res.ok;
  if (enc) serverEnc++;
  if (enc !== r.encrypted) mismatch++;
}
process.stderr.write(`server says encrypted: ${serverEnc}; mismatches: ${mismatch}\n`);
await chat.close();
process.exit(0);
