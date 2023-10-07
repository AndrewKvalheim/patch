import Bottleneck from "bottleneck";
import { htmlToText } from "html-to-text"; // As used by MatrixClient
import {
  getRequestFn,
  MatrixClient,
  RoomCreateOptions as RoomCreateFullOptions,
  setRequestFn,
} from "matrix-bot-sdk";
import { setTimeout } from "timers/promises";
import {
  Event,
  GetRoomMessagesRequest,
  GetRoomMessagesResponse,
  isStateEvent,
  MessageEvent,
  Received,
  RoomEventFilter,
  StateEvent,
  StateEventInput,
  Sync,
} from "./matrix";
import { env, identity } from "./utilities";
import { userAgent } from "./version";

export interface RoomCreateOptions extends RoomCreateFullOptions {
  initial_state?: StateEventInput[];
  preset?: Exclude<NonNullable<RoomCreateFullOptions["preset"]>, "trusted_private_chat">;
}

setRequestFn(getRequestFn().defaults({ headers: { "User-Agent": userAgent } }));

const directions = { forward: "f", reverse: "b" } as const;
const issue8895Cooldown = 1000 * Number(env("ISSUE_8895_COOLDOWN"));
const minTime = 1000 / Number(env("MATRIX_RATE_LIMIT"));

export default class Client extends MatrixClient {
  #cache: Map<string, Map<string, StateEvent>>;
  #completedInitialSync?: boolean;
  readonly #scheduleDefault: MatrixClient["doRequest"];
  readonly #scheduleIssue8895: MatrixClient["doRequest"];
  readonly #scheduleUnlimited: MatrixClient["doRequest"];

