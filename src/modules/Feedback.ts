import { Permalinks } from "matrix-bot-sdk";
import type { MessageEvent, Received, StateEvent } from "../lib/matrix";
import Module from "../lib/Module";

export default () =>
  class Feedback extends Module {
    static bad = /\bbad bot\b/i;
    static good = /\bgood bot\b/i;

    public async start() {
      this.patch.on("membership", async (room, event) => {
        if (event.state_key === this.patch.id && event.content.membership === "leave")
          this.kicked(room, event);
      });

      this.patch.on("message", async (room, event) => {
        if (Feedback.bad.test(event.content.body)) await this.bad(room, event);
        else if (Feedback.good.test(event.content.body)) await this.good(room, event);
      });
    }

    public async stop() {}

    private async bad(room: string, event: Received<MessageEvent<"m.room.message">>) {
      this.warn(
        "🤖 Negative feedback",
        { room, sender: event.sender, message: event.content.body },
        Permalinks.forEvent(room, event.event_id)
      );
    }

    private async good(room: string, event: Received<MessageEvent<"m.room.message">>) {
      this.info("🤖 Positive feedback", {
        room,
        sender: event.sender,
        message: event.content.body,
      });

      await this.matrix.react(room, event.event_id, "🤖");
    }

    private kicked(room: string, event: StateEvent<"m.room.member">) {
      this.warn("🤖 Got kicked", { room, event }, 'HEY');
    }
  };
