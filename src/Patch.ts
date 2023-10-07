import {
  LogService as LS,
  MemoryStorageProvider,
  SimpleFsStorageProvider,
} from "matrix-bot-sdk";
import Client from "./lib/Client";
import type { Event, Received } from "./lib/matrix";
import type Module from "./lib/Module";
import { escapeHtml, expect } from "./lib/utilities";
import { version } from "./lib/version";
import EventEmitter from "events";

interface Config {
  accessToken: string;
  baseUrl: string;
  modules: (new (...args: ConstructorParameters<typeof Module>) => Module)[];
  statePath?: string;
}

type Log = <D>(message: string, data?: D, notice?: string) => void;

export default class Patch extends EventEmitter {
  public controlRoom: string | undefined;
  public id: string | undefined;

  readonly #matrix: Client;
  #modules: Module[];

  public constructor({ accessToken, baseUrl, modules, statePath }: Config) {
    super();

    const storage = statePath
      ? new SimpleFsStorageProvider(statePath)
      : new MemoryStorageProvider();

    this.#matrix = new Client(baseUrl, accessToken, storage);
    this.#modules = modules.map((M) => new M(this, this.#matrix));
  }

  trace: Log = (m, d) => LS.trace("Patch", m, d);
  debug: Log = (m, d) => LS.debug("Patch", m, d);
  info: Log = (m, d) => LS.info("Patch", m, d);
  warn: Log = (m, d, n) => (LS.warn("Patch", m, d), this.#alert("Warning")(m, d, n));
  error: Log = (m, d, n) => (LS.error("Patch", m, d), this.#alert("Error")(m, d, n));

  public async start() {
    this.info("▶️ Start", { version });

    this.id = await this.#matrix.getUserId();
    this.info("🪪 Authenticated", { user: this.id });

    this.#matrix.on("room.event", this.#dispatch);

    this.info("📥 Sync");
    await this.#matrix.start();
    this.debug("📥 Completed sync");

    await Promise.all(this.#modules.map((m) => m.start()));
  }

  public async stop() {
    await Promise.all([this.#matrix.stop(), ...this.#modules.map((m) => m.stop())]);
  }

  public isControlRoom(room: string): boolean {
    return !!this.controlRoom && room === this.controlRoom;
  }

  #alert =
    (level: string) =>
    <D>(message: string, data?: D, notice?: string) =>
      this.controlRoom &&
      this.#matrix.sendHtmlNotice(
        this.controlRoom,
        `<p><strong>${level}:</strong> ${escapeHtml(message)}</p>${
          notice ??
          (data
            ? `<pre><code>${escapeHtml(JSON.stringify(data, undefined, 2))}</code></pre>`
            : "")
        }`
      );

  #dispatch = (room: string, event: Received<Event>) => {
    if (event.sender === expect(this.id)) return;

    if (event.type === "m.reaction") this.emit("reaction", room, event);
    else if (event.type === "m.room.member") this.emit("membership", room, event);
    else if (event.type === "m.room.message") this.emit("message", room, event);

    this.emit("readable", room, event);
  };
}
