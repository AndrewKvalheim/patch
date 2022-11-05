import assert from "assert/strict";
import { LogService, Permalinks, SimpleFsStorageProvider } from "matrix-bot-sdk";
import Client from "./Client.js";
import Commands from "./Commands.js";
import Concierge from "./Concierge.js";
import type { Event } from "./matrix.js";
import type { Plan } from "./Plan.js";
import Reconciler from "./Reconciler.js";

interface Config {
  accessToken: string;
  baseUrl: string;
  plan: Plan;
}

const badBot = /\bbad bot\b/i;
const goodBot = /\bgood bot\b/i;

export type Log = <D>(message: string, data?: D) => void;

export default class Patch {
  readonly #commands: Commands;
  readonly #concierge: Concierge;
  readonly #matrix: Client;
  readonly #plan: Plan;
  readonly #reconciler: Reconciler;
  public controlRoom: string | undefined;

  public trace: Log = (m, d) => LogService.trace("Patch", m, d);
  public debug: Log = (m, d) => LogService.debug("Patch", m, d);
  public error: Log = (m, d) => LogService.error("Patch", m, d);
  public info: Log = (m, d) => LogService.info("Patch", m, d);
  public warn: Log = (m, d) => LogService.warn("Patch", m, d);

  public constructor({ accessToken, baseUrl, plan }: Config) {
    const storage = new SimpleFsStorageProvider("state/state.json");

    this.#matrix = new Client(baseUrl, accessToken, storage);
    this.#plan = plan;
    this.#reconciler = new Reconciler(this, this.#matrix, this.#plan);
    this.#concierge = new Concierge(this, this.#matrix, this.#reconciler);
    this.#commands = new Commands(this, this.#matrix, this.#reconciler, this.#plan);

    this.#matrix.on("room.event", this.handleRoomEvent.bind(this));
    this.#matrix.on("room.leave", this.handleLeave.bind(this));
    this.#matrix.on("room.message", this.handleMessage.bind(this));
  }

  public async start() {
    this.info("🪪 Authenticate", { user: this.#plan.steward.id });
    assert.equal(await this.#matrix.getUserId(), this.#plan.steward.id);

    this.info("📥 Sync");
    await this.#matrix.start();
    this.debug("📥 Completed sync");

    await this.#reconciler.start();
    await this.#concierge.start();
    await this.#commands.start();
  }

  private async handleBadBot(room: string, event: Event<"m.room.message">) {
    this.warn("🤖 Bad bot", { room, sender: event.sender, message: event.content.body });

    if (this.controlRoom) {
      const pill = Permalinks.forEvent(room, event.event_id);
      await this.#matrix.sendHtmlNotice(this.controlRoom, `Negative feedback: ${pill}`);
    }
  }

  private async handleGoodBot(room: string, event: Event<"m.room.message">) {
    this.info("🤖 Good bot", { room, sender: event.sender, message: event.content.body });

    await this.#matrix.sendEvent(room, "m.reaction", {
      "m.relates_to": { rel_type: "m.annotation", key: "🤖", event_id: event.event_id },
    });
  }

  private handleLeave(roomId: string, event: Event<"m.room.member">) {
    if (event.sender === this.#plan.steward.id) return;

    this.warn("👮 Got kicked", { roomId, event });
  }

  private async handleMessage(room: string, event: Event<"m.room.message">) {
    if (event.sender === this.#plan.steward.id) return;

    if (badBot.test(event.content.body)) await this.handleBadBot(room, event);
    if (goodBot.test(event.content.body)) await this.handleGoodBot(room, event);
  }

  private async handleRoomEvent(room: string, { event_id: id, sender }: Event) {
    if (sender === this.#plan.steward.id) return;

    this.debug("🧾 Send read receipt", { room, event: id, sender: sender });
    await this.#matrix.sendReadReceipt(room, id);
  }
}
