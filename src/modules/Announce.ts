import { htmlToText } from "html-to-text";
import { MentionPill, RichReply } from "matrix-bot-sdk";
import { is } from "typia";
import { Event, MessageEvent, permalinkPattern, Received } from "../lib/matrix";
import Module from "../lib/Module";
import { expect, optional } from "../lib/utilities";
import type { Handler } from "../modules/Commands";

export interface Announcement {
  html: string;
  recipients: string[];
}

type Button = "Cancel" | "Send";

export default () =>
  class Announce extends Module {
    static syntax =
      /^(?<open><p>)?(?<recipients>.+?)\s*:(?<message>\s*(?:\s|<\/p>)\s*.*)/s;

    public async start() {
      this.patch.on("command.admin.announce", this.onCommand);
      this.patch.on("reaction", this.onReaction);
    }

    public override async stop() {
      this.patch.off("command.admin.announce", this.onCommand);
      this.patch.off("reaction", this.onReaction);
    }

    private onCommand: Handler = async ({ docs, event, input, room }): Promise<void> => {
      await this.matrix.setTyping(room, true);
      const fail = async (html: string) => {
        await this.matrix.replyHtmlNotice(room, event, html);
        await this.matrix.setTyping(room, false);
      };

      const parameters = input.html && this.#parse(input.html);
      if (!parameters) return fail(docs.commands["announce"]!);

      // Resolve recipients
      const recipients = new Set<string>();
      const add = async (id: string) => {
        const s = await this.matrix.getSpace(id).catch(() => undefined);
        if (s) for (const c of Object.keys(await s.getChildEntities())) await add(c);
        else recipients.add(id);
      };
      for (const recipient of parameters.recipients) {
        const id = await this.matrix.resolveRoom(recipient).catch(() => undefined);
        if (!id) return fail(`Unknown room “${recipient}”`);
        await add(id);
      }

      await this.#prompt(room, event, {
        html: parameters.message,
        recipients: [...recipients.values()],
      });
      await this.matrix.setTyping(room, false);
    };

    private onReaction = async (room: string, reaction: MessageEvent<"m.reaction">) => {
      const { event_id: id, key, rel_type: type } = reaction.content["m.relates_to"];

      if (type === "m.annotation" && is<Button>(key)) {
        this.debug("💬 Get message", { room, id });
        const prompt: Received<Event> = await this.matrix.getEvent(room, id);
        if (!(prompt.type === "m.room.message" && prompt.sender === this.patch.id))
          return;

        const announcement = prompt.content["org.seagl.patch"]?.announcement;
        if (announcement) {
          await this.matrix.setTyping(room, true);

          const buttons = await this.#getButtons(room, prompt);
          if (buttons.length !== 2)
            return this.warn("📢 Unexpected response", { room, id: reaction.event_id });

          await Promise.all(
            buttons.map(async (id) => {
              this.info("💬 Redact reaction", { room, id });
              await this.matrix.redactEvent(room, id);
            })
          );

          if (key === "Send") await this.#send(announcement);
          const status = key === "Send" ? "Sent" : "Cancelled";
          await this.matrix.updateReply(
            prompt,
            (text) => `${text}\n\n${status}`,
            (html) => `<blockquote>${html}</blockquote>${status}`
          );
          await this.matrix.setTyping(room, false);
        }
      }
    };

    #getButtons = async (room: string, prompt: Received<Event>): Promise<string[]> => {
      const buttons: string[] = [];
      const redacted = new Set();

      this.debug("💬 Get messages", { room });
      scan: for await (const events of this.matrix.getRoomEvents(room, "reverse", {
        types: ["m.reaction", "m.room.redaction"],
        senders: [expect(this.patch.id)],
      })) {
        for (const event of events) {
          if (event.sender !== this.patch.id) continue; // Pending famedly/conduit#6

          if (event.origin_server_ts < prompt.origin_server_ts) break scan;

          if (event.type === "m.room.redaction") redacted.add(event.redacts);
          else if (
            event.type === "m.reaction" &&
            event.content["m.relates_to"]?.event_id === prompt.event_id &&
            !redacted.has(event.event_id) &&
            is<Button>(event.content["m.relates_to"].key)
          )
            buttons.push(event.event_id);
        }
      }

      return buttons;
    };

    #parse = (body: string) => {
      const parts = body.match(Announce.syntax)?.groups;
      return (
        parts && {
          message: `${parts["open"] ?? ""}${parts["message"]!}`.replace(
            /^(?:<p><\/p>|\s)*/,
            ""
          ),
          recipients: (parts["recipients"]!.split(/\s*,\s*/) ?? []).flatMap((html) =>
            optional(html.match(permalinkPattern)?.[1])
          ),
        }
      );
    };

    #prompt = async (
      room: string,
      request: Received<MessageEvent<"m.room.message">>,
      announcement: Announcement
    ) => {
      this.info("💬 Prompt", { announcement });
      const pills = await announcement.recipients.reduce(
        async (p, r) => [...(await p), await MentionPill.forRoom(r, this.matrix)],
        Promise.resolve([] as MentionPill[])
      );
      const html = `
      <strong>To:</strong> ${pills.map((p) => p.html).join(", ")}<br>
      <strong>Message:</strong> ${announcement.html}
    `;
      const prompt = await this.matrix.sendMessage(room, {
        ...RichReply.createFor(
          room,
          request,
          htmlToText(html, { wordwrap: false }),
          html
        ),
        msgtype: "m.notice",
        "org.seagl.patch": { announcement },
      });
      await Promise.all(
        ["Send", "Cancel"].map((r) => this.matrix.react(room, prompt, r))
      );
    };

    #send = async (announcement: Announcement) => {
      this.info("📢 Announce", { announcement });

      for (const recipient of announcement.recipients) {
        try {
          this.info("💬 Send message", { room: recipient, html: announcement.html });
          await this.matrix.sendHtmlNotice(recipient, announcement.html);
        } catch (error) {
          this.error("💬 Failed to send message", { room: recipient, error });
        }
      }
    };
  };
