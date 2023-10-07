import { MentionPill } from "matrix-bot-sdk";
import { setTimeout } from "timers/promises";
import { assertEquals } from "typia";
import { isUserId, permalinkPattern } from "../lib/matrix";
import Module from "../lib/Module";
import { expect, importYaml, sample } from "../lib/utilities";
import type { Handler } from "../modules/Commands";

const toasts = assertEquals<string[]>(importYaml("data/toasts.yml"));

export default () =>
  class Tea extends Module {
    public async start() {
      this.patch.on("command.public.tea", this.tea);
    }

    public async stop() {
      this.patch.off("command.public.tea", this.tea);
    }

    // Adapted from https://github.com/treedavies/seagl-bot-2021/tree/58a07cb/plugins/tea
    private tea: Handler = async ({ event, input, room }) => {
      await this.matrix.setTyping(room, true);
      const minDelay = setTimeout(1000);

      let recipient;
      if (input.html) {
        recipient = input.html?.match(permalinkPattern)?.[1];
      } else if (input.text) {
        const first = input.text.split(/\s+/, 1)[0];
        if (first && isUserId(first)) recipient = first;
      }

      if (recipient === event.sender) {
        const sender = await MentionPill.forUser(event.sender, room, this.matrix);

        await this.matrix.sendHtmlEmote(room, `steals a fry from ${sender.html}`);
      } else {
        const toast = expect(sample(toasts), "toast");

        let html;
        if (recipient && recipient !== this.patch.id) {
          const to = await MentionPill.forUser(recipient, room, this.matrix);
          const from = await MentionPill.forUser(event.sender, room, this.matrix);
          html = `${to.html}: ${from.html} is toasting you! ${toast}`;
        } else {
          html = toast;
        }

        await minDelay;
        const reply = await this.matrix.replyHtmlNotice(room, event, html);
        if (recipient === this.patch.id) await this.matrix.react(room, reply, "🍵");
      }

      await this.matrix.setTyping(room, false);
    };
  };
