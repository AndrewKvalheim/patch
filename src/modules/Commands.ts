import Bottleneck from "bottleneck";
import { assertEquals } from "typia";
import type { MessageEvent, Received } from "../lib/matrix";
import Module from "../lib/Module";
import { importYaml } from "../lib/utilities";

// Load markdown docs
const docs = assertEquals<Docs>(importYaml("data/help.yml"));

interface Context {
  docs: Docs;
  event: Received<MessageEvent<"m.room.message">>;
  input: Input;
  room: string;
}

interface Docs {
  brief: string;
  commands: Record<string, string>;
  controlBrief: string;
}

export type Handler = (context: Context) => Promise<void>;

interface Input {
  command: string;
  html: string | undefined;
  text: string | undefined;
}

export default () =>
  class Commands extends Module {
    static htmlSyntax = /^(?<open><p>)?!(?<command>[a-z]+)(?:\s+(?<input>.*?))?\s*$/s;
    static textSyntax = /^!(?<command>[a-z]+)(?:\s+(?<input>.*?))?\s*$/s;

    #limiter = new Bottleneck.Group({ maxConcurrent: 1, minTime: 1000 });

    public async start() {
      this.patch.on("message", this.#detect);
    }

    public async stop() {
      this.patch.off("message", this.#detect);
    }

    #detect = async (room: string, event: Received<MessageEvent<"m.room.message">>) => {
      if (event.content.msgtype !== "m.text") return;
      if (event.content["m.relates_to"]?.rel_type === "m.replace") return;
      if (!event.content.body.startsWith("!")) return;

      const input = this.#parse(event.content);
      if (!input) return;
      this.debug("🛎️ Command", { room, sender: event.sender, input });

      const context: Context = { docs, event, input, room };
      const group = this.patch.isControlRoom(room) ? "admin" : "public";

      this.#limiter.key(room).schedule(async () => {
        this.patch.emit(`command.${group}.${input.command}`, context);
      });
    };

    #parse(content: MessageEvent<"m.room.message">["content"]): Input | undefined {
      const text = content.body.match(Commands.textSyntax)?.groups;
      const html =
        "format" in content && content.format === "org.matrix.custom.html"
          ? content.formatted_body.match(Commands.htmlSyntax)?.groups
          : undefined;

      const command = text?.["command"] ?? html?.["command"];
      if (!command) return;

      if (text?.["command"] && html?.["command"] && text["command"] !== html["command"])
        return void this.error("🛎️ Conflicting text and HTML commands", { content });

      return {
        command,
        html: html?.["input"] && `${html?.["open"] ?? ""}${html?.["input"]}`,
        text: text?.["input"],
      };
    }
  };
