import { EventEmitter } from 'node:events';

export function createSlackSdk({ authenticate = async () => ({ user_id: 'U_SKY' }), postMessage = async () => ({ ts: '100.001' }) } = {}) {
  let client;
  let messageHandler;
  const sdk = {
    createReceiver() {
      client = new EventEmitter();
      return { client };
    },
    createApp({ receiver }) {
      return {
        client: { auth: { test: authenticate }, chat: { postMessage } },
        assistant() {},
        event() {},
        message(handler) { messageHandler = handler; },
        async start() { receiver.client.emit('connected'); },
        async stop() { receiver.client.emit('disconnected'); },
      };
    },
  };
  return {
    sdk,
    disconnect() { client.emit('reconnecting'); },
    reconnect() { client.emit('connected'); },
    message(message) { return messageHandler({ message }); },
  };
}
