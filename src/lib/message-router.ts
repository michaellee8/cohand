import type { Message, MessageResponse } from './messages';

export type MessageHandler<T extends Message['type']> = (
  message: Extract<Message, { type: T }>,
  sender: chrome.runtime.MessageSender,
) => Promise<MessageResponse[T]>;

type HandlerMap = {
  [K in Message['type']]?: MessageHandler<K>;
};

export class MessageRouter {
  private handlers: HandlerMap = {};
  private gate: Promise<void> = Promise.resolve();

  on<T extends Message['type']>(type: T, handler: MessageHandler<T>): void {
    (this.handlers as any)[type] = handler;
  }

  /** Set a gate promise that must resolve before any message is handled. */
  setGate(promise: Promise<void>): void {
    this.gate = promise;
  }

  async handleMessage(
    message: Message,
    sender: chrome.runtime.MessageSender,
  ): Promise<unknown> {
    await this.gate;
    const handler = this.handlers[message.type];
    if (!handler) {
      console.warn(`[Cohand] No handler for message type: ${message.type}`);
      return { error: `Unknown message type: ${message.type}` };
    }
    try {
      return await (handler as any)(message, sender);
    } catch (err) {
      console.error(`[Cohand] Error handling ${message.type}:`, err);
      return { error: String(err) };
    }
  }

  // Register as chrome.runtime.onMessage listener
  listen(): void {
    chrome.runtime.onMessage.addListener(
      (message: Message, sender, sendResponse) => {
        this.handleMessage(message, sender).then(sendResponse);
        return true; // async response
      },
    );
  }
}