  public constructor(...args: ConstructorParameters<typeof MatrixClient>) {
    super(...args);

    this.#cache = new Map();

    const limiter = new Bottleneck({ maxConcurrent: 1, minTime });

    limiter.on("failed", async (error, { retryCount }) => {
      switch (error.errcode) {
        case "M_LIMIT_EXCEEDED":
          if (retryCount < 3) {
            const ms: number = error.retryAfterMs ?? 5_000;
            console.warn("Rate limited: %j", { ms });
            return ms;
          } else return undefined;

        case "M_UNKNOWN":
          if (retryCount < 5) {
            const ms: number = Math.pow(2, retryCount) * 30_000;
            console.warn("Retryable error: %j", { error, ms });
            return ms;
          } else return undefined;

        default:
          return undefined;
      }
    });

    const unlimited = super.doRequest.bind(this);

    this.#scheduleDefault = limiter.wrap(unlimited);
    this.#scheduleUnlimited = unlimited;

    // Workaround for matrix-org/synapse#8895
    this.#scheduleIssue8895 = limiter.wrap((async (...args) => {
      console.debug("Wait before non-retryable API call: %j", { ms: issue8895Cooldown });
      await setTimeout(issue8895Cooldown);
      return unlimited(...args);
    }) as MatrixClient["doRequest"]);
  }

  // Pending turt2live/matrix-bot-sdk#18
  public override doRequest: MatrixClient["doRequest"] = (...args) => {
    const [method, path] = args;

    const handler =
      method === "GET" && path === "/_matrix/client/v3/sync"
        ? this.#scheduleUnlimited
        : method === "POST" && path === "/_matrix/client/v3/createRoom"
        ? this.#scheduleIssue8895
        : this.#scheduleDefault;

    return handler(...args);
  };

  // Pending https://github.com/turt2live/matrix-bot-sdk/issues/250
  public async *getRoomEvents(
    room: string,
    direction: "forward" | "reverse",
    filter?: RoomEventFilter
  ): AsyncGenerator<Received<Event>[], void, void> {
    const path = `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/messages`;
    const base: GetRoomMessagesRequest = {
      ...(direction && { dir: directions[direction] }),
      ...(filter && { filter: JSON.stringify(filter) }),
    };

    let from: string | undefined;
    do {
      const query: GetRoomMessagesRequest = { ...base, ...(from && { from }) };
      const response: GetRoomMessagesResponse = await this.doRequest("GET", path, query);
      from = response.end;
      yield response.chunk;
    } while (from);
  }

  public override getRoomState: MatrixClient["getRoomState"] = async (
    id
  ): Promise<StateEvent[]> => [...(this.#cache.get(id)?.values() ?? [])];

  // TODO: Can this automatically choose the StateEvent variant based on the `type` argument?
  public override getRoomStateEvent = async <E extends StateEvent>(
    room: string,
    type: E["type"],
    key: E["state_key"] = ""
  ): Promise<E["content"] | undefined> =>
    (this.#cache.get(room)?.get(`${type}/${key}`) as E | undefined)?.content;

  public async react(room: string, eventId: string, reaction: string) {
    await this.sendEvent(room, "m.reaction", {
      "m.relates_to": { rel_type: "m.annotation", key: reaction, event_id: eventId },
    } as MessageEvent<"m.reaction">["content"]);
  }

  public async replaceMessage(
    room: string,
    eventId: string,
    content: MessageEvent<"m.room.message">["content"]
  ) {
    return await this.sendMessage(room, {
      ...content,
      "m.relates_to": { rel_type: "m.replace", event_id: eventId },
      "m.new_content": content,
    });
  }

  public async replaceNotice(
    room: string,
    eventId: string,
    content: Omit<MessageEvent<"m.room.message">["content"], "msgtype">
  ) {
    return await this.replaceMessage(room, eventId, { msgtype: "m.notice", ...content });
  }

  public async sendEmote(room: string, text: string) {
    await this.sendMessage(room, { msgtype: "m.emote", body: text });
  }

  public async sendHtmlEmote(room: string, html: string) {
    await this.sendMessage(room, {
      msgtype: "m.emote",
      format: "org.matrix.custom.html",
      formatted_body: html,
      body: htmlToText(html, { wordwrap: false }),
    });
  }

  public override sendStateEvent = async <E extends StateEvent>(
    room: string,
    type: E["type"],
    key: E["state_key"],
    content: E["content"]
  ) => {
    const id = await super.sendStateEvent(room, type, key, content);

    this.setCache(room, { type, state_key: key, content, event_id: id } as E);

    return id;
  };

  public override start: MatrixClient["start"] = async (...args) => {
    const result = await super.start(...args);

    return new Promise((r) => this.once("sync.initial", () => r(result)));
  };

  public async updateReply(
    { content, event_id: id, room_id: room }: Received<MessageEvent<"m.room.message">>,
    updateText: (text: string) => string,
    updateHtml: (html: string) => string = identity
  ) {
    return await this.replaceMessage(room, id, {
      msgtype: content.msgtype,
      body: updateText(content.body.replace(/^.*?\n\n/s, "")),
      ...("format" in content && {
        format: content.format,
        formatted_body: updateHtml(
          content.formatted_body.replace(/^.*<\/mx-reply>/s, "")
        ),
      }),
    });
  }

  // Modified from https://github.com/turt2live/matrix-bot-sdk/blob/v0.6.2/src/MatrixClient.ts#L736
  protected override doSync(token: string): Promise<any> {
    const query = {
      full_state: !this.#completedInitialSync,
      timeout: Math.max(0, this.syncingTimeout),
      ...(token ? { since: token } : undefined),
      ...(this["filterId"] ? { filter: this["filterId"] } : undefined),
      ...(this.syncingPresence ? { presence: this.syncingPresence } : undefined),
    };

    const timeout = token && this.#cache ? 40000 : 600000;
    return this.doRequest("GET", "/_matrix/client/v3/sync", query, null, timeout);
  }

  // Pending turt2live/matrix-bot-sdk#215
  protected override processSync: MatrixClient["processSync"] = async (
    sync: Sync,
    emit
  ) => {
    // console.log("SYNC", JSON.stringify(sync, undefined, 2));

    Object.entries(sync.rooms?.join ?? {}).forEach(([room, { state, timeline }]) => {
      state?.events?.forEach((e) => this.setCache(room, e));
      timeline?.events?.forEach((e) => isStateEvent(e) && this.setCache(room, e));
    });

    if (!this.#completedInitialSync && !sync.rooms) {
      this.#completedInitialSync = true;
      this.emit("sync.initial");
    }

    return await super.processSync(sync, emit);
  };

  private setCache(room: string, event: StateEvent) {
    const key = `${event.type}/${event.state_key}`;

    this.#cache.set(room, (this.#cache.get(room) ?? new Map()).set(key, event));
  }
}
