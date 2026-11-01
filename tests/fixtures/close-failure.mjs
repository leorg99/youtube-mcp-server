import { Server } from '@modelcontextprotocol/sdk/server/index.js';

Server.prototype.close = async function () {
  throw new Error('Injected SDK cleanup rejection');
};
